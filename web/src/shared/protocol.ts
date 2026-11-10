/**
 * Draft wire protocol between the SPECTRE UI (console + widget) and the local server.
 * JSON text frames over ws://127.0.0.1:9000/ws:   { "type": "<name>", ...payload }
 *
 * Only data that can really originate from a Pelco-D pan/tilt head or the serial adapter
 * is modelled here (pan/tilt angle queries, raw reply words, presets 1-9, address, baud, speeds).
 * This file is a CONTRACT DRAFT - the server does not exist yet.
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
