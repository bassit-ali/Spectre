/**
 * SPECTRE full functional regression — HTTP UI + WebSocket API + live motors.
 * Usage: node scripts/regression-full.mjs
 */
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE = process.env.SPECTRE_URL || 'http://127.0.0.1:9000';
const WS_URL = process.env.SPECTRE_WS || 'ws://127.0.0.1:9000/ws';
const BAND = Number(process.env.LAND_BAND || 1.15);
// Product home settle is ±1.5° (relaxed storage band).
const HOME_BAND = Number(process.env.HOME_BAND || 1.5);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pass(name, detail = '') {
  results.push({ ok: true, name, detail });
  console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name, detail = '') {
  results.push({ ok: false, name, detail });
  console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
}
function assert(name, cond, detail = '') {
  if (cond) pass(name, detail);
  else fail(name, detail);
}

async function httpGet(urlPath) {
  const res = await fetch(`${BASE}${urlPath}`, { cache: 'no-store' });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

function signedPan(p) {
  let d = ((((p + 180) % 360) + 360) % 360) - 180;
  if (d <= -180) return 180;
  return d;
}
function panDelta(got, want) {
  if (got == null || want == null) return null;
  let e = signedPan(got) - signedPan(want);
  if (e > 180) e -= 360;
  if (e < -180) e += 360;
  return e;
}

async function withWs(fn) {
  const ws = new WebSocket(WS_URL);
  let id = 1;
  const pending = new Map();
  let pose = {};
  let mode = 'idle';
  let lastError = null;
  const events = [];

  const send = (type, payload = {}, timeoutMs = 20000) =>
    new Promise((resolve, reject) => {
      const reqId = String(id++);
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error(`timeout ${type}`));
      }, timeoutMs);
      pending.set(reqId, { resolve, reject, timer });
      ws.send(JSON.stringify({ type, payload, id: reqId }));
    });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    events.push(msg.type);
    if (msg.type === 'ack' && msg.payload?.id != null) {
      const slot = pending.get(String(msg.payload.id));
      if (!slot) return;
      clearTimeout(slot.timer);
      pending.delete(String(msg.payload.id));
      if (msg.payload.ok) slot.resolve(msg.payload.data);
      else slot.reject(new Error(msg.payload.error || `${msg.payload.reqType} failed`));
      return;
    }
    if (msg.type === 'pose' && msg.payload) pose = { ...pose, ...msg.payload };
    if (msg.type === 'state' && msg.payload?.mode) mode = msg.payload.mode;
    if (msg.type === 'error') lastError = msg.payload;
  });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const waitIdle = async (timeoutMs = 60000) => {
    const start = Date.now();
    let sawBusy = false;
    let idleSince = null;
    while (Date.now() - start < timeoutMs) {
      let live = mode;
      try {
        const h = await send('system.health');
        if (h?.motionMode) live = h.motionMode;
      } catch {
        /* ignore */
      }
      if (live !== 'idle' && live !== 'error') {
        sawBusy = true;
        idleSince = null;
      } else if (sawBusy) {
        if (!idleSince) idleSince = Date.now();
        if (Date.now() - idleSince >= 700) return live;
      } else if (Date.now() - start > 1500 && live === 'idle') {
        // command may have finished before we observed busy
        return live;
      }
      await sleep(200);
    }
    throw new Error('waitIdle timeout');
  };

  const refresh = async () => {
    pose = (await send('motion.refresh')) || pose;
    await sleep(150);
    pose = (await send('motion.pose')) || pose;
    return pose;
  };

  try {
    return await fn({ send, waitIdle, refresh, getPose: () => pose, getMode: () => mode, getError: () => lastError, events });
  } finally {
    try {
      await send('motion.stop');
    } catch {
      /* ignore */
    }
    ws.close();
  }
}

