/** Jog tilt upward through zero while printing raw encoder samples. */
import WebSocket from 'ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket('ws://127.0.0.1:9000/ws');
let id = 1;
const pending = new Map();
let pose = {};

const send = (type, payload = {}) =>
  new Promise((resolve, reject) => {
    const reqId = String(id++);
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error(`timeout ${type}`));
    }, 10000);
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
  if (msg.type === 'pose') pose = msg.payload;
});

await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});

await send('motion.stop');
pose = await send('motion.refresh');
console.log('start', pose.tilt, pose.tiltRaw);

// Nudge down first if already high so we have room.
if ((pose.tilt ?? 0) > -5) {
  await send('motion.jog', { flags: { down: true } });
  await sleep(2000);
  await send('motion.stop');
  pose = await send('motion.refresh');
  console.log('prepped', pose.tilt, pose.tiltRaw);
}

console.log('jogging UP for 5s with samples...');
await send('motion.jog', { flags: { up: true } });
const t0 = Date.now();
while (Date.now() - t0 < 5000) {
  await sleep(250);
  try {
    pose = await send('motion.pose');
  } catch {
    /* ignore */
  }
  console.log(`${Date.now() - t0}ms tilt=${pose.tilt?.toFixed?.(2)} raw=${pose.tiltRaw}`);
}
await send('motion.stop');
pose = await send('motion.refresh');
console.log('end', pose.tilt, pose.tiltRaw);
ws.close();
