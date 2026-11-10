import { EventEmitter } from 'events';
import fs from 'fs';
import { PortManager, PortInfo } from '../shared/portManager';
import { MotionController, ControllerSettings, Pose } from '../shared/controller';
import { MoveFlags, PresetId, PRESET_IDS, queryPan, queryTilt } from '../shared/pelcoD';
import { AppConfig, ConfigStore, PresetMeta, snapLandingResolution } from './config';
import { PipShellManager } from './pipShell';

export type OutMessage = { type: string; payload?: unknown };

export type EncoderHealth = {
  healthy: boolean;
  lastPanAt: number | null;
  lastTiltAt: number | null;
  /** ms since the oldest of the two encoder replies (null = never). */
  ageMs: number | null;
  handshakeOk: boolean;
  lastHandshakeAt: number | null;
  failures: number;
  reason: string | null;
};

export type BitCheck = { name: string; ok: boolean; detail: string; optional?: boolean };
export type BitReport = {
  trigger: 'boot' | 'manual';
  ok: boolean;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  checks: BitCheck[];
};

export type LogEntry = { ts: number; level: 'info' | 'warn' | 'error'; message: string };

const ENCODER_STALE_MS = 4000;
const WATCHDOG_MS = 1000;
const RECONNECT_MS = 2500;
const HANDSHAKE_RETRY_MS = 5000;
const POLL_MS = 500;
const LAST_LOG_KEEP = 100;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Rank ports for auto-connect: remembered / UDP Ethernet first, then CH340-like adapters. */
export function rankPorts(
  ports: PortInfo[],
  lastPort: string | null,
  opts: { preferUdp?: boolean; udpPath?: string } = {},
): PortInfo[] {
  const score = (p: PortInfo): number => {
    const text = `${p.path} ${p.manufacturer ?? ''} ${p.friendlyName ?? ''} ${p.pnpId ?? ''}`.toLowerCase();
    if (lastPort && p.path.toLowerCase() === lastPort.toLowerCase()) return 100;
    if (opts.udpPath && p.path.toLowerCase() === opts.udpPath.toLowerCase()) return opts.preferUdp ? 95 : 70;
    if (/^udp:\/\//i.test(p.path)) return opts.preferUdp ? 90 : 55;
    if (text.includes('ch340') || text.includes('ch341')) return 80;
    if ((p.vendorId ?? '').toLowerCase() === '1a86') return 80;
    if (p.path.toUpperCase() === 'COM13') return 60;
    if (/ttyusb\d+/i.test(p.path)) return 50;
    if (text.includes('wch')) return 40;
    return 0;
  };
  return ports
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.p);
}

export class SpectreService extends EventEmitter {
  readonly port = new PortManager();
  readonly motion: MotionController;
  readonly startedAt = Date.now();

  clients = 0;
  encoder: EncoderHealth = {
    healthy: false,
    lastPanAt: null,
    lastTiltAt: null,
    ageMs: null,
    handshakeOk: false,
    lastHandshakeAt: null,
    failures: 0,
    reason: 'not connected',
  };
  bit: BitReport | null = null;
  mode = 'idle';

  private logs: LogEntry[] = [];
  private watchdogTimer: NodeJS.Timeout | null = null;
  private lastWatchdogAt = 0;
  private lastLagMs = 0;
  private lastHealthPush = 0;
  private lastReconnectAt = 0;
  private lastHandshakeTry = 0;
  private userDisconnected = false;
  private connecting = false;
  private handshaking = false;
  private bitRunning = false;
  private shuttingDown = false;
  private webDir: string | null = null;
  private pipShell: PipShellManager | null = null;
  /** Coalesce overlapping sphere/slider gotos so the RS-485 bus is not flooded. */
  private pendingGoto: { pan?: number; tilt?: number } | null = null;
  /** In-flight target — pan-only / tilt-only updates must merge against this, not drop axes. */
  private activeGoto: { pan?: number; tilt?: number } | null = null;
  private gotoRunner: Promise<void> | null = null;
  private lastRefreshAt = 0;

  constructor(readonly config: ConfigStore) {
    super();
    const c = config.value;
    this.motion = new MotionController(this.port, {
      address: c.address,
      panSpeed: c.panSpeed,
      tiltSpeed: c.tiltSpeed,
      limits: c.limits,
      approach: c.approach,
    });
    this.wire();
  }

  setWebDir(dir: string | null): void {
    this.webDir = dir;
  }

