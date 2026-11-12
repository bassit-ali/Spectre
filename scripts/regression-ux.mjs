/**
 * SPECTRE UX / copy / control-map regression — console ↔ widget side-by-side.
 * Checks displayed text, data-action / data-jog mappings, sector legend, landing
 * resolution chips, and sphere math (badge placement + project/unproject).
 *
 * Usage: node scripts/regression-ux.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE = process.env.SPECTRE_URL || 'http://127.0.0.1:9000';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

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
  return { status: res.status, text: await res.text() };
}

function hasId(html, id) {
  return html.includes(`id="${id}"`);
}
function hasAction(html, action) {
  return new RegExp(`data-action="${action}"`).test(html);
}
function hasJog(html, dir) {
  return new RegExp(`data-jog="${dir}"`).test(html);
}
function hasText(html, re, flags = 'i') {
  return new RegExp(re, flags).test(html);
}

/** Mirror of ui.ts 2D pan-pad math — keep in sync for placement asserts. */
function projectPan2D(pan, cx, cy, r) {
  const d = ((((pan % 360) + 360) % 360) * Math.PI) / 180;
  return { x: cx + r * Math.sin(d), y: cy - r * Math.cos(d) };
}
function sphereBadgePoint(pan, cx, cy, r) {
  return projectPan2D(pan, cx, cy, r * 0.92);
}
function projectVector(pan, _tilt, cx, cy, r) {
  return projectPan2D(pan, cx, cy, r * 0.78);
}
function unprojectVector(x, y, cx, cy) {
  const sx = x - cx;
  const sy = cy - y;
  if (Math.hypot(sx, sy) < 6) return { pan: 0, tilt: 0 };
  let pan = (Math.atan2(sx, sy) * 180) / Math.PI;
  if (pan < 0) pan += 360;
  return { pan, tilt: 0 };
}

async function sectionConsoleCopy() {
  console.log('\n=== CONSOLE COPY + CONTROLS ===');
  const { status, text } = await httpGet('/');
  assert('console HTTP 200', status === 200);

  const requiredIds = [
    'app-header',
    'home-btn',
    'halt-btn',
    'goto-btn',
    'gimbal-sphere-svg',
    'sphere-hit',
    'sphere-pan-badges',
    'sphere-vector-layer',
    'jog-up',
    'jog-down',
    'jog-left',
    'jog-right',
    'tilt-slider',
    'land-res-05',
    'land-res-1',
    'land-res-2',
    'preset-1-call',
    'preset-1-set',
    'preset-1-clear',
  ];
  for (const id of requiredIds) assert(`console #${id}`, hasId(text, id));

  assert('console title SPECTRE', hasText(text, 'SPECTRE'));
  assert('console product pan-tilt', hasText(text, 'PAN-TILT|PEDESTAL'));
  assert('console UP label', hasText(text, '\\bUP\\b'));
  assert('console DOWN label', hasText(text, '\\bDOWN\\b'));
  assert('console LEVEL label', hasText(text, 'LEVEL'));
  assert('console home storage title', hasText(text, 'storage|Home', 'i'));
  assert('console landing home 1.5', hasText(text, '1\\.5°'));
  assert('console vertical tilt slider', hasText(text, 'tilt-slider-v'));
  assert('console no under sector banner', !hasId(text, 'sphere-sector-legend'));
  assert('console sector badges host', hasId(text, 'sphere-pan-badges'));
  assert('console sector angles A0 B120 C240', hasText(text, 'A@0°') && hasText(text, '120') && hasText(text, '240'));
  assert('console presets subtitle sectors', hasText(text, 'A@0°'));
  assert('console preset Sector A Low', hasText(text, 'Sector A Low'));
  assert('console preset Sector B Level', hasText(text, 'Sector B Level'));
  assert('console preset Sector C High', hasText(text, 'Sector C High'));
  assert('console no compass cardinal N/E/S/W chrome', !hasText(text, '>\\s*N\\s*<') && !hasText(text, 'NORTH'));
  assert('console no BACK/FWD labels', !hasText(text, '\\bBACK\\b') && !hasText(text, '\\bFWD\\b') && !hasText(text, '\\bFORWARD\\b'));

  // Function map
  assert('console action home', hasAction(text, 'home'));
  assert('console action halt or halt btn', hasId(text, 'halt-btn'));
  assert('console action goto', hasAction(text, 'goto') || hasId(text, 'goto-btn'));
  assert('console action landing-res', hasAction(text, 'landing-res'));
  assert('console jog up=UP', hasJog(text, 'up') && hasText(text, '\\bUP\\b'));
  assert('console jog down=DOWN', hasJog(text, 'down') && hasText(text, '\\bDOWN\\b'));
  assert('console jog left/right pan', hasJog(text, 'left') && hasJog(text, 'right'));
  assert('console land 0.5/1/2 chips', hasId(text, 'land-res-05') && hasId(text, 'land-res-1') && hasId(text, 'land-res-2'));
  assert('console no fine pan slider', !hasId(text, 'pan-slider'));
  assert('console tilt ±50', hasText(text, '±50°|−50°|\\+50°') || (hasText(text, 'min="-50"') && hasText(text, 'max="50"')));
  assert('console ethernet udp host field', hasId(text, 'udp-host-input'));
  assert('console ethernet udp port field', hasId(text, 'udp-port-input'));
  assert('console prefer udp checkbox', hasId(text, 'prefer-udp-check'));
  assert('console eth apply action', hasAction(text, 'eth-apply'));
  assert('console prefer udp default off', hasText(text, 'id="prefer-udp-check"[^>]*type="checkbox"') && !hasText(text, 'id="prefer-udp-check"[^>]*checked'));
  assert('console factory udp seed visible', hasText(text, '192\\.168\\.8\\.200') && hasText(text, 'value="6666"'));
  assert('console settings jump action', hasAction(text, 'open-settings'));
  assert('console settings section', hasId(text, 'sec-settings'));
  assert('console sphere aim degree tag', hasId(text, 'sphere-aim-label'));
  assert('console step 1/5/10 buttons', hasText(text, 'data-step="1"') && hasText(text, 'data-step="5"') && hasText(text, 'data-step="10"'));
  assert('console nudge titles', hasText(text, 'Nudge pan') && hasText(text, 'hold to repeat'));
}

