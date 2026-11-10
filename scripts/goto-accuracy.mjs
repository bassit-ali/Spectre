/**
 * Closed-loop goto accuracy probe against the live SPECTRE server.
 * Usage: node scripts/goto-accuracy.mjs
 */
import WebSocket from 'ws';

const WS = process.env.SPECTRE_WS || 'ws://127.0.0.1:9000/ws';
const DEADBAND = Number(process.env.DEADBAND || 0.6);
const SETTLE_MS = 900;
const MOVE_TIMEOUT_MS = 45000;

const targets = [
  { name: 'home', pan: 0, tilt: 0 },
  { name: 'pan+30', pan: 30, tilt: 0 },
  { name: 'pan-30', pan: -30, tilt: 0 },
  { name: 'tilt+20', pan: 0, tilt: 20 },
  { name: 'tilt-15', pan: 0, tilt: -15 },
  { name: 'combo', pan: 45, tilt: 15 },
  { name: 'home-final', pan: 0, tilt: 0 },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function signedPan(p) {
  let d = ((((p + 180) % 360) + 360) % 360) - 180;
  if (d <= -180) return 180;
  return d;
}

function panErr(got, want) {
  if (got == null || want == null) return null;
  // Compare in signed space nearest to travel intent.
  const g = signedPan(got);
  const w = signedPan(want);
  let e = g - w;
  if (e > 180) e -= 360;
  if (e < -180) e += 360;
  return e;
}

async function main() {
  const ws = new WebSocket(WS);
  let id = 1;
  const pending = new Map();
  let pose = { pan: null, tilt: null, panTravel: null };
  let mode = 'idle';
  let lastError = null;

  const send = (type, payload = {}) =>
    new Promise((resolve, reject) => {
      const reqId = String(id++);
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error(`timeout waiting ack for ${type}`));
      }, 15000);
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
      if (slot) {
        clearTimeout(slot.timer);
        pending.delete(String(msg.payload.id));
        if (msg.payload.ok) slot.resolve(msg.payload.data);
        else slot.reject(new Error(msg.payload.error || 'ack failed'));
      }
      return;
    }
    if (msg.type === 'pose' && msg.payload) pose = { ...pose, ...msg.payload };
    if (msg.type === 'state' && msg.payload?.mode) mode = msg.payload.mode;
    if (msg.type === 'error' && msg.payload) lastError = msg.payload;
    if (msg.type === 'moveSnapshot' && msg.payload?.after) pose = { ...pose, ...msg.payload.after };
  });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const health = await send('system.health');
  console.log('health', JSON.stringify(health));
  if (!health?.serial?.connected) throw new Error('serial not connected');
  if (!health?.encoderHealthy && !health?.encoderReason?.includes('soft')) {
    console.warn('encoder soft/unhealthy:', health.encoderReason);
  }

  const settings = await send('settings.get');
  console.log('approach', JSON.stringify(settings?.approach ?? settings?.motion?.approach ?? settings));

  pose = (await send('motion.refresh')) || (await send('motion.pose'));
  console.log('start pose', pose);

  const results = [];

  for (const t of targets) {
    lastError = null;
    console.log(`\n→ goto ${t.name}: pan=${t.pan} tilt=${t.tilt}`);
    const t0 = Date.now();
    await send('motion.goto', { pan: t.pan, tilt: t.tilt });

    // Wait until idle + settled pose (use health.motionMode as backup).
    const deadline = Date.now() + MOVE_TIMEOUT_MS;
    let idleSince = null;
    while (Date.now() < deadline) {
      await sleep(250);
      let liveMode = mode;
      try {
        const h = await send('system.health');
        if (h?.motionMode) liveMode = h.motionMode;
      } catch {
        /* ignore */
      }
      if (liveMode === 'idle' || liveMode === 'error') {
        if (!idleSince) idleSince = Date.now();
        if (Date.now() - idleSince >= SETTLE_MS) break;
      } else {
        idleSince = null;
      }
    }
    // Force encoder sample after move.
    try {
      pose = (await send('motion.refresh')) || pose;
    } catch {
      /* ignore */
    }
    await sleep(250);
    try {
      pose = (await send('motion.pose')) || pose;
    } catch {
      /* ignore */
    }

    const pe = panErr(pose.pan, t.pan);
    const te = pose.tilt == null ? null : pose.tilt - t.tilt;
    const peAbs = pe == null ? null : Math.abs(pe);
    const teAbs = te == null ? null : Math.abs(te);
    const ok =
      peAbs != null &&
      teAbs != null &&
      peAbs <= DEADBAND &&
      teAbs <= DEADBAND &&
      !lastError;
    const row = {
      name: t.name,
      want: t,
      got: { pan: pose.pan, tilt: pose.tilt, panTravel: pose.panTravel },
      panErr: pe == null ? null : Number(pe.toFixed(2)),
      tiltErr: te == null ? null : Number(te.toFixed(2)),
      ms: Date.now() - t0,
      ok,
      error: lastError,
    };
    results.push(row);
    console.log(
      `  got pan=${pose.pan?.toFixed?.(2) ?? pose.pan} tilt=${pose.tilt?.toFixed?.(2) ?? pose.tilt}` +
        `  Δpan=${row.panErr} Δtilt=${row.tiltErr}  ${ok ? 'PASS' : 'FAIL'}  ${row.ms}ms`,
    );
    if (lastError) console.log('  error event', lastError);
  }

  const fails = results.filter((r) => !r.ok);
  console.log('\n=== SUMMARY ===');
  for (const r of results) {
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'} ${r.name.padEnd(12)} Δpan=${String(r.panErr).padStart(6)} Δtilt=${String(r.tiltErr).padStart(6)} ${r.ms}ms`,
    );
  }
  console.log(`${results.length - fails.length}/${results.length} within ±${DEADBAND}°`);

  // Stop and close.
  try {
    await send('motion.stop');
  } catch {
    /* ignore */
  }
  ws.close();
  process.exit(fails.length ? 2 : 0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
