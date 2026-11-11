/**
 * Wire protocol between the SPECTRE UI (console + widget) and the local server.
 * JSON text frames over WebSocket /ws on the configured listen port (default 9000).
 */

export type MoveFlags = { left?: boolean; right?: boolean; up?: boolean; down?: boolean };

export type PoseMsg = {
  pan: number | null; // degrees 0-360
  tilt: number | null; // degrees, typically -50..+90
  panRaw: number | null; // raw 16-bit word from Pelco-D query reply (0x59 / 0x5B responses)
  tiltRaw: number | null;
  updatedAt: number | null;
};

export type PortInfo = { path: string; friendlyName?: string; manufacturer?: string };

export type SerialStatus = {
  connected: boolean;
  path: string | null;
  baudRate: number;
  address: number;
  transport?: 'serial' | 'udp';
};

export type PresetInfo = { id: number; label?: string; pan: number | null; tilt: number | null };

export type SelfTestItem = { name: string; ok: boolean; detail?: string };

export type Settings = {
  address?: number;
  baudRate?: number;
  panSpeed?: number; // 1-63
  tiltSpeed?: number; // 1-63
  autoRefresh?: boolean;
  limits?: { enabled?: boolean; panMin?: number; panMax?: number; tiltMin?: number; tiltMax?: number };
  approach?: { speedFast?: number; speedSlow?: number; rampDistance?: number; deadband?: number; pollMs?: number };
  widgetOpacity?: number; // 0.4 - 1
  widgetPinned?: boolean;
  widgetVisible?: boolean;
  widgetAutoDock?: boolean;
  /** Local HTTP/WS listen port (9000–15000). Applied on next SPECTRE restart. */
  httpPort?: number;
  /** Ethernet Pelco-D endpoint (`udp://host:port`) — user-editable; factory seed only. */
  udpPath?: string;
  /** When true, auto-connect may prefer the configured UDP endpoint over COM. Default false. */
  preferUdp?: boolean;
};

/** UI -> server */
export type ClientMsg =
  | { type: 'hello'; client: 'console' | 'widget'; version: string }
  | { type: 'ping'; t: number }
  | { type: 'jog'; flags: MoveFlags; step?: number; mode?: 'creep' | 'max'; source: 'console' | 'widget' }
  | { type: 'stop'; source: 'console' | 'widget' }
  | { type: 'halt'; source: 'console' | 'widget' }
  | { type: 'home'; source: 'console' | 'widget' }
  | { type: 'goto'; pan?: number; tilt?: number; source: 'console' | 'widget' }
  | { type: 'pose.refresh' }
  | { type: 'preset.call' | 'preset.set' | 'preset.clear'; id: number; source: 'console' | 'widget' }
  | { type: 'presets.get' }
  | { type: 'serial.list' }
  | { type: 'serial.connect'; path: string; baudRate: number; address: number }
  | { type: 'serial.disconnect' }
  | { type: 'settings.get' }
  | { type: 'settings.update'; patch: Settings }
  | { type: 'widget.opacity'; opacity: number }
  | { type: 'widget.pinned'; pinned: boolean }
  | { type: 'widget.visible'; visible: boolean }
  | { type: 'widget.open'; source: 'console' | 'widget' }
  | { type: 'widget.close'; source: 'console' | 'widget' }
  | { type: 'selftest.run' };

/** server -> UI */
export type ServerMsg =
  | { type: 'pong'; t: number }
  | ({ type: 'pose' } & PoseMsg)
  | ({ type: 'status' } & SerialStatus)
  | { type: 'ports'; ports: PortInfo[] }
  | { type: 'presets'; presets: PresetInfo[]; active?: number | null }
  | { type: 'settings'; settings: Settings }
  | { type: 'selftest'; ok: boolean; items: SelfTestItem[] }
  | { type: 'error'; message: string; ref?: string };

export type AnyMsg = ClientMsg | ServerMsg;