async function sectionWidgetCopy() {
  console.log('\n=== WIDGET COPY + CONTROLS ===');
  const { status, text } = await httpGet('/widget.html');
  assert('widget HTTP 200', status === 200);

  const requiredIds = [
    'spectre-widget',
    'widget-home-btn',
    'widget-halt-btn',
    'widget-goto-btn',
    'dome-sphere-svg',
    'dome-hit',
    'dome-pan-badges',
    'dome-vector-layer',
    'widget-jog-up',
    'widget-jog-down',
    'widget-jog-left',
    'widget-jog-right',
    'w-land-res-05',
    'w-land-res-1',
    'w-land-res-2',
    'w-preset-1',
    'w-preset-5',
    'w-preset-9',
    'widget-tilt-slider',
  ];
  for (const id of requiredIds) assert(`widget #${id}`, hasId(text, id));

  assert('widget SPECTRE', hasText(text, 'SPECTRE'));
  assert('widget UP/DOWN scale', hasText(text, '\\bUP\\b') && hasText(text, '\\bDOWN\\b'));
  assert('widget no BACK/FWD labels', !hasText(text, '\\bBACK\\b') && !hasText(text, '\\bFWD\\b') && !hasText(text, '\\bFORWARD\\b'));
  assert('widget vertical tilt slider', hasText(text, 'tilt-slider-v'));
  assert('widget tilt slider action', hasAction(text, 'tilt-slider'));
  assert('widget no under sector banner', !hasId(text, 'dome-sector-legend'));
  assert('widget sector badges host', hasId(text, 'dome-pan-badges'));
  assert('widget home 1.5 note', hasText(text, '1\\.5°'));
  assert('widget landing-res action', hasAction(text, 'landing-res'));
  assert('widget jog map', hasJog(text, 'up') && hasJog(text, 'down') && hasJog(text, 'left') && hasJog(text, 'right'));
  assert('widget overflow visible for badges', hasText(text, 'overflow-visible'));
  assert('widget preset Sector names', hasText(text, 'Sector A Low') && hasText(text, 'Sector C High'));
  assert('widget no fine pan bars', !hasId(text, 'widget-pan-minus') && !hasId(text, 'widget-pan-plus'));
  assert('widget pin in header', hasId(text, 'widget-pin-btn'));
  assert('widget tilt ±50', hasText(text, '±50°') && /min="-50"/.test(text) && /max="50"/.test(text));
  assert('widget opacity chrome', hasId(text, 'widget-opacity-slider') && hasId(text, 'widget-opacity-btn'));
  assert('widget no credit footer', !/26 SIG|R&D WING/i.test(text));
  assert('widget offline banner', hasId(text, 'widget-offline-banner') && hasText(text, 'No device connected'));
  assert('widget open-console on SPECTRE', hasAction(text, 'open-console') && hasId(text, 'product-name'));
  assert('widget dome aim degree tag', hasId(text, 'dome-aim-label'));
  assert('widget nudge titles', hasText(text, 'Nudge pan') && hasText(text, 'hold to repeat'));
}

