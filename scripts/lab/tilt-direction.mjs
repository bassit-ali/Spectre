/** Probe which tilt bit raises elevation. */
import WebSocket from 'ws';

const WS = 'ws://127.0.0.1:9000/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ws = new WebSocket(WS);
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

  const sample = async (label) => {
    pose = (await send('motion.refresh')) || pose;
    await sleep(150);
    pose = (await send('motion.pose')) || pose;
    console.log(
      `${label}: pan=${pose.pan?.toFixed?.(2)} tilt=${pose.tilt?.toFixed?.(2)} rawTilt=${pose.tiltRaw}`,
    );
    return { ...pose };
  };

  await send('motion.stop');
  const a = await sample('start');

  console.log('\njog UP (flags.up → cmd bit 0x08) for 1.5s');
  await send('motion.jog', { flags: { up: true } });
  await sleep(1500);
  await send('motion.stop');
  await sleep(400);
  const b = await sample('after UP');

  console.log('\njog DOWN (flags.down → cmd bit 0x10) for 1.5s');
  await send('motion.jog', { flags: { down: true } });
  await sleep(1500);
  await send('motion.stop');
  await sleep(400);
  const c = await sample('after DOWN');

  const dUp = (b.tilt ?? 0) - (a.tilt ?? 0);
  const dDown = (c.tilt ?? 0) - (b.tilt ?? 0);
  console.log('\n=== RESULT ===');
  console.log(`UP command delta tilt:   ${dUp.toFixed(2)}°  (want positive if mapping correct)`);
  console.log(`DOWN command delta tilt: ${dDown.toFixed(2)}°  (want negative if mapping correct)`);
  if (dUp < -1 && dDown > 1) console.log('VERDICT: BITS INVERTED — flip up/down mapping');
  else if (dUp > 1 && dDown < -1) console.log('VERDICT: bits OK');
  else console.log('VERDICT: inconclusive — weak motion or limit hit');

  ws.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
