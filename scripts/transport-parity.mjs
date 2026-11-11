/**
 * Offline Pelco-D transport parity — RS-485 and Ethernet UDP must emit identical frames.
 * No hardware required: opens UDP to 127.0.0.1 and captures PortManager 'tx' hex.
 *
 * Usage: node scripts/transport-parity.mjs
 */
import dgram from 'node:dgram';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

async function loadDist() {
  const pelcoPath = path.join(ROOT, 'server', 'dist', 'shared', 'pelcoD.js');
  const portPath = path.join(ROOT, 'server', 'dist', 'shared', 'portManager.js');
  const pelco = await import(pathToFileURL(pelcoPath).href);
  const { PortManager } = await import(pathToFileURL(portPath).href);
  return { pelco, PortManager };
}

function hexOf(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

async function withUdpSink(fn) {
  const sink = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    sink.once('error', reject);
    sink.bind(0, '127.0.0.1', () => resolve());
  });
  const port = sink.address().port;
  try {
    await fn(port, sink);
  } finally {
    await new Promise((resolve) => sink.close(() => resolve()));
  }
}

async function main() {
  console.log('SPECTRE transport parity (Pelco-D RS-485 ↔ UDP)\n');
  let pelco;
  let PortManager;
  try {
    ({ pelco, PortManager } = await loadDist());
  } catch (err) {
    fail('load server dist', String(err));
    console.log('\nRun: npm run server:build');
    process.exit(1);
  }

  const addr = 1;
  const expected = {
    stop: hexOf(pelco.stopCommand(addr)),
    queryPan: hexOf(pelco.queryPan(addr)),
    queryTilt: hexOf(pelco.queryTilt(addr)),
    jogRight: hexOf(pelco.moveCommand(addr, { right: true }, 48, 32)),
    jogUp: hexOf(pelco.moveCommand(addr, { up: true }, 0, 32)),
    setPreset1: hexOf(pelco.setPreset(addr, 1)),
    callPreset1: hexOf(pelco.callPreset(addr, 1)),
  };

  assert('canonical stop length 7', pelco.stopCommand(addr).length === 7, expected.stop);
  assert('canonical stop sync FF', pelco.stopCommand(addr)[0] === 0xff);

  await withUdpSink(async (udpPort) => {
    const pm = new PortManager();
    const captured = [];
    pm.on('tx', (hex) => captured.push(String(hex).toLowerCase().replace(/\s+/g, ' ').trim()));

    const pathUdp = `udp://127.0.0.1:${udpPort}`;
    await pm.open(pathUdp, 9600);
    const st = pm.getStatus();
    assert('UDP open connected', st.connected === true, st.path);
    assert('UDP transport flag', st.transport === 'udp');

    const frames = [
      ['stop', pelco.stopCommand(addr)],
      ['queryPan', pelco.queryPan(addr)],
      ['queryTilt', pelco.queryTilt(addr)],
      ['jogRight', pelco.moveCommand(addr, { right: true }, 48, 32)],
      ['jogUp', pelco.moveCommand(addr, { up: true }, 0, 32)],
      ['setPreset1', pelco.setPreset(addr, 1)],
      ['callPreset1', pelco.callPreset(addr, 1)],
    ];

    for (const [name, bytes] of frames) {
      captured.length = 0;
      await pm.write(bytes);
      const got = (captured[0] || '').toLowerCase();
      const want = expected[name].toLowerCase();
      assert(`UDP tx ${name} matches Pelco-D builder`, got === want, `got=${got} want=${want}`);
    }

    // Second write without a peer listener still must not throw (parity with "open then command").
    await pm.close();
    const pm2 = new PortManager();
    await pm2.open('udp://127.0.0.1:39999', 9600);
    let threw = false;
    try {
      await pm2.write(pelco.stopCommand(addr));
    } catch (err) {
      threw = true;
      fail('UDP write offline peer', String(err));
    }
    if (!threw) pass('UDP write offline peer', 'send accepted');
    await pm2.close();
  });

  // Builder identity: same helpers feed both transports — document intentional gap difference only.
  assert(
    'moveCommand tilt-only mirrors pan speed byte',
    pelco.moveCommand(addr, { up: true }, 0, 32)[4] === 32,
  );

  const failed = results.filter((r) => !r.ok).length;
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== TRANSPORT PARITY SUMMARY ===`);
  console.log(`${passed}/${results.length} passed`);
  if (failed) {
    console.log(`${failed} failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
