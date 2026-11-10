import { LOCAL_WS } from './endpoint';

export type WsState = 'connecting' | 'open' | 'closed';
type Listener<T> = (v: T) => void;

type WireOut = { type: string; payload?: unknown; id?: string };
type WireIn = { type: string; payload?: any; id?: unknown; [key: string]: unknown };

const UI_TO_SERVER: Record<string, string> = {
  hello: 'ping',
  ping: 'ping',
  jog: 'motion.jog',
  stop: 'motion.stop',
  halt: 'motion.stop',
  home: 'motion.home',
  goto: 'motion.goto',
  'pose.refresh': 'motion.refresh',
  'preset.call': 'preset.call',
  'preset.set': 'preset.set',
  'preset.clear': 'preset.clear',
  'presets.get': 'preset.list',
  'serial.list': 'serial.list',
  'serial.connect': 'serial.connect',
  'serial.disconnect': 'serial.disconnect',
  'settings.get': 'settings.get',
  'settings.update': 'settings.update',
  'widget.opacity': 'settings.update',
  'widget.pinned': 'settings.update',
  'widget.visible': 'settings.update',
  'widget.open': 'widget.open',
  'widget.close': 'widget.close',
  'selftest.run': 'system.selfTest',
};

function toServer(msg: Record<string, unknown>): WireOut {
  const uiType = String(msg.type);
  const type = UI_TO_SERVER[uiType] ?? uiType;
  const id = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  if (uiType === 'jog') {
    return { type, id, payload: { flags: msg.flags, step: msg.step, mode: msg.mode } };
  }
  if (uiType === 'goto') {
    return { type, id, payload: { pan: msg.pan, tilt: msg.tilt } };
  }
  if (uiType.startsWith('preset.')) {
    return { type, id, payload: { id: msg.id } };
  }
  if (uiType === 'serial.connect') {
    return {
      type,
      id,
      payload: { path: msg.path, baudRate: msg.baudRate, address: msg.address },
    };
  }
  if (uiType === 'settings.update') {
    return { type, id, payload: { patch: msg.patch ?? msg } };
  }
  if (uiType === 'widget.opacity') {
    return { type, id, payload: { patch: { widgetOpacity: msg.opacity } } };
  }
  if (uiType === 'widget.pinned') {
    return { type, id, payload: { patch: { widgetPinned: msg.pinned } } };
  }
  if (uiType === 'widget.visible') {
    return { type, id, payload: { patch: { widgetVisible: msg.visible } } };
  }
  if (uiType === 'widget.open' || uiType === 'widget.close') {
    return { type, id, payload: {} };
  }
  if (uiType === 'ping' || uiType === 'hello') {
    return { type: 'ping', id, payload: { t: msg.t ?? performance.now() } };
  }
  if (uiType === 'stop' || uiType === 'halt' || uiType === 'home' || uiType === 'pose.refresh') {
    return { type, id, payload: {} };
  }
  if (uiType === 'serial.list' || uiType === 'serial.disconnect' || uiType === 'settings.get' || uiType === 'presets.get' || uiType === 'selftest.run') {
    return { type, id, payload: {} };
  }
  return { type, id, payload: msg };
}

/** Normalize server pushes into the flatter shapes the UI renderers expect. */
function normalizeIn(raw: WireIn): WireIn {
  const t = raw.type;
  const p = raw.payload;

  if (t === 'pose') {
    return { type: 'pose', ...(p && typeof p === 'object' ? p : {}) };
  }
  if (t === 'serial.status') {
    return { type: 'status', ...(p && typeof p === 'object' ? p : {}) };
  }
  if (t === 'serial.ports') {
    return { type: 'ports', ports: Array.isArray(p) ? p : p?.ports ?? [] };
  }
  if (t === 'presets' || t === 'presets.updated') {
    return {
      type: 'presets',
      presets: Array.isArray(p) ? p : p?.presets ?? [],
      active: p?.active ?? null,
    };
  }
  if (t === 'settings') {
    return { type: 'settings', settings: p && typeof p === 'object' && !('patch' in p) ? p : p };
  }
  if (t === 'system.bit') {
    const rawItems = Array.isArray(p?.checks) ? p.checks : Array.isArray(p?.steps) ? p.steps : Array.isArray(p?.items) ? p.items : [];
    const items = rawItems.map((s: any) => ({
      name: s.name ?? s.id ?? 'check',
      ok: s.ok !== false && s.status !== 'fail',
      detail: s.detail ?? s.message,
    }));
    const ok = p?.ok !== false && items.every((i: { ok: boolean }) => i.ok);
    return { type: 'selftest', ok, items };
  }
  if (t === 'ack' && p?.reqType === 'system.selfTest' && p?.ok && p?.data) {
    const data = p.data;
    const rawItems = Array.isArray(data?.checks) ? data.checks : Array.isArray(data?.steps) ? data.steps : [];
    const items = rawItems.map((s: any) => ({
      name: s.name ?? s.id ?? 'check',
      ok: s.ok !== false && s.status !== 'fail',
      detail: s.detail ?? s.message,
    }));
    return { type: 'selftest', ok: data?.ok !== false, items };
  }
  if (t === 'ack' && (p?.reqType === 'settings.get' || p?.reqType === 'settings.update') && p?.ok && p?.data) {
    return { type: 'settings', settings: p.data };
  }
  if (t === 'ack' && p?.reqType === 'preset.list' && p?.ok && Array.isArray(p?.data)) {
    return { type: 'presets', presets: p.data, active: null };
  }
  if (t === 'ack' && p?.reqType === 'ping' && p?.ok) {
    return { type: 'pong', t: typeof p.data?.t === 'number' ? p.data.t : performance.now() };
  }
  if (t === 'system.endpoint') {
    return { type: 'system.endpoint', payload: p };
  }
  if (t === 'encoderHealth') {
    return { type: 'encoderHealth', payload: p };
  }
  if (t === 'log') {
    return { type: 'log', payload: p };
  }
  if (t === 'error') {
    return { type: 'error', message: p?.message ?? String(p ?? 'error'), ref: p?.ref };
  }
  return raw;
}

