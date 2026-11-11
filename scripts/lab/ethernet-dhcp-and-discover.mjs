/**
 * Mini DHCP server + Pelco-D UDP discovery on the Ethernet link.
 * Offers 10.55.55.50 to the first DHCP client (the turntable).
 * Then probes that host (and common static IPs) with Pelco-D UDP.
 *
 * Run elevated if bind to :67 fails:
 *   node scripts/ethernet-dhcp-and-discover.mjs
 */
import dgram from 'node:dgram';
import os from 'node:os';

const SERVER_IP = process.env.SPECTRE_ETH_IP || '10.55.55.1';
const OFFER_IP = process.env.SPECTRE_PTZ_IP || '10.55.55.50';
const MASK = '255.255.255.0';
const LEASE_SECS = 3600;
const EXTRA_PORT = Number(process.env.SPECTRE_UDP_PORT || 0);
const UDP_PORTS = [
  6666, 4000, 5000, 6000, 8000, 8080, 9000, 2300, 4567, 3782, 2000, 3000,
  ...(Number.isFinite(EXTRA_PORT) && EXTRA_PORT > 0 ? [EXTRA_PORT] : []),
];

function ipToBuf(ip) {
  return Buffer.from(ip.split('.').map((x) => Number(x) & 0xff));
}

function checksum(bytes) {
  let s = 0;
  for (let i = 1; i <= 5; i++) s += bytes[i];
  return s % 256;
}

function pelco(addr, cmd2, d1 = 0, d2 = 0) {
  const b = Uint8Array.of(0xff, addr & 0xff, 0x00, cmd2 & 0xff, d1 & 0xff, d2 & 0xff, 0);
  b[6] = checksum(b);
  return Buffer.from(b);
}

function parseDhcpOptions(buf) {
  const opts = new Map();
  let i = 240; // after magic cookie at 236..239
  if (buf.length < 240) return opts;
  while (i < buf.length) {
    const code = buf[i++];
    if (code === 0xff) break;
    if (code === 0x00) continue;
    const len = buf[i++];
    opts.set(code, buf.subarray(i, i + len));
    i += len;
  }
  return opts;
}

function buildDhcpReply(req, msgType /* 2=OFFER 5=ACK */) {
  const reply = Buffer.alloc(300, 0);
  reply[0] = 2; // BOOTREPLY
  reply[1] = req[1]; // htype
  reply[2] = req[2]; // hlen
  reply[3] = 0;
  req.copy(reply, 4, 4, 8); // xid
  reply[10] = 0x80; // broadcast flag
  // yiaddr
  ipToBuf(OFFER_IP).copy(reply, 16);
  // siaddr
  ipToBuf(SERVER_IP).copy(reply, 20);
  // chaddr
  req.copy(reply, 28, 28, 44);
  // magic
  reply[236] = 99;
  reply[237] = 130;
  reply[238] = 83;
  reply[239] = 99;
  let o = 240;
  const put = (code, data) => {
    reply[o++] = code;
    reply[o++] = data.length;
    data.copy(reply, o);
    o += data.length;
  };
  put(53, Buffer.from([msgType]));
  put(54, ipToBuf(SERVER_IP));
  put(51, Buffer.from([(LEASE_SECS >>> 24) & 0xff, (LEASE_SECS >>> 16) & 0xff, (LEASE_SECS >>> 8) & 0xff, LEASE_SECS & 0xff]));
  put(1, ipToBuf(MASK));
  put(3, ipToBuf(SERVER_IP)); // gateway = us (optional)
  put(6, ipToBuf(SERVER_IP)); // dns = us
  reply[o++] = 0xff;
  return reply.subarray(0, Math.max(o, 300));
}

const clients = new Map();
const replies = [];

console.log('[eth] interfaces:');
for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
  for (const a of addrs || []) {
    if (a.family === 'IPv4') console.log(`  ${name}: ${a.address}`);
  }
}
console.log(`[eth] DHCP server ${SERVER_IP} offering ${OFFER_IP}`);

