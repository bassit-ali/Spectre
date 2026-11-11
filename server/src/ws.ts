import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { SpectreService, OutMessage } from './service';

export type Endpoint = { host: string; port: number; url: string; wsUrl: string };

type InMessage = { type: string; payload?: any; id?: string | number };

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Browsers always attach Origin to WebSocket handshakes. Reject anything that is
 * not served from this machine so random web pages can't drive the motors.
 */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (CLI, tests)
  const extra = (process.env.SPECTRE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes(origin)) return true;
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** Drop outbound pushes once a client stops reading — prevents server OOM. */
const MAX_BUFFERED_BYTES = 256 * 1024;
const DROP_UNDER_PRESSURE = new Set([
  'serial.tx',
  'serial.rx',
  'system.health',
  'pose',
  'log',
]);

export function attachWebSocket(server: Server, svc: SpectreService, endpoint: Endpoint): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      /* ignore */
    }
    if (pathname !== '/ws' || !originAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = (ws: WebSocket, msg: OutMessage & { id?: unknown }): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      if (DROP_UNDER_PRESSURE.has(msg.type)) return;
      // Critical path still blocked — terminate the stuck client so HTTP can breathe.
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(msg));
  };

  const broadcast = (msg: OutMessage): void => {
    const text = JSON.stringify(msg);
    for (const c of wss.clients) {
      if (c.readyState !== WebSocket.OPEN) continue;
      if (c.bufferedAmount > MAX_BUFFERED_BYTES) {
        if (DROP_UNDER_PRESSURE.has(msg.type)) continue;
        c.terminate();
        continue;
      }
      c.send(text);
    }
  };

  svc.on('out', broadcast);
  svc.setWsJanitor(() => {
    let dropped = 0;
    for (const c of wss.clients) {
      if (c.readyState === WebSocket.OPEN && c.bufferedAmount > MAX_BUFFERED_BYTES) {
        c.terminate();
        dropped += 1;
      }
    }
    return dropped;
  });

  wss.on('connection', (ws) => {
    alive.set(ws, true);
    svc.clients = wss.clients.size;
    svc.log('info', `client connected (${svc.clients})`);

    send(ws, { type: 'system.endpoint', payload: endpoint });
    for (const m of svc.snapshot()) send(ws, m);
    for (const entry of svc.recentLogs()) send(ws, { type: 'log', payload: entry });

    ws.on('pong', () => alive.set(ws, true));
    ws.on('message', (data) => {
      alive.set(ws, true);
      void handle(ws, data.toString());
    });
    ws.on('close', () => {
      svc.clients = wss.clients.size;
      svc.log('info', `client disconnected (${svc.clients})`);
      if (svc.clients === 0) svc.onAllClientsGone();
    });
    ws.on('error', () => undefined);
  });

  async function handle(ws: WebSocket, text: string): Promise<void> {
    let msg: InMessage;
    try {
      msg = JSON.parse(text);
      if (!msg || typeof msg.type !== 'string') throw new Error('missing type');
    } catch (err) {
      send(ws, { type: 'ack', payload: { ok: false, reqType: null, error: `bad message: ${String(err)}` } });
      return;
    }
    const reqId = msg.id;
    try {
      const data = await dispatch(msg.type, msg.payload ?? {});
      if (data !== NO_ACK) {
        send(ws, { type: 'ack', payload: { id: reqId, reqType: msg.type, ok: true, data } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send(ws, { type: 'ack', payload: { id: reqId, reqType: msg.type, ok: false, error: message } });
      svc.log('warn', `${msg.type} failed: ${message}`);
    }
  }

  const NO_ACK = Symbol('no-ack');

  async function dispatch(type: string, p: any): Promise<unknown> {
    // Accept both server wire names and UI-friendly aliases.
    const aliases: Record<string, string> = {
      hello: 'ping',
      jog: 'motion.jog',
      stop: 'motion.stop',
      halt: 'motion.stop',
      home: 'motion.home',
      goto: 'motion.goto',
      'pose.refresh': 'motion.refresh',
      'presets.get': 'preset.list',
      'selftest.run': 'system.selfTest',
    };
    const t = aliases[type] ?? type;
    switch (t) {
      // ---- serial
      case 'serial.list': {
        const ports = await svc.listPorts();
        broadcast({ type: 'serial.ports', payload: ports });
        return ports;
      }
      case 'serial.status':
        return svc.serialStatus();
      case 'serial.connect': {
        const path = String(p.path ?? '');
        if (!path) throw new Error('path required');
        await svc.connect(path, Number(p.baudRate) || svc.config.value.baudRate);
        return svc.serialStatus();
      }
      case 'serial.autoConnect': {
        const used = await svc.autoConnect();
        if (!used) throw new Error('no serial port found');
        return svc.serialStatus();
      }
      case 'serial.disconnect':
        await svc.disconnect();
        return svc.serialStatus();

      // ---- motion
      case 'motion.jog':
        await svc.jog(p.flags ?? p);
        return {};
      case 'motion.stop':
        await svc.stop();
        return {};
      case 'motion.home':
        svc.home();
        return { accepted: true };
      case 'motion.goto':
        svc.gotoAbsolute(
          typeof p.pan === 'number' ? p.pan : undefined,
          typeof p.tilt === 'number' ? p.tilt : undefined,
        );
        return { accepted: true };
      case 'motion.refresh':
        return svc.refresh();
      case 'motion.pose':
        return svc.motion.getPose();

      // ---- presets
      case 'preset.list':
        return svc.presets();
      case 'preset.set':
        return svc.setPreset(p.id ?? p);
      case 'preset.call':
        svc.callPreset(p.id ?? p);
        return { accepted: true };
      case 'preset.clear':
        return svc.clearPreset(p.id ?? p);

      // ---- settings
      case 'settings.get':
        return svc.settingsView();
      case 'settings.update':
        return svc.updateSettings(p.patch ?? p);

      // ---- desktop widget (Electron pip-shell overlay)
      case 'widget.open':
        return svc.openDesktopWidget();
      case 'widget.close':
        await svc.closeDesktopWidget();
        return { ok: true };

      // ---- system
      case 'system.selfTest':
        return svc.runBit('manual');
      case 'system.health':
        return svc.health();
      case 'ping':
        return { t: typeof p.t === 'number' ? p.t : Date.now(), ts: Date.now() };
      default:
        throw new Error(`unknown message type: ${type}`);
    }
  }

  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 15000);
  wss.on('close', () => clearInterval(hb));

  return wss;
}
