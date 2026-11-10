import { SerialPort } from 'serialport';
import dgram from 'node:dgram';
import { EventEmitter } from 'events';
import { PelcoParser, toHex } from './pelcoD';

export type PortInfo = {
  path: string;
  manufacturer?: string;
  friendlyName?: string;
  vendorId?: string;
  productId?: string;
  pnpId?: string;
};

export type SerialStatus = {
  connected: boolean;
  path: string | null;
  baudRate: number;
  error?: string;
  transport?: 'serial' | 'udp';
};

const WRITE_TIMEOUT_MS = 2000;
/** Minimum quiet time between Pelco frames — CH340 + these heads choke if flooded. */
const FRAME_GAP_MS = 18;
/** UDP can take a slightly tighter gap; still avoid flooding the servo NIC. */
const UDP_FRAME_GAP_MS = 12;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse `udp://host:port` (port optional, default 6666). */
export function parseUdpPath(path: string): { host: string; port: number } | null {
  const m = /^udp:\/\/([^:/]+)(?::(\d+))?\/?$/i.exec(path.trim());
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : 6666;
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

export function formatUdpPath(host: string, port: number): string {
  return `udp://${host}:${port}`;
}

export class PortManager extends EventEmitter {
  private port: SerialPort | null = null;
  private udp: dgram.Socket | null = null;
  private udpPeer: { host: string; port: number } | null = null;
  private transport: 'serial' | 'udp' = 'serial';
  private parser = new PelcoParser();
  private baudRate = 9600;
  private path: string | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private lastWriteAt = 0;
  private broken = false;

  static async listPorts(): Promise<PortInfo[]> {
    const ports = await SerialPort.list();
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      friendlyName: (p as { friendlyName?: string }).friendlyName || p.path,
      vendorId: p.vendorId,
      productId: p.productId,
      pnpId: p.pnpId,
    }));
  }

  getStatus(): SerialStatus {
    const connected =
      this.transport === 'udp'
        ? !!this.udp && !this.broken
        : !!(this.port && this.port.isOpen) && !this.broken;
    return {
      connected,
      path: this.path,
      baudRate: this.baudRate,
      transport: this.transport,
      error: this.broken ? 'port fault — reconnecting' : undefined,
    };
  }

  async open(path: string, baudRate: number): Promise<void> {
    await this.close();
    this.baudRate = baudRate;
    this.path = path;
    this.broken = false;
    this.parser.reset();
    this.writeChain = Promise.resolve();
    this.lastWriteAt = 0;

    const udp = parseUdpPath(path);
    if (udp) {
      await this.openUdp(udp.host, udp.port);
      return;
    }
    await this.openSerial(path, baudRate);
  }

  private async openUdp(host: string, port: number): Promise<void> {
    this.transport = 'udp';
    this.udpPeer = { host, port };
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp = socket;

    socket.on('message', (buf) => {
      const bytes = new Uint8Array(buf);
      this.emit('rx', toHex(bytes), bytes);
      for (const chunk of this.parser.push(bytes)) {
        if (chunk.type === 'position') this.emit('position', chunk.value);
        if (chunk.type === 'frame') this.emit('frame', chunk.bytes);
      }
    });

    socket.on('error', (err) => {
      this.emit('error', err);
      void this.fault(err);
    });

    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error) => reject(err);
      socket.once('error', onErr);
      socket.bind(0, () => {
        socket.off('error', onErr);
        try {
          socket.setBroadcast(true);
        } catch {
          /* optional */
        }
        this.emit('status', this.getStatus());
        resolve();
      });
    });
  }

  private async openSerial(path: string, baudRate: number): Promise<void> {
    this.transport = 'serial';
    this.udpPeer = null;

    await new Promise<void>((resolve, reject) => {
      const port = new SerialPort(
        {
          path,
          baudRate,
          dataBits: 8,
          parity: 'none',
          stopBits: 1,
          autoOpen: false,
        },
        (err) => {
          if (err) reject(err);
        },
      );

      port.on('data', (buf: Buffer) => {
        const bytes = new Uint8Array(buf);
        this.emit('rx', toHex(bytes), bytes);
        for (const chunk of this.parser.push(bytes)) {
          if (chunk.type === 'position') this.emit('position', chunk.value);
          if (chunk.type === 'frame') this.emit('frame', chunk.bytes);
        }
      });

      port.on('error', (err) => {
        this.emit('error', err);
        void this.fault(err);
      });

      port.on('close', () => {
        if (this.port === port) this.port = null;
        this.emit('status', this.getStatus());
      });

      port.open((err) => {
        if (err) {
          reject(err);
          return;
        }
        this.port = port;
        this.emit('status', this.getStatus());
        resolve();
      });
    });
  }

  /** Mark port dead, drop handle, clear write queue — watchdog will reconnect. */
  private async fault(err: unknown): Promise<void> {
    if (this.broken) return;
    this.broken = true;
    this.emit('error', err instanceof Error ? err : new Error(String(err)));
    this.writeChain = Promise.resolve();
    const port = this.port;
    const udp = this.udp;
    this.port = null;
    this.udp = null;
    this.parser.reset();
    try {
      if (port?.isOpen) {
        await new Promise<void>((resolve) => port.close(() => resolve()));
      }
    } catch {
      /* ignore */
    }
    try {
      udp?.close();
    } catch {
      /* ignore */
    }
    this.emit('status', this.getStatus());
  }

  async close(): Promise<void> {
    const port = this.port;
    const udp = this.udp;
    this.port = null;
    this.udp = null;
    this.udpPeer = null;
    this.path = null;
    this.broken = false;
    this.parser.reset();
    this.writeChain = Promise.resolve();
    this.lastWriteAt = 0;
    if (!port && !udp) {
      this.emit('status', this.getStatus());
      return;
    }
    if (port) {
      await new Promise<void>((resolve) => {
        if (!port.isOpen) {
          resolve();
          return;
        }
        port.close(() => resolve());
      });
    }
    if (udp) {
      await new Promise<void>((resolve) => {
        try {
          udp.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
    this.emit('status', this.getStatus());
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.transport === 'udp') {
      await this.writeUdp(bytes);
      return;
    }
    await this.writeSerial(bytes);
  }

  private async writeUdp(bytes: Uint8Array): Promise<void> {
    const socket = this.udp;
    const peer = this.udpPeer;
    if (!socket || !peer || this.broken) {
      throw new Error('UDP transport is not open');
    }
    const run = this.writeChain.then(async () => {
      if (!this.udp || this.udp !== socket || !this.udpPeer || this.broken) {
        throw new Error('UDP transport is not open');
      }
      const gap = UDP_FRAME_GAP_MS - (Date.now() - this.lastWriteAt);
      if (gap > 0) await delay(gap);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`UDP write timeout after ${WRITE_TIMEOUT_MS}ms`)), WRITE_TIMEOUT_MS);
        this.emit('tx', toHex(bytes), bytes);
        socket.send(Buffer.from(bytes), peer.port, peer.host, (err) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        });
      });
      this.lastWriteAt = Date.now();
    });

    this.writeChain = run.catch(() => undefined);
    try {
      await run;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timeout|not open|EHOSTUNREACH|ENETUNREACH|ECONNRESET/i.test(msg)) {
        void this.fault(err);
      }
      throw err;
    }
  }

  private async writeSerial(bytes: Uint8Array): Promise<void> {
    if (!this.port || !this.port.isOpen || this.broken) {
      throw new Error('Serial port is not open');
    }
    const port = this.port;
    const run = this.writeChain.then(async () => {
      if (!this.port || this.port !== port || !port.isOpen || this.broken) {
        throw new Error('Serial port is not open');
      }
      const gap = FRAME_GAP_MS - (Date.now() - this.lastWriteAt);
      if (gap > 0) await delay(gap);

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`serial write timeout after ${WRITE_TIMEOUT_MS}ms`));
        }, WRITE_TIMEOUT_MS);

        this.emit('tx', toHex(bytes), bytes);
        port.write(Buffer.from(bytes), (err) => {
          if (err) {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(err);
            }
            return;
          }
          port.drain((drainErr) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (drainErr) reject(drainErr);
            else resolve();
          });
        });
      });

      this.lastWriteAt = Date.now();
    });

    this.writeChain = run.catch(() => undefined);
    try {
      await run;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timeout|cannot write|access denied|disconnected|not open/i.test(msg)) {
        void this.fault(err);
      }
      throw err;
    }
  }
}