const dhcp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
dhcp.on('error', (e) => {
  console.error(`[dhcp] ${e.message}`);
  console.error('[dhcp] Re-run this script from an elevated PowerShell if port 67 is blocked.');
});
dhcp.on('message', (msg, rinfo) => {
  if (msg.length < 240 || msg[0] !== 1) return;
  const opts = parseDhcpOptions(msg);
  const t = opts.get(53)?.[0];
  const mac = [...msg.subarray(28, 28 + (msg[2] || 6))].map((b) => b.toString(16).padStart(2, '0')).join(':');
  const name = t === 1 ? 'DISCOVER' : t === 3 ? 'REQUEST' : `type=${t}`;
  console.log(`[dhcp] ${name} from ${rinfo.address} mac=${mac}`);
  clients.set(mac, { at: Date.now(), ip: OFFER_IP });
  const reply = buildDhcpReply(msg, t === 3 ? 5 : 2);
  // Broadcast reply
  dhcp.send(reply, 68, '255.255.255.255', (err) => {
    if (err) console.log(`[dhcp] send err ${err.message}`);
    else console.log(`[dhcp] sent ${t === 3 ? 'ACK' : 'OFFER'} ${OFFER_IP} → ${mac}`);
  });
});

await new Promise((resolve, reject) => {
  dhcp.bind(67, SERVER_IP, (err) => (err ? reject(err) : resolve()));
});
dhcp.setBroadcast(true);
console.log(`[dhcp] listening ${SERVER_IP}:67 — plug/power the turntable now`);

const tx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
await new Promise((resolve, reject) => {
  tx.bind(0, SERVER_IP, (err) => (err ? reject(err) : resolve()));
});
tx.setBroadcast(true);
tx.on('message', (msg, rinfo) => {
  const line = `RX ${rinfo.address}:${rinfo.port} ${msg.toString('hex')}`;
  console.log(`[udp] ${line}`);
  replies.push({ ...rinfo, hex: msg.toString('hex'), at: Date.now() });
});

const listeners = [];
for (const p of UDP_PORTS) {
  try {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('message', (msg, rinfo) => {
      console.log(`[udp:${p}] RX ${rinfo.address}:${rinfo.port} ${msg.toString('hex')}`);
      replies.push({ address: rinfo.address, port: rinfo.port, localPort: p, hex: msg.toString('hex'), at: Date.now() });
    });
    s.on('error', () => undefined);
    await new Promise((resolve, reject) => s.bind(p, SERVER_IP, (err) => (err ? reject(err) : resolve())));
    s.setBroadcast(true);
    listeners.push(s);
    console.log(`[udp] listen ${SERVER_IP}:${p}`);
  } catch (e) {
    console.log(`[udp] skip :${p} (${e.message})`);
  }
}

const frames = [pelco(1, 0x51), pelco(1, 0x53), pelco(1, 0x00)];
const staticTargets = [
  OFFER_IP,
  '192.168.8.200',
  '192.168.8.255',
  '10.55.55.255',
  '192.168.1.64',
  '192.168.1.168',
  '192.168.1.10',
  '192.168.1.108',
  '192.168.1.200',
  '192.168.1.88',
  '255.255.255.255',
];

let n = 0;
const iv = setInterval(() => {
  n += 1;
  const hosts = [...staticTargets];
  for (const c of clients.values()) if (!hosts.includes(c.ip)) hosts.push(c.ip);
  for (const host of hosts) {
    for (const port of UDP_PORTS) {
      for (const f of frames) tx.send(f, port, host);
    }
  }
  if (n === 1 || n % 10 === 0) console.log(`[udp] probe round ${n}; dhcp clients=${clients.size}; replies=${replies.length}`);
}, 2000);

console.log('[eth] running 90s — leave cable connected; power-cycle turntable if needed');
await new Promise((r) => setTimeout(r, 90000));
clearInterval(iv);
dhcp.close();
tx.close();
for (const s of listeners) s.close();

console.log('--- summary ---');
console.log(`DHCP clients: ${clients.size}`);
for (const [mac, c] of clients) console.log(`  ${mac} → ${c.ip}`);
console.log(`UDP replies: ${replies.length}`);
for (const r of replies.slice(0, 20)) console.log(`  ${r.address}:${r.port} ${r.hex}`);
if (clients.size === 0 && replies.length === 0) {
  console.log('No DHCP and no UDP. Check: turntable powered (DC24V), RJ45 seated in BOTTOM network port, link lights.');
  process.exitCode = 2;
} else if (replies.length) {
  const hit = replies[0];
  console.log(`LIKELY ENDPOINT: udp://${hit.address}:${hit.port ?? '????'}`);
}