/**
 * Auto-reconnecting WebSocket for ws://127.0.0.1:9000/ws.
 * Translates UI-friendly messages to the server {type,payload,id} contract.
 */
export class SpectreSocket {
  state: WsState = 'closed';
  latencyMs: number | null = null;

  private ws: WebSocket | null = null;
  private retry = 0;
  private retryTimer: number | undefined;
  private pingTimer: number | undefined;
  private stopped = false;
  private pendingPing = 0;

  private msgHandlers = new Map<string, Set<Listener<any>>>();
  private anyHandlers = new Set<Listener<any>>();
  private stateHandlers = new Set<Listener<WsState>>();
  private txHandlers = new Set<(m: Record<string, unknown>, sent: boolean) => void>();

  constructor(
    private readonly url: string = LOCAL_WS,
    private readonly hello?: Record<string, unknown>,
  ) {}

  connect(): void {
    this.stopped = false;
    this.open();
  }

  close(): void {
    this.stopped = true;
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.pingTimer);
    this.ws?.close();
  }

  send(msg: Record<string, unknown>): boolean {
    const wire = toServer(msg);
    const ok = this.ws?.readyState === WebSocket.OPEN;
    if (ok) this.ws!.send(JSON.stringify(wire));
    this.txHandlers.forEach((h) => h(msg, ok));
    return ok;
  }

  on(type: string, cb: Listener<any>): () => void {
    let set = this.msgHandlers.get(type);
    if (!set) this.msgHandlers.set(type, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }

  onAny(cb: Listener<any>): () => void {
    this.anyHandlers.add(cb);
    return () => this.anyHandlers.delete(cb);
  }

  onState(cb: Listener<WsState>): () => void {
    this.stateHandlers.add(cb);
    cb(this.state);
    return () => this.stateHandlers.delete(cb);
  }

  onTx(cb: (m: Record<string, unknown>, sent: boolean) => void): () => void {
    this.txHandlers.add(cb);
    return () => this.txHandlers.delete(cb);
  }

  private setState(s: WsState): void {
    this.state = s;
    this.stateHandlers.forEach((h) => h(s));
  }

  private open(): void {
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.retry = 0;
      this.setState('open');
      if (this.hello) this.send(this.hello);
      this.send({ type: 'settings.get' });
      this.send({ type: 'serial.list' });
      this.send({ type: 'presets.get' });
      this.startPing();
    });
    ws.addEventListener('message', (ev) => {
      let raw: WireIn;
      try {
        raw = JSON.parse(String(ev.data)) as WireIn;
      } catch {
        return;
      }
      const msg = normalizeIn(raw);
      if (msg.type === 'pong') {
        this.latencyMs = Math.max(0, Math.round(performance.now() - this.pendingPing));
      }
      if (raw.type === 'ack' && raw.payload?.reqType === 'ping' && raw.payload?.ok) {
        this.latencyMs = Math.max(0, Math.round(performance.now() - this.pendingPing));
        const pong = { type: 'pong', t: this.pendingPing };
        this.msgHandlers.get('pong')?.forEach((h) => h(pong));
        this.anyHandlers.forEach((h) => h(pong));
      }
      this.msgHandlers.get(msg.type)?.forEach((h) => h(msg));
      this.anyHandlers.forEach((h) => h(msg));
    });
    ws.addEventListener('close', () => {
      window.clearInterval(this.pingTimer);
      this.latencyMs = null;
      this.setState('closed');
      this.scheduleRetry();
    });
    ws.addEventListener('error', () => undefined);
  }

  private startPing(): void {
    window.clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.pendingPing = performance.now();
        this.send({ type: 'ping', t: this.pendingPing });
      }
    }, 4000);
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const delay = Math.min(5000, 800 + this.retry * 700);
    this.retry += 1;
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.open(), delay);
  }
}
