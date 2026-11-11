import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ApproachConfig, SoftLimits } from '../shared/controller';

export type PresetMeta = {
  id: number;
  label: string;
  pan: number | null;
  tilt: number | null;
  /** Unwrapped pan travel for closed-loop recall (no revolution wrap). */
  panTravel: number | null;
  updatedAt: number | null;
};

/** Fixed 3×3 order: Sector A/B/C × Low / Level / High (row-major). */
export const PRESET_LABELS = [
  'Sector A Low',
  'Sector A Level',
  'Sector A High',
  'Sector B Low',
  'Sector B Level',
  'Sector B High',
  'Sector C Low',
  'Sector C Level',
  'Sector C High',
] as const;

const LEGACY_COMPASS_LABELS = new Set([
  'LEVEL',
  'N',
  'NE',
  'E',
  'SE',
  'S',
  'SW',
  'W',
  'NW',
]);

export function defaultPresetLabel(id: number): string {
  return PRESET_LABELS[id - 1] ?? `P${id}`;
}

function isLegacyPresetLabel(label: string, id: number): boolean {
  const t = label.trim().toUpperCase();
  return (
    !t ||
    t === `P${id}` ||
    t === `PRESET ${id}` ||
    t === `PRESET${id}` ||
    t === `#${id}` ||
    t === `#0${id}` ||
    t === String(id) ||
    LEGACY_COMPASS_LABELS.has(t)
  );
}

/** HTTP/WS listen port range (operator-selectable; default 9000). */
export const HTTP_PORT_MIN = 9000;
export const HTTP_PORT_MAX = 15000;
export const DEFAULT_HTTP_PORT = 9000;

export function clampHttpPort(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return DEFAULT_HTTP_PORT;
  return Math.max(HTTP_PORT_MIN, Math.min(HTTP_PORT_MAX, Math.round(n)));
}

export type AppConfig = {
  lastPort: string;
  baudRate: number;
  address: number;
  panSpeed: number;
  tiltSpeed: number;
  autoConnect: boolean;
  /**
   * Preferred Ethernet Pelco-D endpoint (`udp://host:port`).
   * Official head: 100M Ethernet + UDP + Pelco-D; RS-485 remains fallback.
   */
  udpPath: string;
  /** Prefer UDP over COM when auto-connecting (Ethernet NIC dedicated to the turntable). */
  preferUdp: boolean;
  /** Local SPECTRE HTTP/WS listen port (9000–15000). Applied on next process start. */
  httpPort: number;
  limits: SoftLimits;
  approach: ApproachConfig;
  presets: PresetMeta[];
  widgetOpacity: number;
  widgetPinned: boolean;
  widgetVisible: boolean;
  widgetAutoDock: boolean;
};

export function defaultConfig(): AppConfig {
  return {
    lastPort: process.platform === 'win32' ? 'COM13' : '/dev/ttyUSB0',
    baudRate: 9600,
    address: 1,
    // Official medium-duty servo worm-gear head: pan 1.2–60°/s, tilt 1.2–30°/s, ±0.2° accuracy.
    // Soft tilt travel hardcoded to ±50° for this deployment.
    // Pelco-D speed byte 0–63 maps across that mechanical range (63 ≈ rated max).
    panSpeed: 48,
    tiltSpeed: 32,
    autoConnect: true,
    // Factory seed from turntable manual (editable via console; RS-485 remains default auto-connect).
    udpPath: 'udp://192.168.8.200:6666',
    preferUdp: false,
    httpPort: DEFAULT_HTTP_PORT,
    limits: { enabled: true, panMin: -180, panMax: 180, tiltMin: -50, tiltMax: 50 },
    approach: { speedFast: 42, speedSlow: 5, rampDistance: 18, deadband: 1, pollMs: 80 },
    presets: Array.from({ length: 9 }, (_, i) => ({
      id: i + 1,
      label: defaultPresetLabel(i + 1),
      pan: null,
      tilt: null,
      panTravel: null,
      updatedAt: null,
    })),
    widgetOpacity: 0.95,
    widgetPinned: true,
    widgetVisible: true,
    widgetAutoDock: true,
  };
}

/** %PROGRAMDATA%/SpectrePT/config.json (win) or ~/.config/spectre-pt/config.json (linux/mac). */
export function defaultConfigPath(): string {
  if (process.env.SPECTRE_CONFIG) return path.resolve(process.env.SPECTRE_CONFIG);
  if (process.platform === 'win32') {
    const base = process.env.PROGRAMDATA || 'C:\\ProgramData';
    return path.join(base, 'SpectrePT', 'config.json');
  }
  return path.join(os.homedir(), '.config', 'spectre-pt', 'config.json');
}

/** Per-user fallback if the primary location is not writable (e.g. ProgramData without rights). */
function fallbackConfigPath(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'SpectrePT', 'config.json');
  }
  return path.join(os.homedir(), '.config', 'spectre-pt', 'config.json');
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Allowed goto landing resolutions (°). Inside band = good, no micro-fight. */
export const LANDING_RESOLUTIONS = [0.5, 1, 2] as const;
export type LandingResolution = (typeof LANDING_RESOLUTIONS)[number];

export function snapLandingResolution(v: number): LandingResolution {
  let best: LandingResolution = 1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const cand of LANDING_RESOLUTIONS) {
    const d = Math.abs(cand - v);
    if (d < bestDist) {
      best = cand;
      bestDist = d;
    }
  }
  return best;
}

