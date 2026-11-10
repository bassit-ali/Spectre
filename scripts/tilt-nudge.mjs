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
await new Promise((r, j) => {
  ws.once('open', r);
  ws.once('error', j);
});

const snap = async (label) => {
  // wait until not busy
  for (let i = 0; i < 20; i++) {
    const h = await send('system.health');
    if (h.motionMode === 'idle') break;
    await sleep(100);
  }
  const p = await send('motion.refresh');
  console.log(`${label}: tilt=${p.tilt?.toFixed?.(2)} raw=${p.tiltRaw} pan=${p.pan?.toFixed?.(2)}`);
  return p;
};

await send('motion.stop');
await snap('start');

console.log('UP 2s');
await send('motion.jog', { flags: { up: true } });
await sleep(2000);
await send('motion.stop');
await sleep(300);
await snap('after UP');

console.log('DOWN 2s');
await send('motion.jog', { flags: { down: true } });
await sleep(2000);
await send('motion.stop');
await sleep(300);
await snap('after DOWN');

console.log('goto tilt 0');
await send('motion.goto', { tilt: 0 });
for (let i = 0; i < 80; i++) {
  const h = await send('system.health');
  if (h.motionMode === 'idle') break;
  await sleep(250);
}
await sleep(500);
await snap('after goto0');

ws.close();
