import { SerialPort } from 'serialport';

const pathArg = process.argv[2] || (process.platform === 'win32' ? 'COM13' : '/dev/ttyUSB0');
const bauds = [9600, 19200, 4800, 2400];
const addrs = [1, 2, 3, 4];

function checksum(bytes) {
  return (bytes[1] + bytes[2] + bytes[3] + bytes[4] + bytes[5]) & 0xff;
}

function frame(addr, cmd2) {
  const f = [0xff, addr, 0x00, cmd2, 0x00, 0x00, 0];
  f[6] = checksum(f);
  return Buffer.from(f);
}

function hex(buf) {
  return [...buf].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

async function open(path, baudRate) {
  const port = new SerialPort({ path, baudRate, autoOpen: false });
  await new Promise((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
  return port;
}

async function query(port, addr, cmd2) {
  const req = frame(addr, cmd2);
  port.flush();
  port.write(req);
  await new Promise((r) => setTimeout(r, 280));
  const n = port.readableLength || 0;
  // readableLength may be 0 on some bindings; use read with timeout via 'data'
  return await new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
    };
    port.on('data', onData);
    setTimeout(() => {
      port.off('data', onData);
      resolve(buf);
    }, 200);
  });
}

const ports = await SerialPort.list();
console.log('Ports:', ports.map((p) => p.path).join(', '));

for (const baud of bauds) {
  for (const addr of addrs) {
    try {
      const port = await open(pathArg, baud);
      const pan = await query(port, addr, 0x51);
      const tilt = await query(port, addr, 0x53);
      await new Promise((resolve) => port.close(() => resolve()));
      if (pan.length || tilt.length) {
        console.log(`HIT baud=${baud} addr=${addr}`);
        console.log('  PAN ', hex(pan));
        console.log('  TILT', hex(tilt));
        process.exit(0);
      } else {
        console.log(`miss baud=${baud} addr=${addr}`);
      }
    } catch (err) {
      console.log(`err baud=${baud} addr=${addr}: ${err.message}`);
    }
  }
}
console.log('No response');
