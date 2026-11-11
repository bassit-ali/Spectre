/**
 * Discover Pelco-D-over-UDP turntable on the direct Ethernet link.
 * Binds listeners on common ports, broadcasts query frames, logs replies.
 *
 * Usage: node scripts/lab/discover-udp-ptz.mjs [bindIp]
 * Env: SPECTRE_ETH_IP (bind), SPECTRE_PTZ_IP (extra unicast target), SPECTRE_UDP_PORT (extra port)
 * Default bind: 10.55.55.1 (isolated NIC) — factory head seed is often 192.168.8.200:6666
 */
import dgram from 'node:dgram';
import os from 'node:os';

const BIND = process.argv[2] || process.env.SPECTRE_ETH_IP || '10.55.55.1';
const EXTRA_PORT = Number(process.env.SPECTRE_UDP_PORT || 0);
const PORTS = [
  6666, 4000, 5000, 6000, 8000, 8080, 9000, 2300, 4567, 3782, 1024, 1025, 2000, 3000, 3702, 47808,
  ...(Number.isFinite(EXTRA_PORT) && EXTRA_PORT > 0 ? [EXTRA_PORT] : []),
];
const TARGETS = [
  '192.168.8.200',
  '192.168.8.255',
  '10.55.55.255',
  '10.55.55.50',
  '10.55.55.2',
  '192.168.1.64',
  '192.168.1.168',
  '192.168.1.10',
  '192.168.1.108',
  '192.168.1.200',
  '192.168.1.88',
  '192.168.0.64',
  '192.168.0.168',
  '255.255.255.255',
  ...(process.env.SPECTRE_PTZ_IP ? [process.env.SPECTRE_PTZ_IP] : []),
];

function checksum(bytes) {
  let s = 0;
  for (let i = 1; i <= 5; i++) s += bytes[i];
  return s % 256;
}

function pelcoQueryPan(addr = 1) {
  const b = Uint8Array.of(0xff, addr & 0xff, 0x00, 0x51, 0x00, 0x00, 0);
  b[6] = checksum(b);
  return Buffer.from(b);
}

function pelcoQueryTilt(addr = 1) {
  const b = Uint8Array.of(0xff, addr & 0xff, 0x00, 0x53, 0x00, 0x00, 0);
  b[6] = checksum(b);
  return Buffer.from(b);
}

function pelcoStop(addr = 1) {
  const b = Uint8Array.of(0xff, addr & 0xff, 0x00, 0x00, 0x00, 0x00, 0);
  b[6] = checksum(b);
  return Buffer.from(b);
}

const frames = [pelcoQueryPan(1), pelcoQueryTilt(1), pelcoStop(1)];

console.log(`[discover] host ifaces:`);
for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
  for (const a of addrs || []) {
    if (a.family === 'IPv4') console.log(`  ${name}: ${a.address}`);
  }
}
console.log(`[discover] bind=${BIND}`);

const sockets = [];
const seen = new Set();

function onMsg(port) {
  return (msg, rinfo) => {
    const key = `${rinfo.address}:${rinfo.port}->${port} ${msg.toString('hex')}`;
    if (seen.has(key)) return;
    seen.add(key);
    console.log(`[RX] from ${rinfo.address}:${rinfo.port} on local :${port}  ${msg.length}B  ${msg.toString('hex')}`);
  };
}

async function listen(port) {
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sockets.push(s);
  s.on('message', onMsg(port));
  s.on('error', (e) => console.log(`[listen:${port}] ${e.message}`));
  await new Promise((resolve, reject) => {
    s.bind(port, BIND, (err) => (err ? reject(err) : resolve()));
  });
  try {
    s.setBroadcast(true);
  } catch {
    /* ignore */
  }
  console.log(`[listen] ${BIND}:${port}`);
  return s;
}

async function main() {
  // Prefer a dedicated TX socket so we don't fight listener binds
  const tx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sockets.push(tx);
  await new Promise((resolve, reject) => {
    tx.bind(0, BIND, (err) => (err ? reject(err) : resolve()));
  });
  tx.setBroadcast(true);
  tx.on('message', onMsg('tx'));

  for (const p of PORTS) {
    try {
      await listen(p);
    } catch (e) {
      console.log(`[listen:${p}] skip: ${e.message}`);
    }
  }

  let round = 0;
  const tick = () => {
    round += 1;
    for (const host of TARGETS) {
      for (const port of PORTS) {
        for (const frame of frames) {
          tx.send(frame, port, host, (err) => {
            if (err && round === 1) console.log(`[TX err] ${host}:${port} ${err.message}`);
          });
        }
      }
    }
    if (round === 1 || round % 5 === 0) console.log(`[TX] round ${round} — ${TARGETS.length} hosts × ${PORTS.length} ports`);
  };

  tick();
  const iv = setInterval(tick, 1500);
  console.log('[discover] probing 45s — power-cycle / reconnect cable if silent');
  await new Promise((r) => setTimeout(r, 45000));
  clearInterval(iv);
  for (const s of sockets) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  console.log(`[discover] done. unique replies: ${seen.size}`);
  if (seen.size === 0) {
    console.log('[discover] no UDP replies. Device may need DHCP — next step: mini DHCP on 10.55.55.0/24');
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