/** Merge unknown JSON onto defaults and repair obviously broken values. */
export function normalizeConfig(raw: unknown): AppConfig {
  const d = defaultConfig();
  const r = isObj(raw) ? raw : {};
  const lim = isObj(r.limits) ? r.limits : {};
  const app = isObj(r.approach) ? r.approach : {};

  const cfg: AppConfig = {
    lastPort: typeof r.lastPort === 'string' && r.lastPort ? r.lastPort : d.lastPort,
    baudRate: num(r.baudRate, d.baudRate),
    // Pelco-D camera address is 1..255 (UI + BIT); never persist 0.
    address: Math.max(1, Math.min(255, Math.round(num(r.address, d.address)) || 1)),
    panSpeed: Math.max(0, Math.min(63, num(r.panSpeed, d.panSpeed))),
    tiltSpeed: Math.max(0, Math.min(63, num(r.tiltSpeed, d.tiltSpeed))),
    autoConnect: typeof r.autoConnect === 'boolean' ? r.autoConnect : d.autoConnect,
    udpPath:
      typeof r.udpPath === 'string' && /^udp:\/\//i.test(r.udpPath) ? r.udpPath : d.udpPath,
    preferUdp: typeof r.preferUdp === 'boolean' ? r.preferUdp : d.preferUdp,
    httpPort: clampHttpPort(r.httpPort ?? d.httpPort),
    limits: {
      enabled: typeof lim.enabled === 'boolean' ? lim.enabled : d.limits.enabled,
      // Pan travel lock is fixed at ±180 by MotionController regardless.
      panMin: -180,
      panMax: 180,
      // Tilt soft-limits hardcoded ±50° (ignore saved / UI overrides).
      tiltMin: -50,
      tiltMax: 50,
    },
    approach: {
      speedFast: num(app.speedFast, d.approach.speedFast),
      speedSlow: num(app.speedSlow, d.approach.speedSlow),
      rampDistance: num(app.rampDistance, d.approach.rampDistance),
      deadband: num(app.deadband, d.approach.deadband),
      pollMs: num(app.pollMs, d.approach.pollMs),
    },
    presets: d.presets,
    widgetOpacity: Math.max(0.4, Math.min(1, num(r.widgetOpacity, d.widgetOpacity))),
    widgetPinned: typeof r.widgetPinned === 'boolean' ? r.widgetPinned : d.widgetPinned,
    widgetVisible: typeof r.widgetVisible === 'boolean' ? r.widgetVisible : d.widgetVisible,
    widgetAutoDock: typeof r.widgetAutoDock === 'boolean' ? r.widgetAutoDock : d.widgetAutoDock,
  };
  cfg.limits.tiltMin = -50;
  cfg.limits.tiltMax = 50;
  // Landing resolution is operator-selected: 0.5° / 1° / 2° (speedy accept band).
  // Home uses a separate hard-coded ±1.5° settle and ignores this value.
  cfg.approach.deadband = snapLandingResolution(cfg.approach.deadband);

  if (Array.isArray(r.presets)) {
    cfg.presets = d.presets.map((def) => {
      const found = (r.presets as unknown[]).find((p) => isObj(p) && p.id === def.id);
      if (!isObj(found)) return def;
      const nn = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;
      const rawLabel = typeof found.label === 'string' ? found.label : '';
      const label = isLegacyPresetLabel(rawLabel, def.id) ? def.label : rawLabel;
      return {
        id: def.id,
        label,
        pan: nn(found.pan),
        tilt: nn(found.tilt),
        panTravel: nn(found.panTravel),
        updatedAt: nn(found.updatedAt),
      };
    });
  }
  return cfg;
}

export class ConfigStore {
  private filePath: string;
  private data: AppConfig;
  /** Set when the primary path wasn't usable and we moved to the fallback. */
  usedFallback = false;
  lastError: string | null = null;

  constructor(filePath: string = defaultConfigPath()) {
    this.filePath = filePath;
    this.data = defaultConfig();
    this.load();
  }

  get path(): string {
    return this.filePath;
  }

  get value(): AppConfig {
    return this.data;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const text = fs.readFileSync(this.filePath, 'utf8');
        this.data = normalizeConfig(JSON.parse(text));
      } else {
        this.data = defaultConfig();
      }
    } catch (err) {
      this.lastError = `load failed: ${String(err)}`;
      // Keep the unreadable file around for inspection, start from defaults.
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      this.data = defaultConfig();
    }
    // Make sure the file exists and is writable now; this also creates directories.
    if (!this.persist()) {
      const alt = fallbackConfigPath();
      if (alt !== this.filePath) {
        const primary = this.filePath;
        this.filePath = alt;
        try {
          if (fs.existsSync(alt)) this.data = normalizeConfig(JSON.parse(fs.readFileSync(alt, 'utf8')));
        } catch {
          /* ignore */
        }
        if (this.persist()) {
          this.usedFallback = true;
          this.lastError = `primary config path not writable (${primary}); using ${alt}`;
        } else {
          this.filePath = primary;
        }
      }
    }
  }

  /** Replace stored values with a patch (shallow top-level merge) and save. */
  update(patch: Partial<AppConfig>): AppConfig {
    this.data = normalizeConfig({ ...this.data, ...patch });
    this.persist();
    return this.data;
  }

  save(): boolean {
    return this.persist();
  }

  isWritable(): boolean {
    return this.persist();
  }

  private persist(): boolean {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
      return true;
    } catch (err) {
      this.lastError = `save failed: ${String(err)}`;
      return false;
    }
  }
}