async function sectionParity() {
  console.log('\n=== CONSOLE ↔ WIDGET PARITY ===');
  const consoleHtml = (await httpGet('/')).text;
  const widgetHtml = (await httpGet('/widget.html')).text;

  const pairs = [
    ['home', hasAction(consoleHtml, 'home') && hasAction(widgetHtml, 'home')],
    ['halt', hasId(consoleHtml, 'halt-btn') && hasId(widgetHtml, 'widget-halt-btn')],
    ['goto', (hasAction(consoleHtml, 'goto') || hasId(consoleHtml, 'goto-btn')) && hasAction(widgetHtml, 'goto')],
    ['landing-res', hasAction(consoleHtml, 'landing-res') && hasAction(widgetHtml, 'landing-res')],
    ['sphere hit', hasId(consoleHtml, 'sphere-hit') && hasId(widgetHtml, 'dome-hit')],
    ['sector badges host', hasId(consoleHtml, 'sphere-pan-badges') && hasId(widgetHtml, 'dome-pan-badges')],
    ['vertical tilt', /tilt-slider-v/.test(consoleHtml) && /tilt-slider-v/.test(widgetHtml)],
    ['jog up', hasJog(consoleHtml, 'up') && hasJog(widgetHtml, 'up')],
    ['jog down', hasJog(consoleHtml, 'down') && hasJog(widgetHtml, 'down')],
  ];
  for (const [name, ok] of pairs) assert(`parity ${name}`, ok);

  assert('parity A@0 subtitle', /A@0°/.test(consoleHtml));
  assert('parity no under sector banners', !hasId(consoleHtml, 'sphere-sector-legend') && !hasId(widgetHtml, 'dome-sector-legend'));
}

async function sectionBundleSectorPaint() {
  console.log('\n=== BUILT JS SECTOR PAINTER ===');
  const distDir = path.join(ROOT, 'web', 'dist', 'assets');
  assert('dist/assets exists', fs.existsSync(distDir));
  const files = fs.readdirSync(distDir).filter((f) => f.endsWith('.js'));
  const blobs = files.map((f) => fs.readFileSync(path.join(distDir, f), 'utf8')).join('\n');
  // Minified builds rename exports — assert durable sector-painter markers instead.
  assert('bundle paints sector hosts', /sphere-pan-badges/.test(blobs) && /dome-pan-badges/.test(blobs));
  assert('bundle sector marker attrs', /data-sector/.test(blobs) && /Camera sectors/.test(blobs));
  assert('bundle sector colors', /9f1d15/.test(blobs) && /ffdad6/.test(blobs));
  assert('bundle marks 0 / 120 / 240', /\b120\b/.test(blobs) && /\b240\b/.test(blobs));
}

