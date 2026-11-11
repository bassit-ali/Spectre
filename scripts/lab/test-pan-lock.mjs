/**
 * Live test: jog toward the +180 travel end-stop and prove we stop
 * instead of completing a full revolution.
 */
import { SerialPort } from 'serialport';

const path = process.argv[2] || 'COM13';
const baudRate = Number(process.argv[3] || 9600);
const address = 1;

function checksum(bytes) {
  return (bytes[1] + bytes[2] + bytes[3] + bytes[4] + bytes[5]) & 0xff;
}
function frame(cmd2, d1 = 0, d2 = 0) {
  const f = [0xff, address, 0x00, cmd2, d1, d2, 0];
  f[6] = checksum(f);
  return Buffer.from(f);
}
function toSigned180(d) {
  let x = ((((d + 180) % 360) + 360) % 360) - 180;
  if (x <= -180) return 180;
  return x;
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const port = new SerialPort({ path, baudRate, autoOpen: false });
await new Promise((resolve, reject) => port.open((e) => (e ? reject(e) : resolve())));

let buf = Buffer.alloc(0);
let lastDevice = null;
let travel = null;
const positions = [];

port.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 7) {
    const i = buf.indexOf(0xff);
    if (i < 0) {
      buf = Buffer.alloc(0);
      break;
    }
    if (i > 0) buf = buf.subarray(i);
    if (buf.length < 7) break;
    const f = buf.subarray(0, 7);
    buf = buf.subarray(7);
    if (checksum([...f]) !== f[6]) continue;
    if (f[3] === 0x59) {
      const raw = (f[4] << 8) | f[5];
      const device = raw / 100;
      if (lastDevice == null) travel = toSigned180(device);
      else {
        let delta = device - lastDevice;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        travel += delta;
      }
      lastDevice = device;
      positions.push({ device, travel });
    }
  }
});

async function queryPan() {
  port.write(frame(0x51));
  await delay(80);
}
async function jogRight(speed = 40) {
  port.write(frame(0x02, speed, 0));
}
async function stop() {
  port.write(frame(0x00, 0, 0));
}

await queryPan();
await queryPan();
console.log('start', positions.at(-1));

const startTravel = travel;
const direction = startTravel != null && startTravel > 0 ? 'left' : 'right';
console.log('jogging', direction, 'toward end-stop from travel', startTravel);

const t0 = Date.now();
let hit = false;
while (Date.now() - t0 < 25000) {
  if (direction === 'right') await jogRight(48);
  else port.write(frame(0x04, 48, 0)); // left
  await delay(180);
  await queryPan();
  await delay(40);
  const cur = positions.at(-1);
  if (!cur) continue;
  process.stdout.write(
    `\r device=${cur.device.toFixed(2)} travel=${cur.travel.toFixed(2)}   `,
  );
  if (direction === 'right' && cur.travel >= 179.2) {
    hit = true;
    break;
  }
  if (direction === 'left' && cur.travel <= -179.2) {
    hit = true;
    break;
  }
}

await stop();
await delay(100);
await queryPan();
const end = positions.at(-1);
console.log('\nend', end);
console.log(hit ? 'PASS: end-stop reached without needing a full revolution wrap' : 'FAIL: did not reach end-stop in time');

// Continue same direction briefly — travel must not keep climbing past ±180 if lock logic were applied.
// This script only verifies tracking + that we can REACH the stop; app applies the lock.

await new Promise((r) => port.close(() => r()));
process.exit(hit ? 0 : 1);
