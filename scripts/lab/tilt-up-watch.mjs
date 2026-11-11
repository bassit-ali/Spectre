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

const waitIdle = async () => {
  for (let i = 0; i < 120; i++) {
    const h = await send('system.health');
    if (h.motionMode === 'idle') return;
    await sleep(200);
  }
};

await send('motion.stop');
console.log('recover to 0...');
await send('motion.goto', { pan: 0, tilt: 0 });
await waitIdle();
await sleep(400);
let p = await send('motion.refresh');
console.log('at', p.tilt, p.tiltRaw);

console.log('pulse UP x12 (0.35s each)');
for (let i = 0; i < 12; i++) {
  await send('motion.jog', { flags: { up: true } });
  await sleep(350);
  await send('motion.stop');
  await sleep(200);
  p = await send('motion.refresh');
  const raw = p.tiltRaw;
  let alt = null;
  if (raw != null) {
    if (raw <= 36000) {
      alt = raw > 18000 ? (36000 - raw) / 100 : -raw / 100;
    } else {
      alt = (raw > 32767 ? raw - 65536 : raw) / 100;
    }
  }
  console.log(`#${i + 1} tilt=${p.tilt?.toFixed?.(2)} raw=${raw} altDecode=${alt?.toFixed?.(2)}`);
  if ((p.tilt ?? 0) > 25 || (p.tilt ?? 0) < -70) break;
}
ws.close();