async function sectionSphereMath() {
  console.log('\n=== 2D PAN PAD MATH (BADGES + ROUNDTRIP) ===');
  const SECTORS = [
    { sector: 'A', pan: 0 },
    { sector: 'B', pan: 120 },
    { sector: 'C', pan: 240 },
  ];
  const consoleL = { cx: 130, cy: 120, r: 100 };
  const widgetL = { cx: 72, cy: 72, r: 60 };

  for (const layout of [
    ['console', consoleL],
    ['widget', widgetL],
  ]) {
    const [name, L] = layout;
    for (const s of SECTORS) {
      const p = sphereBadgePoint(s.pan, L.cx, L.cy, L.r);
      const near =
        p.x >= L.cx - L.r * 1.15 &&
        p.x <= L.cx + L.r * 1.15 &&
        p.y >= L.cy - L.r * 1.15 &&
        p.y <= L.cy + L.r * 1.15;
      assert(`${name} badge ${s.sector}@${s.pan}° placed`, near, `x=${p.x.toFixed(1)} y=${p.y.toFixed(1)}`);
    }
    const a = sphereBadgePoint(0, L.cx, L.cy, L.r);
    const b = sphereBadgePoint(120, L.cx, L.cy, L.r);
    const c = sphereBadgePoint(240, L.cx, L.cy, L.r);
    assert(`${name} A(0) above center`, a.y < L.cy - 8, `y=${a.y.toFixed(1)}`);
    assert(`${name} B(120) right of center`, b.x > L.cx + 8, `x=${b.x.toFixed(1)}`);
    assert(`${name} C(240) left of center`, c.x < L.cx - 8, `x=${c.x.toFixed(1)}`);
    // Spread — no clustering in the middle.
    const ab = Math.hypot(a.x - b.x, a.y - b.y);
    const bc = Math.hypot(b.x - c.x, b.y - c.y);
    const ca = Math.hypot(c.x - a.x, c.y - a.y);
    assert(`${name} sectors well spaced`, ab > L.r * 0.7 && bc > L.r * 0.7 && ca > L.r * 0.7, `ab=${ab.toFixed(0)} bc=${bc.toFixed(0)} ca=${ca.toFixed(0)}`);
  }

  // 2D pad: pan roundtrip only (tilt is the separate slider)
  const samples = [0, 45, 90, 120, 180, 240, 300, 330];
  for (const pan of samples) {
    const p = projectVector(pan, 0, 130, 120, 100);
    const back = unprojectVector(p.x, p.y, 130, 120);
    const panErr = Math.abs((((back.pan - pan + 540) % 360) - 180));
    assert(
      `roundtrip pan=${pan}`,
      panErr < 1.5,
      `got pan=${back.pan.toFixed(1)} Δp=${panErr.toFixed(2)}`,
    );
  }
  // Aft vs face are unambiguous on 2D (bottom vs top)
  const aft = unprojectVector(130, 120 + 60, 130, 120);
  const face = unprojectVector(130, 120 - 60, 130, 120);
  assert('click bottom → aft ~180', Math.abs((((aft.pan - 180 + 540) % 360) - 180)) < 2, `pan=${aft.pan}`);
  assert('click top → face ~0', Math.abs((((face.pan - 0 + 540) % 360) - 180)) < 2, `pan=${face.pan}`);
}

async function sectionLiveSettingsLanding() {
  console.log('\n=== LIVE LANDING RESOLUTION API ===');
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(process.env.SPECTRE_WS || 'ws://127.0.0.1:9000/ws');
  let id = 1;
  const pending = new Map();
  const send = (type, payload = {}) =>
    new Promise((resolve, reject) => {
      const reqId = String(id++);
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error(`timeout ${type}`));
      }, 15000);
      pending.set(reqId, { resolve, reject, timer });
      ws.send(JSON.stringify({ type, payload, id: reqId }));
    });
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'ack' && msg.payload?.id != null) {
      const slot = pending.get(String(msg.payload.id));
      if (!slot) return;
      clearTimeout(slot.timer);
      pending.delete(String(msg.payload.id));
      if (msg.payload.ok) slot.resolve(msg.payload.data);
      else slot.reject(new Error(msg.payload.error || 'fail'));
    }
  });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });

  const before = await send('settings.get');
  const approach = before.approach || {};
  for (const deg of [0.5, 1, 2]) {
    const next = await send('settings.update', { patch: { approach: { ...approach, deadband: deg } } });
    const got = next?.approach?.deadband ?? (await send('settings.get')).approach?.deadband;
    assert(`landing res set ${deg}°`, got === deg, `got=${got}`);
  }
  await send('settings.update', { patch: { approach: { ...approach, deadband: 1 } } });
  ws.close();
}

async function main() {
  console.log(`SPECTRE UX regression @ ${BASE}`);
  console.log(new Date().toISOString());
  try {
    await sectionConsoleCopy();
    await sectionWidgetCopy();
    await sectionParity();
    await sectionBundleSectorPaint();
    await sectionSphereMath();
    await sectionLiveSettingsLanding();
  } catch (err) {
    fail('ux suite crashed', String(err?.stack || err));
  }

  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok);
  console.log('\n=== UX SUMMARY ===');
  console.log(`${passed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('Failures:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  process.exit(failed.length ? 2 : 0);
}

main();
