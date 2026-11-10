/**
 * Find mechanical tilt ends from current pose by creeping each way until
 * encoder stops moving, then report midpoint (candidate physical level).
 */
import WebSocket from 'ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket('ws://127.0.0.1:9000/ws');
let id = 1;
const pending = new Map();
const send = (type, payload = {}) =>
  new Promise((resolve, reject) => {
    const reqId = String(id++);
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error(type));
    }, 20000);
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
    msg.payload.ok ? slot.resolve(msg.payload.data) : slot.reject(new Error(msg.payload.error));
  }
});
await new Promise((r, j) => {
  ws.once('open', r);
  ws.once('error', j);
});

const snap = async () => {
  const p = await send('motion.refresh');
  return p;
};

async function creep(dir, maxSec = 25) {
  let last = (await snap()).tilt;
  let stagnant = 0;
  const t0 = Date.now();
  console.log(`creep ${dir} from ${last?.toFixed?.(2)}`);
  await send('motion.jog', { flags: { [dir]: true } });
  while (Date.now() - t0 < maxSec * 1000) {
    await sleep(400);
    await send('motion.stop');
    await sleep(150);
    const p = await snap();
    const t = p.tilt;
    const d = Math.abs((t ?? 0) - (last ?? 0));
    console.log(`  ${dir} tilt=${t?.toFixed?.(2)} raw=${p.tiltRaw} Δ=${d.toFixed(2)}`);
    if (d < 0.35) {
      stagnant += 1;
      if (stagnant >= 3) break;
    } else stagnant = 0;
    last = t;
    await send('motion.jog', { flags: { [dir]: true } });
  }
  await send('motion.stop');
  await sleep(200);
  return snap();
}

await send('motion.stop');
const start = await snap();
console.log('START', start.tilt, start.tiltRaw);

// From here: up should be "back", down "forward" per user convention.
const upEnd = await creep('up', 20);
console.log('UP END', upEnd.tilt, upEnd.tiltRaw);

const downEnd = await creep('down', 35);
console.log('DOWN END', downEnd.tilt, downEnd.tiltRaw);

const up2 = await creep('up', 35);
console.log('UP END2', up2.tilt, up2.tiltRaw);

const a = up2.tilt;
const b = downEnd.tilt;
const min = Math.min(a, b);
const max = Math.max(a, b);
const mid = (min + max) / 2;
console.log('\n=== RANGE ===');
console.log({ min, max, span: max - min, midpoint: mid });
console.log('Candidate level (mid) =', mid.toFixed(2), '° encoder');

console.log('\nDriving to midpoint...');
await send('motion.goto', { tilt: mid });
for (let i = 0; i < 120; i++) {
  const h = await send('system.health');
  if (h.motionMode === 'idle') break;
  await sleep(250);
}
await sleep(400);
const at = await snap();
console.log('AT MID', at.tilt, at.tiltRaw);
ws.close();