async function sectionHttp() {
  console.log('\n=== HTTP / STATIC UI ===');
  const health = await httpGet('/health');
  assert('GET /health 200', health.status === 200);
  let h;
  try {
    h = JSON.parse(health.text);
  } catch {
    h = null;
  }
  assert('health.status ok', h?.status === 'ok', JSON.stringify(h?.status));
  assert('serial connected', !!h?.serial?.connected, h?.serial?.path);
  assert('encoders healthy', !!h?.encoderHealthy, h?.encoderReason);
  assert('watchdog alive', !!h?.watchdog?.alive);
  assert('BIT boot ok', !!h?.bit?.ok);

  for (const p of ['/', '/index.html', '/widget.html']) {
    const r = await httpGet(p);
    assert(`GET ${p}`, r.status === 200 && r.text.includes('SPECTRE'), `status=${r.status} len=${r.text.length}`);
  }

  const index = await httpGet('/');
  const consoleIds = [
    'app-header',
    'header-halt-btn',
    'header-open-widget-btn',
    'home-btn',
    'halt-btn',
    'goto-btn',
    'tilt-slider',
    'sphere-hit',
    'jog-up',
    'jog-down',
    'jog-left',
    'jog-right',
    'sec-gimbal',
    'sec-presets',
    'sec-drive',
    'sec-serial',
    'sec-widget',
    'sec-unit',
    'preset-1-call',
    'preset-1-set',
    'preset-1-clear',
    'ribbon',
  ];
  for (const id of consoleIds) {
    assert(`console DOM #${id}`, index.text.includes(`id="${id}"`));
  }
  assert('console no fine pan slider', !index.text.includes('id="pan-slider"'));
  assert('console no ribbon-credit', !index.text.includes('ribbon-credit'));
  assert('console storage/home label', /storage|LEVEL/i.test(index.text));
  assert('console tilt convention UP/DOWN', /\bUP\b/i.test(index.text) && /\bDOWN\b/i.test(index.text));
  assert('console no BACK/FWD labels', !/\bBACK\b/i.test(index.text) && !/\bFWD\b/i.test(index.text) && !/\bFORWARD\b/i.test(index.text));
  assert('console landing res 0.5/1/2', index.text.includes('land-res-05') && index.text.includes('land-res-1') && index.text.includes('land-res-2'));
  assert('console home hard 1.5', /1\.5°/.test(index.text));
  assert(
    'console vertical tilt + no under sector banner',
    index.text.includes('tilt-slider-v') && !index.text.includes('sphere-sector-legend'),
  );
  assert('console sector angles 0/120/240', /A@0°/.test(index.text) && /B@120°/.test(index.text) && /C@240°/.test(index.text));
  assert('console sector badge host', index.text.includes('sphere-pan-badges'));

  const widget = await httpGet('/widget.html');
  const widgetIds = [
    'spectre-widget',
    'widget-home-btn',
    'widget-halt-btn',
    'widget-goto-btn',
    'widget-jog-up',
    'widget-jog-down',
    'dome-hit',
    'w-preset-1',
    'w-land-res-05',
    'w-land-res-1',
    'w-land-res-2',
  ];
  for (const id of widgetIds) {
    assert(`widget DOM #${id}`, widget.text.includes(`id="${id}"`));
  }
  assert('widget home hard 1.5', /1\.5°/.test(widget.text));
  assert(
    'widget vertical tilt + no under sector banner',
    widget.text.includes('tilt-slider-v') &&
      widget.text.includes('widget-tilt-slider') &&
      !widget.text.includes('dome-sector-legend'),
  );
  assert('widget sector badge host', widget.text.includes('dome-pan-badges'));
  assert('widget overflow-visible badges', /overflow-visible/.test(widget.text));
  assert('widget no fine pan bars', !widget.text.includes('id="widget-pan-minus"') && !widget.text.includes('id="widget-pan-plus"'));
  assert('widget pin in header', widget.text.includes('id="widget-pin-btn"'));
  assert('widget tilt ±50', /±50°/.test(widget.text) && /min="-50"/.test(widget.text) && /max="50"/.test(widget.text));
  assert('widget no credit footer', !/26 SIG|R&D WING/i.test(widget.text));
  assert('widget opacity chrome', widget.text.includes('id="widget-opacity-slider"') && widget.text.includes('id="widget-opacity-btn"'));
  assert('widget offline banner present', widget.text.includes('id="widget-offline-banner"') && /No device connected/i.test(widget.text));
  assert('widget open-console action', widget.text.includes('data-action="open-console"'));

  // Built assets referenced by dist index
  const distIndex = path.join(ROOT, 'web', 'dist', 'index.html');
  if (fs.existsSync(distIndex)) {
    const html = fs.readFileSync(distIndex, 'utf8');
    const assets = [...html.matchAll(/\/assets\/[^"']+/g)].map((m) => m[0]);
    assert('dist references assets', assets.length >= 2, `${assets.length} refs`);
    for (const a of [...new Set(assets)].slice(0, 8)) {
      const r = await httpGet(a);
      assert(`asset ${a}`, r.status === 200, `status=${r.status}`);
    }
  } else {
    fail('dist/index.html exists', distIndex);
  }
}

async function sectionWsApi() {
  console.log('\n=== WEBSOCKET API ===');
  await withWs(async ({ send, events }) => {
    const pong = await send('ping', { t: 123 });
    assert('ping/hello', pong?.ts != null);

    const health = await send('system.health');
    assert('system.health', health?.status === 'ok' && health?.serial?.connected);

    const settings = await send('settings.get');
    assert('settings.get', settings != null && (settings.approach || settings.limits || settings.motion));
    const limits = settings.limits || settings.motion?.limits;
    assert('tilt limits ±50', limits?.tiltMin === -50 && limits?.tiltMax === 50, JSON.stringify(limits));

    const ports = await send('serial.list');
    // Prefer SPECTRE_DEVICE (COM / udp://…). Do not use SPECTRE_PORT — that is the HTTP listen port.
    const wantPort = process.env.SPECTRE_DEVICE || '';
    const hasListed =
      Array.isArray(ports) &&
      ports.length > 0 &&
      (wantPort
        ? ports.some((p) => String(p.path || '').toLowerCase() === wantPort.toLowerCase())
        : ports.some((p) => /COM\d+|ttyUSB|ttyACM|udp:\/\//i.test(p.path || '')));
    assert('serial.list', hasListed, wantPort ? `want ${wantPort}` : `${ports?.length ?? 0} port(s)`);

    const st = await send('serial.status');
    assert('serial.status connected', !!st?.connected, st?.path);

    const pose = await send('motion.refresh');
    assert('motion.refresh pose', pose?.pan != null && pose?.tilt != null, `pan=${pose?.pan} tilt=${pose?.tilt}`);

    const presets = await send('preset.list');
    assert('preset.list 9 slots', Array.isArray(presets) && presets.length === 9);

    // settings round-trip — landing resolution snaps to 0.5 / 1 / 2
    const before = await send('settings.get');
    const approach = before.approach || before.motion?.approach || {};
    const patched = await send('settings.update', {
      patch: { approach: { ...approach, deadband: 2 } },
    });
    assert('settings.update', patched != null);
    const afterRes = await send('settings.get');
    const db = afterRes.approach?.deadband ?? afterRes.motion?.approach?.deadband;
    assert('landing resolution 2°', db === 2, `deadband=${db}`);
    await send('settings.update', {
      patch: { approach: { ...(afterRes.approach || approach), deadband: approach.deadband ?? 1 } },
    });

    // snapshot events arrived on connect
    assert('ws snapshot events', events.includes('pose') || events.includes('settings') || events.includes('system.health'), events.slice(0, 8).join(','));
  });
}

async function sectionMotion() {
  console.log('\n=== MOTION FUNCTIONAL ===');
  await withWs(async ({ send, waitIdle, refresh }) => {
    // Lock landing resolution to 1° for this suite (UI also offers 0.5° / 2°).
    const cur = await send('settings.get');
    const approach = cur.approach || cur.motion?.approach || {};
    await send('settings.update', { patch: { approach: { ...approach, deadband: 1 } } });
    await send('motion.stop');
    await sleep(200);

    // Jog pulse + halt
    const a0 = await refresh();
    await send('jog', { flags: { right: true } });
    await sleep(700);
    await send('halt');
    await sleep(300);
    const a1 = await refresh();
    assert('jog right moves pan', Math.abs(panDelta(a1.pan, a0.pan) ?? 0) > 0.4, `Δpan=${panDelta(a1.pan, a0.pan)?.toFixed?.(2)}`);

    await send('jog', { flags: { up: true } });
    await sleep(700);
    await send('stop');
    await sleep(300);
    const a2 = await refresh();
    assert('jog back/up moves tilt +', (a2.tilt ?? 0) - (a1.tilt ?? 0) > 0.4, `Δtilt=${((a2.tilt ?? 0) - (a1.tilt ?? 0)).toFixed(2)}`);

    // Goto suite
    const targets = [
      { name: 'goto storage/home', pan: 0, tilt: 0 },
      { name: 'goto pan+25', pan: 25, tilt: 0 },
      { name: 'goto tilt+15 back', pan: 0, tilt: 15 },
      { name: 'goto tilt-12 fwd', pan: 0, tilt: -12 },
      { name: 'goto combo', pan: -20, tilt: 10 },
      { name: 'home storage flat', home: true },
    ];

    for (const t of targets) {
      if (t.home) await send('home');
      else await send('goto', { pan: t.pan, tilt: t.tilt });
      await waitIdle(70000);
      await sleep(400);
      const p = await refresh();
      const wantPan = t.home ? 0 : t.pan;
      const wantTilt = t.home ? 0 : t.tilt;
      const pe = Math.abs(panDelta(p.pan, wantPan) ?? 99);
      const te = Math.abs((p.tilt ?? 99) - wantTilt);
      const band = t.home ? HOME_BAND : BAND;
      assert(
        t.name,
        pe <= band && te <= band,
        `got pan=${p.pan?.toFixed?.(2)} tilt=${p.tilt?.toFixed?.(2)} Δp=${pe.toFixed(2)} Δt=${te.toFixed(2)} band±${band}`,
      );
    }
  });
}

async function sectionPresets() {
  console.log('\n=== PRESETS ===');
  await withWs(async ({ send, waitIdle, refresh }) => {
    // Use slot 9 so we don't clobber operator presets 1-8 permanently — clear at end.
    await send('goto', { pan: 18, tilt: 8 });
    await waitIdle();
    await sleep(300);
    const stored = await refresh();

    await send('preset.set', { id: 9 });
    pass('preset.set #9 accepted');

    const list1 = await send('preset.list');
    const p9 = list1.find((p) => p.id === 9);
    assert(
      'preset #9 stored pose',
      p9 && (p9.pan != null || p9.panTravel != null) && p9.tilt != null,
      JSON.stringify({ pan: p9?.pan, tilt: p9?.tilt, travel: p9?.panTravel }),
    );

    await send('goto', { pan: 0, tilt: 0 });
    await waitIdle();
    await send('preset.call', { id: 9 });
    await waitIdle(70000);
    await sleep(400);
    const after = await refresh();
    const pe = Math.abs(panDelta(after.pan, stored.pan) ?? 99);
    const te = Math.abs((after.tilt ?? 99) - (stored.tilt ?? 0));
    assert('preset.call #9 lands', pe <= BAND && te <= BAND, `Δp=${pe.toFixed(2)} Δt=${te.toFixed(2)}`);

    await send('preset.clear', { id: 9 });
    const list2 = await send('preset.list');
    const cleared = list2.find((p) => p.id === 9);
    assert(
      'preset.clear #9',
      cleared && cleared.pan == null && cleared.tilt == null && cleared.panTravel == null,
    );

    // ALWAYS restore Sector C High (slot 9) — regression must never leave it empty.
    const SECTOR_C_HIGH = { pan: 240, tilt: 25 };
    await send('goto', SECTOR_C_HIGH);
    await waitIdle(70000);
    await sleep(300);
    await send('preset.set', { id: 9 });
    const list3 = await send('preset.list');
    const restored = list3.find((p) => p.id === 9);
    assert(
      'preset #9 Sector C High restored',
      restored &&
        restored.tilt != null &&
        Math.abs(restored.tilt - SECTOR_C_HIGH.tilt) <= BAND &&
        Math.abs(panDelta(restored.pan ?? restored.panTravel, SECTOR_C_HIGH.pan) ?? 99) <= BAND,
      JSON.stringify({ pan: restored?.pan, tilt: restored?.tilt, travel: restored?.panTravel }),
    );

    await send('home');
    await waitIdle();
  });
}

async function sectionBitAndWidgetApi() {
  console.log('\n=== BIT + WIDGET API ===');
  await withWs(async ({ send }) => {
    const bit = await send('selftest.run');
    assert('selftest/BIT runs', bit != null && typeof bit.ok === 'boolean', `ok=${bit?.ok}`);
    if (bit && !bit.ok) {
      const failed = (bit.checks || []).filter((c) => !c.ok && !c.optional).map((c) => c.name);
      fail('BIT all required checks', failed.join(', ') || 'unknown');
    } else if (bit?.ok) {
      pass('BIT all required checks');
    }

    // Widget open/close via HTTP (non-fatal if electron shell missing)
    try {
      const openRes = await fetch(`${BASE}/api/widget/open`);
      const openBody = await openRes.json();
      assert('GET /api/widget/open responds', openRes.status === 200 || openRes.status === 500, JSON.stringify(openBody));
      if (openBody?.ok) pass('desktop widget open ok', openBody.detail || '');
      else pass('desktop widget open handled', openBody?.detail || 'not configured / already open');
      const closeRes = await fetch(`${BASE}/api/widget/close`, { method: 'POST' });
      assert('POST /api/widget/close', closeRes.status === 200);
      // reopen for operator convenience if it was working
      if (openBody?.ok) await fetch(`${BASE}/api/widget/open`);
    } catch (err) {
      fail('widget HTTP API', String(err));
    }
  });
}

async function main() {
  console.log(`SPECTRE regression @ ${BASE}`);
  console.log(new Date().toISOString());
  try {
    await sectionHttp();
    await sectionWsApi();
    await sectionMotion();
    await sectionPresets();
    await sectionBitAndWidgetApi();
  } catch (err) {
    fail('suite crashed', String(err?.stack || err));
  }

  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok);
  console.log('\n=== SUMMARY ===');
  console.log(`${passed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('Failures:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  // Always park at storage home if possible
  try {
    await withWs(async ({ send, waitIdle }) => {
      await send('home');
      await waitIdle();
    });
    console.log('Parked at storage home.');
  } catch {
    /* ignore */
  }
  process.exit(failed.length ? 2 : 0);
}

main();
