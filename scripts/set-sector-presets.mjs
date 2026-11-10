/**
 * Program + verify the 3×3 sector presets:
 *   A@0° / B@120° / C@240°
 *   Low tilt −20° · Level 0° · High +25°
 *
 * Usage: node scripts/set-sector-presets.mjs
 */
import WebSocket from 'ws';

const WS = process.env.SPECTRE_WS || 'ws://127.0.0.1:9000/ws';
// 1° landing resolution + small encoder/settle margin for recall checks.
const BAND = Number(process.env.LAND_BAND || 2.0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PRESETS = [
  { id: 1, label: 'Sector A Low', pan: 0, tilt: -20 },
  { id: 2, label: 'Sector A Level', pan: 0, tilt: 0 },
  { id: 3, label: 'Sector A High', pan: 0, tilt: 25 },
  { id: 4, label: 'Sector B Low', pan: 120, tilt: -20 },
  { id: 5, label: 'Sector B Level', pan: 120, tilt: 0 },
  { id: 6, label: 'Sector B High', pan: 120, tilt: 25 },
  { id: 7, label: 'Sector C Low', pan: 240, tilt: -20 },
  { id: 8, label: 'Sector C Level', pan: 240, tilt: 0 },
  { id: 9, label: 'Sector C High', pan: 240, tilt: 25 },
];

function signedPan(p) {
  let d = ((((p + 180) % 360) + 360) % 360) - 180;
  if (d <= -180) return 180;
  return d;
}
function panErr(got, want) {
  if (got == null || want == null) return 99;
  let e = signedPan(got) - signedPan(want);
  if (e > 180) e -= 360;
  if (e < -180) e += 360;
  return Math.abs(e);
}

async function main() {
  const ws = new WebSocket(WS);
  let id = 1;
  const pending = new Map();
  let pose = {};
  let mode = 'idle';

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
  });

  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });

  const refresh = async () => {
    pose = (await send('motion.refresh')) || pose;
    await sleep(180);
    pose = (await send('motion.pose')) || pose;
    return pose;
  };

  const waitIdle = async (timeoutMs = 90000) => {
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
      } else if (Date.now() - start > 2000 && live === 'idle') {
        return live;
      }
      await sleep(250);
    }
    throw new Error('waitIdle timeout');
  };

  // Lock landing resolution to 1° for programming + recall.
  const cur = await send('settings.get');
  const approach = cur.approach || {};
  await send('settings.update', { patch: { approach: { ...approach, deadband: 1 } } });

  // Re-base travel at home so Sector C @ 240° (travel −120) is reachable.
  console.log('=== HOME (rebase travel) ===');
  await send('home');
  await waitIdle();
  await refresh();

  console.log('=== PROGRAM SECTOR PRESETS ===');
  const results = [];

  for (const p of PRESETS) {
    process.stdout.write(`SET #${p.id} ${p.label} → pan ${p.pan}° tilt ${p.tilt}° … `);
    await send('motion.stop');
    await sleep(150);
    await send('goto', { pan: p.pan, tilt: p.tilt });
    await waitIdle();
    await sleep(350);
    const after = await refresh();
    const pe = panErr(after.pan, p.pan);
    const te = Math.abs((after.tilt ?? 99) - p.tilt);
    if (pe > BAND || te > BAND) {
      console.log(`LAND FAIL Δp=${pe.toFixed(2)} Δt=${te.toFixed(2)}`);
      results.push({ ok: false, step: `set-land #${p.id}`, pe, te, pose: after });
      continue;
    }
    await send('preset.set', { id: p.id });
    console.log(`OK (pan=${after.pan?.toFixed?.(2)} tilt=${after.tilt?.toFixed?.(2)})`);
    results.push({ ok: true, step: `set #${p.id}`, pe, te });
  }

  const list = await send('preset.list');
  console.log('\n=== STORED PRESET TABLE ===');
  for (const p of PRESETS) {
    const row = list.find((x) => x.id === p.id);
    const ok =
      row &&
      row.tilt != null &&
      (row.pan != null || row.panTravel != null) &&
      Math.abs((row.tilt ?? 99) - p.tilt) <= BAND &&
      panErr(row.pan ?? row.panTravel, p.pan) <= BAND;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  #${p.id} ${p.label.padEnd(16)} stored pan=${row?.pan?.toFixed?.(2) ?? '—'} travel=${row?.panTravel?.toFixed?.(2) ?? '—'} tilt=${row?.tilt?.toFixed?.(2) ?? '—'}`,
    );
    results.push({ ok: !!ok, step: `store #${p.id}` });
  }

  console.log('\n=== CALL / RECALL ALL PRESETS ===');
  // Park away first so each call must actually move.
  await send('goto', { pan: 60, tilt: 10 });
  await waitIdle();

  for (const p of PRESETS) {
    process.stdout.write(`CALL #${p.id} ${p.label} … `);
    await send('preset.call', { id: p.id });
    await waitIdle(90000);
    await sleep(400);
    const got = await refresh();
    const pe = panErr(got.pan, p.pan);
    const te = Math.abs((got.tilt ?? 99) - p.tilt);
    const ok = pe <= BAND && te <= BAND;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  got pan=${got.pan?.toFixed?.(2)} tilt=${got.tilt?.toFixed?.(2)} Δp=${pe.toFixed(2)} Δt=${te.toFixed(2)}`,
    );
    results.push({ ok, step: `call #${p.id}`, pe, te, pose: got });
  }

  await send('home');
  await waitIdle();

  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok);
  console.log('\n=== SUMMARY ===');
  console.log(`${passed.length}/${results.length} passed · band ±${BAND}°`);
  if (failed.length) {
    console.log('Failures:');
    for (const f of failed) console.log(`  - ${f.step}${f.pe != null ? ` Δp=${f.pe.toFixed?.(2)} Δt=${f.te?.toFixed?.(2)}` : ''}`);
  }

  ws.close();
  process.exit(failed.length ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
