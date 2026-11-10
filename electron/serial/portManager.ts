import { SerialPort } from 'serialport';
import { EventEmitter } from 'events';
import { PelcoParser, toHex } from '../protocol/pelcoD';

export type PortInfo = {
  path: string;
  manufacturer?: string;
  friendlyName?: string;
};

export type SerialStatus = {
  connected: boolean;
  path: string | null;
  baudRate: number;
  error?: string;
};

export class PortManager extends EventEmitter {
  private port: SerialPort | null = null;
  private parser = new PelcoParser();
  private baudRate = 9600;
  private path: string | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  static async listPorts(): Promise<PortInfo[]> {
    const ports = await SerialPort.list();
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      friendlyName: (p as { friendlyName?: string }).friendlyName || p.path,
    }));
  }

  getStatus(): SerialStatus {
    return {
      connected: !!(this.port && this.port.isOpen),
      path: this.path,
      baudRate: this.baudRate,
    };
  }

  async open(path: string, baudRate: number): Promise<void> {
    await this.close();
    this.baudRate = baudRate;
    this.path = path;
    this.parser.reset();

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
        this.emit('status', this.getStatus());
      });

      port.on('close', () => {
        this.port = null;
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

  async close(): Promise<void> {
    const port = this.port;
    this.port = null;
    this.path = null;
    this.parser.reset();
    if (!port) {
      this.emit('status', this.getStatus());
      return;
    }
    await new Promise<void>((resolve) => {
      if (!port.isOpen) {
        resolve();
        return;
      }
      port.close(() => resolve());
    });
    this.emit('status', this.getStatus());
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.port || !this.port.isOpen) {
      throw new Error('Serial port is not open');
    }
    const port = this.port;
    this.writeChain = this.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.emit('tx', toHex(bytes), bytes);
          port.write(Buffer.from(bytes), (err) => {
            if (err) reject(err);
            else port.drain((drainErr) => (drainErr ? reject(drainErr) : resolve()));
          });
        }),
    );
    return this.writeChain;
  }
}
