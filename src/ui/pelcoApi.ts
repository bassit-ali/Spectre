export type PortInfo = { path: string; manufacturer?: string; friendlyName?: string };

export type Pose = {
  pan: number | null;
  tilt: number | null;
  panRaw: number | null;
  tiltRaw: number | null;
  updatedAt: number | null;
};

export type PresetMeta = {
  id: number;
  label: string;
  pan: number | null;
  tilt: number | null;
  updatedAt: number | null;
};

export type MoveFlags = {
  left?: boolean;
  right?: boolean;
  up?: boolean;
  down?: boolean;
};

export type PelcoApi = {
  listPorts: () => Promise<PortInfo[]>;
  connect: (path: string, baudRate: number) => Promise<{ connected: boolean; path: string | null; baudRate: number }>;
  disconnect: () => Promise<{ connected: boolean }>;
  getStatus: () => Promise<{ connected: boolean; path: string | null; baudRate: number }>;
  getSettings: () => Promise<Record<string, unknown>>;
  updateSettings: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getPose: () => Promise<Pose>;
  getLastMove: () => Promise<unknown>;
  getPresetsMeta: () => Promise<PresetMeta[]>;
  jog: (flags: MoveFlags) => Promise<void>;
  stop: () => Promise<void>;
  refreshEncoders: () => Promise<Pose>;
  setPreset: (id: number) => Promise<PresetMeta[]>;
  callPreset: (id: number) => Promise<void>;
  clearPreset: (id: number) => Promise<void>;
  gotoAbsolute: (pan?: number, tilt?: number) => Promise<void>;
  setWidgetOpacity: (opacity: number) => Promise<number>;
  setWidgetPinned: (pinned: boolean) => Promise<boolean>;
  setWidgetVisible: (visible: boolean) => Promise<boolean>;
  getAppConfig: () => Promise<Record<string, unknown>>;
  updateAppConfig: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onEvent: (channel: string, cb: (payload: unknown) => void) => () => void;
};

declare global {
  interface Window {
    pelco: PelcoApi;
  }
}

export function getApi(): PelcoApi {
  if (!window.pelco) {
    throw new Error('Pelco API unavailable — open this UI inside the Electron app');
  }
  return window.pelco;
}

export function flagsFromJog(name: string): MoveFlags {
  switch (name) {
    case 'up':
      return { up: true };
    case 'down':
      return { down: true };
    case 'left':
      return { left: true };
    case 'right':
      return { right: true };
    case 'upleft':
      return { up: true, left: true };
    case 'upright':
      return { up: true, right: true };
    case 'downleft':
      return { down: true, left: true };
    case 'downright':
      return { down: true, right: true };
    default:
      return {};
  }
}

export function fmtDeg(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—';
  return `${v.toFixed(2)}°`;
}

export function bindHoldJog(
  root: HTMLElement,
  onJog: (flags: MoveFlags) => void,
  onStop: () => void,
): void {
  let activePointer: number | null = null;
  let held = false;

  const release = (pointerId?: number) => {
    if (!held) return;
    if (pointerId != null && activePointer != null && pointerId !== activePointer) return;
    held = false;
    activePointer = null;
    onStop();
  };

  root.querySelectorAll<HTMLElement>('[data-jog]').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      activePointer = e.pointerId;
      held = true;
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        /* capture optional */
      }
      const name = btn.getAttribute('data-jog');
      if (name) onJog(flagsFromJog(name));
    });
    btn.addEventListener('pointerup', (e) => release(e.pointerId));
    btn.addEventListener('pointercancel', (e) => release(e.pointerId));
    btn.addEventListener('lostpointercapture', (e) => release(e.pointerId));
  });

  // Safety: if the pointer is released outside the button/window
  window.addEventListener('blur', () => release());
  document.addEventListener('pointerup', (e) => release(e.pointerId));
}
