/** Quick post-power-cycle probe: DHCP listen + UDP Pelco-D + ARP-ish ping via OS. */
import dgram from 'node:dgram';
import { execSync } from 'node:child_process';

const SERVER_IP = '10.55.55.1';
const OFFER_IP = '10.55.55.50';
const PORTS = [6666, 4000, 5000, 6000, 8000, 8080, 9000, 2300, 4567];
const SECONDS = 25;

function checksum(b) {
  let s = 0;
  for (let i = 1; i <= 5; i++) s += b[i];
  return s % 256;
}
function pelco(cmd2) {
  const b = Uint8Array.of(0xff, 1, 0x00, cmd2, 0, 0, 0);
  b[6] = checksum(b);
  return Buffer.from(b);
}
function ipBuf(ip) {
  return Buffer.from(ip.split('.').map((x) => Number(x)));
}

const foreign = [];
const dhcpMacs = new Set();

const dhcp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
dhcp.on('message', (msg, rinfo) => {
  if (msg[0] !== 1 || msg.length < 240) return;
  const mac = [...msg.subarray(28, 34)].map((x) => x.toString(16).padStart(2, '0')).join(':');
  dhcpMacs.add(mac);
  console.log(`[dhcp] from ${rinfo.address} mac=${mac}`);
  // minimal OFFER
  const reply = Buffer.alloc(300, 0);
  reply[0] = 2;
  reply[1] = msg[1];
  reply[2] = msg[2];
  msg.copy(reply, 4, 4, 8);
  reply[10] = 0x80;
  ipBuf(OFFER_IP).copy(reply, 16);
  ipBuf(SERVER_IP).copy(reply, 20);
  msg.copy(reply, 28, 28, 44);
  reply[236] = 99; reply[237] = 130; reply[238] = 83; reply[239] = 99;
  let o = 240;
  const put = (c, d) => { reply[o++] = c; reply[o++] = d.length; d.copy(reply, o); o += d.length; };
  put(53, Buffer.from([2]));
  put(54, ipBuf(SERVER_IP));
  put(1, ipBuf('255.255.255.0'));
  put(51, Buffer.from([0, 0, 0x0e, 0x10]));
  reply[o++] = 0xff;
  dhcp.send(reply, 68, '255.255.255.255');
});

await new Promise((res, rej) => dhcp.bind(67, SERVER_IP, (e) => (e ? rej(e) : res())));
dhcp.setBroadcast(true);

const tx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
await new Promise((res, rej) => tx.bind(0, SERVER_IP, (e) => (e ? rej(e) : res())));
tx.setBroadcast(true);
tx.on('message', (msg, rinfo) => {
  if (rinfo.address === SERVER_IP || rinfo.address === '192.168.1.100') return;
  foreign.push({ addr: rinfo.address, port: rinfo.port, hex: msg.toString('hex') });
  console.log(`[udp] FOREIGN ${rinfo.address}:${rinfo.port} ${msg.toString('hex')}`);
});

const listeners = [];
for (const p of PORTS) {
  try {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('message', (msg, rinfo) => {
      if (rinfo.address === SERVER_IP || rinfo.address === '192.168.1.100') return;
      foreign.push({ addr: rinfo.address, port: rinfo.port, hex: msg.toString('hex'), local: p });
      console.log(`[udp:${p}] FOREIGN ${rinfo.address}:${rinfo.port} ${msg.toString('hex')}`);
    });
    await new Promise((res, rej) => s.bind(p, SERVER_IP, (e) => (e ? rej(e) : res())));
    s.setBroadcast(true);
    listeners.push(s);
  } catch { /* skip */ }
}

const frames = [pelco(0x51), pelco(0x53), pelco(0x00)];
const hosts = ['10.55.55.255', OFFER_IP, '192.168.1.64', '192.168.1.168', '192.168.1.10', '192.168.1.108', '255.255.255.255'];
let n = 0;
const iv = setInterval(() => {
  n++;
  for (const h of hosts) for (const p of PORTS) for (const f of frames) tx.send(f, p, h);
  if (n === 1 || n % 5 === 0) console.log(`[probe] round ${n} dhcp=${dhcpMacs.size} foreign=${foreign.length}`);
}, 1500);

console.log(`[probe] ${SECONDS}s on ${SERVER_IP} — waiting for turntable`);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(iv);
dhcp.close(); tx.close(); for (const s of listeners) s.close();

let arp = '';
try {
  arp = execSync('powershell -NoProfile -Command "Get-NetNeighbor -InterfaceAlias Ethernet -AddressFamily IPv4 | Where-Object { $_.State -match \'Reachable|Stale|Delay|Probe\' } | Format-Table IPAddress,LinkLayerAddress,State -AutoSize | Out-String"', { encoding: 'utf8' });
} catch { arp = '(arp failed)'; }

console.log('--- RESULT ---');
console.log(`dhcp_clients=${dhcpMacs.size} foreign_udp=${foreign.length}`);
console.log(arp.trim() || '(no reachable ARP neighbors)');
if (foreign.length) console.log(`endpoint=udp://${foreign[0].addr}:${foreign[0].port}`);
else if (dhcpMacs.size) console.log(`dhcp_ok offer=${OFFER_IP} but no Pelco UDP yet`);
else {
  console.log('NO_DEVICE');
  process.exitCode = 2;
}