  /** Wire the always-on-top desktop pip-shell (Windows overlay). */
  initPipShell(projectRoot: string, widgetUrl: string): void {
    this.pipShell = new PipShellManager(projectRoot, (level, msg) => this.log(level, msg), widgetUrl);
    if (this.config.value.widgetVisible) {
      void this.openDesktopWidget();
    }
  }

  /** Desktop overlay opens regardless of RS-485 link state. */
  async openDesktopWidget(): Promise<{ ok: boolean; detail: string }> {
    if (!this.pipShell) {
      return { ok: false, detail: 'pip-shell not configured' };
    }
    // Serial may be down — still launch so the UI can show "no device connected".
    const result = await this.pipShell.open();
    if (result.ok) {
      this.config.update({ widgetVisible: true });
      this.out('settings', this.settingsView());
    }
    return result;
  }

  async closeDesktopWidget(): Promise<void> {
    await this.pipShell?.close();
    this.config.update({ widgetVisible: false });
    this.out('settings', this.settingsView());
  }

  // ---------------------------------------------------------------- events

  private out(type: string, payload?: unknown): void {
    this.emit('out', { type, payload } satisfies OutMessage);
  }

  log(level: LogEntry['level'], message: string): void {
    const entry: LogEntry = { ts: Date.now(), level, message };
    this.logs.push(entry);
    if (this.logs.length > LAST_LOG_KEEP) this.logs.shift();
    const line = `[spectre] ${level.toUpperCase()} ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    this.out('log', entry);
  }

  recentLogs(): LogEntry[] {
    return [...this.logs];
  }

  private wire(): void {
    const { port, motion } = this;

    port.on('status', () => {
      this.out('serial.status', this.serialStatus());
      if (!port.getStatus().connected) this.markEncoders(false, 'serial disconnected');
    });
    port.on('tx', (hex: string) => this.out('serial.tx', { ts: Date.now(), hex }));
    port.on('rx', (hex: string) => this.out('serial.rx', { ts: Date.now(), hex }));
    port.on('error', (err: unknown) => {
      this.log('error', `serial: ${String(err)}`);
      this.markEncoders(false, 'serial fault');
      // Nudge reconnect sooner after a bus lockup / CH340 fault.
      this.lastReconnectAt = 0;
      this.motion.stopPolling();
    });
    port.on('position', (pos: { kind: 'pan' | 'tilt' }) => {
      const now = Date.now();
      if (pos.kind === 'pan') this.encoder.lastPanAt = now;
      else this.encoder.lastTiltAt = now;
      this.evaluateEncoders();
    });

    motion.on('pose', (pose: Pose) => this.out('pose', pose));
    motion.on('settings', () => this.out('settings', this.settingsView()));
    motion.on('state', (s: { mode?: string }) => {
      this.mode = s?.mode ?? 'idle';
      this.out('state', s);
    });
    motion.on('limitHit', (l: unknown) => {
      this.log('warn', `limit hit ${JSON.stringify(l)}`);
      this.out('limitHit', l);
    });
    motion.on('preset', (p: unknown) => this.out('preset.event', p));
    motion.on('error', (e: unknown) => this.log('error', `motion: ${String(e)}`));
  }

  // --------------------------------------------------------------- snapshot

  serialStatus() {
    const s = this.port.getStatus();
    return {
      ...s,
      address: this.motion.getSettings().address,
      baudRate: s.baudRate || this.config.value.baudRate,
    };
  }

  settingsView() {
    const c = this.config.value;
    return {
      ...this.motion.getSettings(),
      lastPort: c.lastPort,
      baudRate: c.baudRate,
      autoConnect: c.autoConnect,
      widgetOpacity: c.widgetOpacity,
      widgetPinned: c.widgetPinned,
      widgetVisible: c.widgetVisible,
      widgetAutoDock: c.widgetAutoDock,
    };
  }

  /** Everything a freshly connected client needs. */
  snapshot(): OutMessage[] {
    return [
      { type: 'serial.status', payload: this.serialStatus() },
      { type: 'settings', payload: this.settingsView() },
      { type: 'presets', payload: this.config.value.presets },
      { type: 'pose', payload: this.motion.getPose() },
      { type: 'encoderHealth', payload: this.encoder },
      { type: 'state', payload: { mode: this.mode } },
      ...(this.bit ? [{ type: 'system.bit', payload: this.bit }] : []),
      { type: 'system.health', payload: this.health() },
    ];
  }

  // ----------------------------------------------------------------- health

  private evaluateEncoders(): void {
    const now = Date.now();
    const connected = this.port.getStatus().connected;
    const e = this.encoder;
    const oldest =
      e.lastPanAt != null && e.lastTiltAt != null ? Math.min(e.lastPanAt, e.lastTiltAt) : null;
    e.ageMs = oldest != null ? now - oldest : null;
    const fresh = connected && e.ageMs != null && e.ageMs <= ENCODER_STALE_MS;
    // While jogging/goto we pause background polls on purpose — don't mark
    // encoders unhealthy for that (it used to refuse the next sphere goto).
    const moving = this.motion.isBusy() || this.mode === 'goto' || this.mode === 'jogging';
    const healthy = connected && e.handshakeOk && (fresh || moving);
    let reason: string | null = null;
    if (!connected) reason = 'serial disconnected';
    else if (!e.handshakeOk) reason = 'handshake not completed';
    else if (!fresh && !moving) reason = 'encoder replies stale';
    if (healthy !== e.healthy || reason !== e.reason) {
      e.healthy = healthy;
      e.reason = reason;
      this.out('encoderHealth', { ...e });
    }
  }

  private markEncoders(handshakeOk: boolean, reason: string): void {
    const e = this.encoder;
    e.handshakeOk = handshakeOk;
    if (!handshakeOk) {
      e.healthy = false;
      e.reason = reason;
      e.ageMs = null;
      e.lastPanAt = null;
      e.lastTiltAt = null;
    }
    this.out('encoderHealth', { ...e });
  }

  health() {
    const now = Date.now();
    const wdAge = this.lastWatchdogAt ? now - this.lastWatchdogAt : null;
    const serial = this.serialStatus();
    const watchdogAlive = wdAge != null && wdAge < WATCHDOG_MS * 5;
    const status: 'ok' | 'degraded' | 'down' = !watchdogAlive
      ? 'down'
      : serial.connected && this.encoder.healthy
        ? 'ok'
        : 'degraded';
    return {
      status,
      ts: now,
      uptimeMs: now - this.startedAt,
      pid: process.pid,
      serial,
      encoderHealthy: this.encoder.healthy,
      encoderReason: this.encoder.reason,
      motionMode: this.mode,
      clients: this.clients,
      watchdog: { alive: watchdogAlive, lastTickAt: this.lastWatchdogAt || null, lagMs: this.lastLagMs },
      bit: this.bit ? { ok: this.bit.ok, at: this.bit.finishedAt, trigger: this.bit.trigger } : null,
      webDir: this.webDir,
      configPath: this.config.path,
    };
  }

  // --------------------------------------------------------------- watchdog

  startWatchdog(): void {
    this.stopWatchdog();
    this.lastWatchdogAt = Date.now();
    this.watchdogTimer = setInterval(() => {
      void this.watchdogTick().catch((err) => this.log('error', `watchdog: ${String(err)}`));
    }, WATCHDOG_MS);
  }

  stopWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private async watchdogTick(): Promise<void> {
    const now = Date.now();
    this.lastLagMs = Math.max(0, now - this.lastWatchdogAt - WATCHDOG_MS);
    this.lastWatchdogAt = now;
    if (this.lastLagMs > 2000) this.log('warn', `event loop lag ${this.lastLagMs}ms`);
    if (this.shuttingDown) return;

    const status = this.port.getStatus();
    const cfg = this.config.value;

    if (!status.connected) {
      if (
        cfg.autoConnect &&
        !this.userDisconnected &&
        !this.connecting &&
        !this.bitRunning &&
        now - this.lastReconnectAt >= RECONNECT_MS
      ) {
        this.lastReconnectAt = now;
        await this.autoConnect({ quiet: true });
      }
    } else {
      this.evaluateEncoders();
      if (
        !this.encoder.healthy &&
        this.mode === 'idle' &&
        !this.handshaking &&
        !this.connecting &&
        !this.bitRunning &&
        now - this.lastHandshakeTry >= HANDSHAKE_RETRY_MS
      ) {
        this.log('warn', `encoders unhealthy (${this.encoder.reason}); retrying handshake`);
        await this.handshake();
      }
    }

    if (now - this.lastHealthPush >= 2000) {
      this.lastHealthPush = now;
      this.out('system.health', this.health());
    }
  }

  // ----------------------------------------------------------------- serial

  async listPorts(): Promise<PortInfo[]> {
    return PortManager.listPorts();
  }

  /** Pick a port (UDP Ethernet → remembered → CH340/COM13/ttyUSB) and connect. */
  async autoConnect(opts: { quiet?: boolean } = {}): Promise<string | null> {
    const cfg = this.config.value;
    let ports: PortInfo[];
    try {
      ports = await PortManager.listPorts();
    } catch (err) {
      if (!opts.quiet) this.log('error', `port enumeration failed: ${String(err)}`);
      return null;
    }
    // UDP only if explicitly preferred and lastPort/udpPath is already selected — not exposed in UI yet.
    if (
      cfg.preferUdp &&
      cfg.udpPath &&
      !ports.some((p) => p.path.toLowerCase() === cfg.udpPath.toLowerCase())
    ) {
      ports.unshift({
        path: cfg.udpPath,
        manufacturer: 'SPECTRE',
        friendlyName: `Ethernet Pelco-D ${cfg.udpPath}`,
      });
    }
    const candidates = rankPorts(ports, cfg.lastPort, {
      preferUdp: cfg.preferUdp,
      udpPath: cfg.udpPath,
    }).filter((p) => cfg.preferUdp || !/^udp:\/\//i.test(p.path));
    if (!candidates.length) {
      if (!opts.quiet) this.log('warn', 'auto-connect: no matching serial/UDP port found');
      return null;
    }
    for (const cand of candidates) {
      try {
        await this.connect(cand.path, cfg.baudRate, { quiet: opts.quiet });
        return cand.path;
      } catch (err) {
        if (!opts.quiet) this.log('warn', `auto-connect ${cand.path} failed: ${String(err)}`);
      }
    }
    return null;
  }

  async connect(path: string, baudRate = 9600, opts: { quiet?: boolean } = {}): Promise<void> {
    if (this.connecting) throw new Error('connect already in progress');
    this.connecting = true;
    this.userDisconnected = false;
    try {
      this.motion.stopPolling();
      await this.port.open(path, baudRate);
      const patch: Partial<AppConfig> = { lastPort: path, baudRate };
      if (/^udp:\/\//i.test(path)) patch.udpPath = path;
      this.config.update(patch);
      const via = /^udp:\/\//i.test(path) ? 'UDP' : 'serial';
      this.log('info', `${via} connected ${path}${via === 'serial' ? ` @ ${baudRate}` : ''}`);
      this.markEncoders(false, 'handshake pending');
      await this.motion.stop().catch(() => undefined);
      const ok = await this.handshake();
      if (!ok && !opts.quiet) this.log('warn', 'connected but encoder handshake failed');
      this.motion.startPolling(POLL_MS);
      this.out('settings', this.settingsView());
    } finally {
      this.connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    this.userDisconnected = true;
    this.motion.stopPolling();
    await this.motion.stop().catch(() => undefined);
    await this.port.close();
    this.markEncoders(false, 'serial disconnected');
    this.log('info', 'serial disconnected');
  }

  /** Query pan (0x51) and tilt (0x53) and wait for 0x59/0x5B replies. */
  async handshake(attempts = 3): Promise<boolean> {
    if (this.handshaking) return this.encoder.handshakeOk;
    this.handshaking = true;
    this.lastHandshakeTry = Date.now();
    try {
      const addr = this.motion.getSettings().address;
      let panOk = false;
      let tiltOk = false;
      for (let i = 0; i < attempts && !(panOk && tiltOk); i += 1) {
        if (!this.port.getStatus().connected) break;
        if (!panOk) {
          const wait = this.waitPosition('pan', 700);
          await this.port.write(queryPan(addr)).catch(() => undefined);
          panOk = await wait;
        }
        if (!tiltOk) {
          const wait = this.waitPosition('tilt', 700);
          await this.port.write(queryTilt(addr)).catch(() => undefined);
          tiltOk = await wait;
        }
      }
      const e = this.encoder;
      e.lastHandshakeAt = Date.now();
      e.handshakeOk = panOk && tiltOk;
      if (e.handshakeOk) {
        e.failures = 0;
        const now = Date.now();
        e.lastPanAt = now;
        e.lastTiltAt = now;
        this.log('info', 'encoder handshake OK (pan 0x51 / tilt 0x53)');
      } else {
        e.failures += 1;
        e.healthy = false;
        e.reason = `no ${!panOk ? 'pan' : ''}${!panOk && !tiltOk ? '+' : ''}${!tiltOk ? 'tilt' : ''} reply`;
        this.log('warn', `encoder handshake failed: ${e.reason}`);
      }
      this.evaluateEncoders();
      this.out('encoderHealth', { ...e });
      return e.handshakeOk;
    } finally {
      this.handshaking = false;
    }
  }

  private waitPosition(kind: 'pan' | 'tilt', timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const onPos = (pos: { kind: string }) => {
        if (pos.kind !== kind) return;
        cleanup();
        resolve(true);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.port.off('position', onPos);
      };
      this.port.on('position', onPos);
    });
  }

  // -------------------------------------------------------------------- BIT

  async runBit(trigger: BitReport['trigger']): Promise<BitReport> {
    if (this.bitRunning) return this.bit ?? this.emptyBit(trigger);
    this.bitRunning = true;
    const startedAt = Date.now();
    const checks: BitCheck[] = [];
    const add = (name: string, ok: boolean, detail: string, optional = false) =>
      checks.push({ name, ok, detail, optional });

    try {
      // config
      const writable = this.config.isWritable();
      add(
        'config',
        writable,
        writable
          ? `${this.config.path}${this.config.usedFallback ? ' (fallback location)' : ''}`
          : this.config.lastError ?? 'not writable',
      );

      // web assets
      add(
        'web',
        !!this.webDir && fs.existsSync(this.webDir),
        this.webDir ?? 'no web/dist or web directory found',
        true,
      );

      // settings sanity
      const s = this.motion.getSettings() as ControllerSettings;
      const settingsOk =
        s.address >= 0 &&
        s.address <= 255 &&
        s.limits.panMin === -180 &&
        s.limits.panMax === 180 &&
        s.limits.tiltMax > s.limits.tiltMin;
      add('motion.limits', settingsOk, `pan ${s.limits.panMin}..${s.limits.panMax} tilt ${s.limits.tiltMin}..${s.limits.tiltMax}, addr ${s.address}`);

      // serial enumeration
      let ports: PortInfo[] = [];
      try {
        ports = await PortManager.listPorts();
        add('serial.enumerate', true, `${ports.length} port(s): ${ports.map((p) => p.path).join(', ') || '-'}`);
      } catch (err) {
        add('serial.enumerate', false, String(err));
      }

      const candidates = rankPorts(ports, this.config.value.lastPort, {
        preferUdp: this.config.value.preferUdp,
        udpPath: this.config.value.udpPath,
      });
      add(
        'serial.candidate',
        candidates.length > 0,
        candidates.length ? candidates.map((p) => p.path).join(', ') : 'no UDP/CH340/COM13 candidate',
      );

      // open
      if (
        !this.port.getStatus().connected &&
        candidates.length &&
        !this.connecting &&
        (trigger === 'manual' || this.config.value.autoConnect)
      ) {
        await this.autoConnect();
      } else if (this.port.getStatus().connected && trigger === 'manual') {
        await this.handshake();
      }
      const st = this.port.getStatus();
      add('serial.open', st.connected, st.connected ? `${st.path} @ ${st.baudRate}` : 'not connected');

      // encoders
      const e = this.encoder;
      add('encoder.pan', st.connected && e.lastPanAt != null && e.handshakeOk, e.lastPanAt ? 'reply 0x59 ok' : 'no reply');
      add('encoder.tilt', st.connected && e.lastTiltAt != null && e.handshakeOk, e.lastTiltAt ? 'reply 0x5B ok' : 'no reply');
    } catch (err) {
      add('bit.internal', false, String(err));
    } finally {
      this.bitRunning = false;
    }

    const finishedAt = Date.now();
    const report: BitReport = {
      trigger,
      ok: checks.filter((c) => !c.optional).every((c) => c.ok),
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      checks,
    };
    this.bit = report;
    this.log(report.ok ? 'info' : 'warn', `BIT (${trigger}) ${report.ok ? 'PASS' : 'FAIL'}: ${checks.filter((c) => !c.ok).map((c) => c.name).join(', ') || 'all checks ok'}`);
    this.out('system.bit', report);
    this.out('system.health', this.health());
    return report;
  }

  private emptyBit(trigger: BitReport['trigger']): BitReport {
    const now = Date.now();
    return { trigger, ok: false, startedAt: now, finishedAt: now, durationMs: 0, checks: [] };
  }

  // --------------------------------------------------------------- settings

  updateSettings(patch: Record<string, unknown>): unknown {
    const motionPatch: Partial<ControllerSettings> = {};
    const cfgPatch: Partial<AppConfig> = {};
    if (typeof patch.address === 'number') motionPatch.address = patch.address;
    if (typeof patch.panSpeed === 'number') motionPatch.panSpeed = patch.panSpeed;
    if (typeof patch.tiltSpeed === 'number') motionPatch.tiltSpeed = patch.tiltSpeed;
    if (patch.limits && typeof patch.limits === 'object') {
      const lim = { ...(patch.limits as ControllerSettings['limits']) };
      // Tilt soft-limits are hardcoded ±50° — ignore client overrides.
      lim.tiltMin = -50;
      lim.tiltMax = 50;
      motionPatch.limits = lim;
    }
    if (patch.approach && typeof patch.approach === 'object') {
      const a = { ...(patch.approach as ControllerSettings['approach']) };
      if (typeof a.deadband === 'number') a.deadband = snapLandingResolution(a.deadband);
      motionPatch.approach = a;
    }
    const next = this.motion.updateSettings(motionPatch);
    cfgPatch.address = next.address;
    cfgPatch.panSpeed = next.panSpeed;
    cfgPatch.tiltSpeed = next.tiltSpeed;
    cfgPatch.limits = next.limits;
    cfgPatch.approach = next.approach;
    if (typeof patch.autoConnect === 'boolean') cfgPatch.autoConnect = patch.autoConnect;
    if (typeof patch.baudRate === 'number') cfgPatch.baudRate = patch.baudRate;
    if (typeof patch.lastPort === 'string') cfgPatch.lastPort = patch.lastPort;
    if (typeof patch.widgetOpacity === 'number') {
      cfgPatch.widgetOpacity = Math.max(0.4, Math.min(1, patch.widgetOpacity));
    }
    if (typeof patch.widgetPinned === 'boolean') cfgPatch.widgetPinned = patch.widgetPinned;
    if (typeof patch.widgetVisible === 'boolean') cfgPatch.widgetVisible = patch.widgetVisible;
    if (typeof patch.widgetAutoDock === 'boolean') cfgPatch.widgetAutoDock = patch.widgetAutoDock;
    this.config.update(cfgPatch);
    if (typeof patch.widgetVisible === 'boolean') {
      if (patch.widgetVisible) void this.openDesktopWidget();
      else void this.closeDesktopWidget();
    }
    const view = this.settingsView();
    this.out('settings', view);
    return view;
  }

  // ----------------------------------------------------------------- motion

  private requireSerial(): void {
    if (!this.port.getStatus().connected) throw new Error('Serial port is not connected');
  }

  private requireEncoders(what: string): void {
    this.requireSerial();
    this.evaluateEncoders();
    // Handshake is the hard gate. Soft-stale after a move is OK — we re-query inside goto.
    if (!this.encoder.handshakeOk) {
      throw new Error(`${what} refused: encoders unhealthy (${this.encoder.reason ?? 'unknown'})`);
    }
    if (!this.encoder.healthy) {
      this.log('warn', `${what}: encoders soft-stale (${this.encoder.reason}); continuing`);
    }
  }

  async jog(flags: MoveFlags): Promise<void> {
    this.requireSerial();
    if (!this.encoder.healthy) {
      this.log('warn', 'jog with unhealthy encoders: pan revolution lock is NOT reliable');
    }
    await this.motion.jog(flags);
  }

  async stop(): Promise<void> {
    // Stop must always try; ignore serial-closed errors.
    await this.motion.stop().catch((err) => {
      if (this.port.getStatus().connected) throw err;
    });
  }

  /** Run a long closed-loop move in the background; errors are logged + pushed. */
  private background(label: string, fn: () => Promise<void>): void {
    void fn().catch((err) => {
      this.log('error', `${label} failed: ${String(err)}`);
      this.out('error', { source: label, message: String(err) });
    });
  }

  home(): void {
    this.requireEncoders('home');
    // Cancel any queued sphere gotos — home wins.
    this.pendingGoto = null;
    this.activeGoto = null;
    this.motion.requestAbortGoto();
    this.log('info', 'home/storage/off: closed-loop pan 0° / tilt flat 0° (band ±1.5°)');
    this.background('motion.home', () => this.motion.home());
  }

  /**
   * Single-flight goto with replaceable target.
   * Rapid sphere-drag updates only keep the latest aim — they must not stack
   * stop/query/move storms that lock up CH340 adapters.
   *
   * Axis merge: a pan-only update must not wipe the active/pending tilt (and
   * vice versa). That bug left tilt gotos aborted at the prior forward/back end.
   */
  gotoAbsolute(pan?: number, tilt?: number): void {
    this.requireEncoders('goto');
    const base = this.pendingGoto ?? this.activeGoto ?? {};
    this.pendingGoto = {
      pan: typeof pan === 'number' ? pan : base.pan,
      tilt: typeof tilt === 'number' ? tilt : base.tilt,
    };
    if (this.gotoRunner) {
      this.motion.requestAbortGoto();
      return;
    }
    this.gotoRunner = (async () => {
      try {
        while (this.pendingGoto && !this.shuttingDown) {
          const t = this.pendingGoto;
          this.pendingGoto = null;
          this.activeGoto = t;
          this.mode = 'goto';
          this.log(
            'info',
            `goto accepted pan=${t.pan ?? '—'} tilt=${t.tilt ?? '—'} (land ±${this.config.value.approach.deadband}°)`,
          );
          await this.motion.gotoAbsolute(t.pan, t.tilt);
        }
      } finally {
        this.activeGoto = null;
        this.gotoRunner = null;
        this.mode = 'idle';
        // A target may have landed in the finally race — schedule one more pass.
        if (this.pendingGoto) {
          const again = this.pendingGoto;
          this.pendingGoto = null;
          this.gotoAbsolute(again.pan, again.tilt);
        }
      }
    })().catch((err) => {
      this.log('error', `motion.goto failed: ${String(err)}`);
      this.out('error', { source: 'motion.goto', message: String(err) });
      this.activeGoto = null;
      this.gotoRunner = null;
      this.mode = 'idle';
    });
  }

  async refresh(): Promise<Pose> {
    this.requireSerial();
    // Debounce client pose.refresh spam (console + widget + pip-shell all ask on connect).
    const now = Date.now();
    if (this.motion.isBusy() || now - this.lastRefreshAt < 200) {
      return this.motion.getPose();
    }
    this.lastRefreshAt = now;
    return this.motion.refreshEncoders();
  }

  onAllClientsGone(): void {
    if (this.mode === 'jogging') {
      this.log('warn', 'all clients gone during jog: stopping');
      void this.stop().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- presets

  private presetId(id: unknown): PresetId {
    const n = Number(id);
    if (!(PRESET_IDS as readonly number[]).includes(n)) throw new Error(`invalid preset id: ${String(id)}`);
    return n as PresetId;
  }

  presets(): PresetMeta[] {
    return this.config.value.presets;
  }

  async setPreset(idRaw: unknown): Promise<PresetMeta[]> {
    const id = this.presetId(idRaw);
    this.requireEncoders('preset.set');
    await this.motion.setPreset(id);
    const pose = this.motion.getPose();
    const presets = this.config.value.presets.map((p) =>
      p.id === id
        ? { ...p, pan: pose.pan, tilt: pose.tilt, panTravel: pose.panTravel, updatedAt: Date.now() }
        : p,
    );
    this.config.update({ presets });
    this.out('presets', this.presets());
    return this.presets();
  }

  callPreset(idRaw: unknown): void {
    const id = this.presetId(idRaw);
    this.requireSerial();
    const meta = this.config.value.presets.find((p) => p.id === id);
    const stored = !!meta && (meta.panTravel != null || meta.pan != null || meta.tilt != null);
    if (stored) this.requireEncoders('preset.call');
    this.background(`preset.call ${id}`, () => this.motion.callPreset(id, meta));
  }

  async clearPreset(idRaw: unknown): Promise<PresetMeta[]> {
    const id = this.presetId(idRaw);
    if (this.port.getStatus().connected) await this.motion.clearPresetCmd(id);
    const presets = this.config.value.presets.map((p) =>
      p.id === id ? { ...p, pan: null, tilt: null, panTravel: null, updatedAt: null } : p,
    );
    this.config.update({ presets });
    this.out('presets', this.presets());
    return this.presets();
  }

  // --------------------------------------------------------------- shutdown

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.stopWatchdog();
    await this.pipShell?.close().catch(() => undefined);
    await this.motion.shutdown().catch(() => undefined);
    await this.port.close().catch(() => undefined);
    await delay(10);
  }
}
