import './styles/spectre.css';
import { PRODUCT, resolveHttpPort, resolveLocalHttp, resolveLocalWs } from './shared/endpoint';
import type { PoseMsg, PresetInfo, SerialStatus } from './shared/protocol';
import { SpectreSocket } from './shared/ws-client';
import {
  TILT_MAX,
  TILT_MIN,
  bindActions,
  bindDegreeNudge,
  bindSphereControl,
  bindText,
  byId,
  clamp,
  fmtTilt,
  normalizePanCommand,
  paintSectorBadges,
  paintSphereAim,
  qsa,
  readStoredOpacity,
  renderPoseText,
  renderWsState,
  setDot,
  setTiltLimits,
  storeOpacity,
  toast,
} from './shared/ui';

/* ====================================================================== */
/* Config (query string):  widget.html?bg=transparent                      */
/* ====================================================================== */

declare global {
  interface Window {
    spectreShell?: {
      setOpacity(value: number): void;
      setPinned(pinned: boolean): void;
      setContentHeight?(height: number): void;
      setAutoDock?(on: boolean): void;
      dockBottomRight?(): void;
      openExternal?(url: string): void;
      close(): void;
    };
  }
}

const MINIMIZE_MS = 320;
/** Mirrors Floating Widget → Auto-dock bottom-right. */
let autoDockEnabled = true;
/** Window opacity 0.4–1 (matches Settings.widgetOpacity). */
let widgetOpacity = 0.95;
let minimizeRaf = 0;
let minimizeTimer = 0;

/** Open the full console in the OS default browser. */
function openConsoleInBrowser(): void {
  const url = `${resolveLocalHttp()}/`;
  if (shell()?.openExternal) {
    shell()!.openExternal!(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

const params = new URLSearchParams(location.search);
if (params.get('bg') === 'transparent') {
  document.documentElement.classList.add('bg-transparent');
  document.body.classList.remove('bg-background');
}

const shell = () => window.spectreShell;

/* ====================================================================== */
/* State                                                                  */
/* ====================================================================== */

type SpeedMode = 'creep' | 'max';
const STEP_BY_MODE: Record<SpeedMode, number> = { creep: 0.1, max: 2.5 };

let pose: Partial<PoseMsg> | null = null;
let mode: SpeedMode = 'creep';
let pinned = true;
/** While dragging the dome, don't let live pose overwrite the aim ball. */
let sphereDragging = false;

const widget = byId('spectre-widget')!;
const ws = new SpectreSocket(resolveLocalWs(), { type: 'hello', client: 'widget', version: PRODUCT.version });

const tx = (msg: Parameters<SpectreSocket['send']>[0], warn = true): boolean => {
  const ok = ws.send(msg);
  if (!ok && warn) toast('SERVER NOT CONNECTED', 'warn');
  return ok;
};

/* ====================================================================== */
/* Renderers                                                              */
/* ====================================================================== */

function renderPose(): void {
  renderPoseText(pose);
  const pan = pose?.pan ?? null;
  const tilt = pose?.tilt ?? null;
  const tiltSlider = byId<HTMLInputElement>('widget-tilt-slider');
  const tiltLabel = byId('widget-tilt-slider-label');
  if (tilt != null && tiltSlider && document.activeElement !== tiltSlider) {
    tiltSlider.value = String(clamp(tilt, TILT_MIN, TILT_MAX));
  }
  if (tiltLabel && document.activeElement !== tiltSlider) {
    tiltLabel.textContent = tilt == null ? '—°' : fmtTilt(tilt);
  }
  if (!sphereDragging && pan != null && tilt != null) {
    paintSphereAim('widget', pan, tilt);
  } else if (!sphereDragging) {
    byId('dome-vector-layer')?.setAttribute('opacity', '0.2');
  }
}

function linkStatusLabel(s: SerialStatus): string {
  if (!(s.connected && s.path)) return 'No Device Connected';
  const isUdp = s.transport === 'udp' || /^udp:\/\//i.test(s.path);
  return isUdp ? 'Connected via LAN' : 'Connected via Serial';
}

function applyStatus(s: SerialStatus): void {
  const online = !!(s.connected && s.path);
  // Never surface COM paths or udp://host:port in the overlay heading.
  bindText('link-port', linkStatusLabel(s));
  setDot('link', online ? 'on' : 'err');
  widget.classList.toggle('is-offline', !online);
  const banner = byId('widget-offline-banner');
  if (banner) {
    banner.hidden = online;
    banner.setAttribute('aria-hidden', String(online));
  }
  const chip = byId('widget-link-chip');
  chip?.classList.toggle('text-error', !online);
  chip?.classList.toggle('text-primary-fixed', online);
  chip?.setAttribute(
    'title',
    online ? linkStatusLabel(s) : 'No device connected — overlay stays open',
  );
}

function markActivePreset(id: number | null): void {
  qsa('.preset-card').forEach((card) => {
    const on = id != null && card.dataset.preset === String(id);
    card.classList.toggle('bg-surface-container', on);
    card.classList.toggle('bg-surface-container-low', !on);
    card.classList.toggle('shadow-[0_0_8px_rgba(255,186,32,0.3)]', on);
  });
}

function applyPresets(presets: PresetInfo[], active?: number | null): void {
  for (const p of presets) {
    if (p.id < 1 || p.id > 9) continue;
    const name = byId(`w-preset-${p.id}-name`);
    const val = byId(`w-preset-${p.id}-val`);
    const dot = byId(`w-preset-${p.id}-dot`);
    const card = byId(`w-preset-${p.id}`);
    const stored = p.pan != null || p.tilt != null;
    if (name && p.label) name.textContent = p.label;
    if (val) {
      // Widget: name + pan/tilt degrees only — whole card is quick-call.
      val.textContent = stored
        ? `P ${p.pan != null ? Math.round(p.pan) + '°' : '—'}  T ${
            p.tilt != null ? (p.tilt >= 0 ? '+' : '') + Math.round(p.tilt) + '°' : '—'
          }`
        : 'empty · set on console';
    }
    if (dot) dot.dataset.state = stored ? 'on' : 'off';
    if (card) {
      card.title = stored
        ? `Call ${p.label ?? p.id}: pan ${p.pan?.toFixed?.(1) ?? '—'}° / tilt ${p.tilt?.toFixed?.(1) ?? '—'}°`
        : `${p.label ?? p.id} empty — SET on console`;
      card.classList.toggle('opacity-55', !stored);
    }
  }
  if (active !== undefined) markActivePreset(active);
}

function setSpeedMode(next: SpeedMode): void {
  mode = next;
  qsa('.speed-btn').forEach((b) => {
    const on = b.dataset.mode === next;
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('bg-primary-container', on && next === 'creep');
    b.classList.toggle('bg-secondary-container', on && next === 'max');
    b.classList.toggle('text-on-primary-container', on && next === 'creep');
    b.classList.toggle('text-on-secondary-container', on && next === 'max');
    b.classList.toggle('font-semibold', on);
    b.classList.toggle('bg-surface-container', !on);
    b.classList.toggle('text-on-surface-variant', !on);
  });
}

const LAND_RES = [0.5, 1, 2] as const;

function snapLandRes(v: number | undefined): (typeof LAND_RES)[number] {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1;
  let best: (typeof LAND_RES)[number] = 1;
  let bestD = Number.POSITIVE_INFINITY;
  for (const c of LAND_RES) {
    const d = Math.abs(c - n);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

function syncLandingResUi(deadband: number | undefined): void {
  const deg = snapLandRes(deadband);
  qsa<HTMLButtonElement>('.land-res-btn').forEach((b) => {
    const on = Number(b.dataset.deg) === deg;
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('bg-secondary-container', on);
    b.classList.toggle('text-on-secondary-container', on);
    b.classList.toggle('font-semibold', on);
    b.classList.toggle('bg-surface-container', !on);
    b.classList.toggle('text-on-surface-variant', !on);
  });
}

function setPinned(next: boolean): void {
  pinned = next;
  const btn = byId('widget-pin-btn');
  btn?.setAttribute('aria-pressed', String(next));
  btn?.classList.toggle('text-primary-fixed-dim', next);
  btn?.classList.toggle('text-outline', !next);
  btn?.setAttribute('title', next ? 'Pinned — always on top' : 'Unpinned — click to pin');
  byId('widget-pin-icon')?.classList.toggle('fill', next);
  shell()?.setPinned(next);
}

/** Fit Electron overlay height to content; shell keeps the bottom edge fixed. */
function syncShellHeight(): void {
  const el = byId('spectre-widget');
  if (!el) return;
  const h = Math.ceil(el.getBoundingClientRect().height) + 12;
  shell()?.setContentHeight?.(h);
}

function preferReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

function stopMinimizeTrack(): void {
  if (minimizeRaf) {
    cancelAnimationFrame(minimizeRaf);
    minimizeRaf = 0;
  }
  if (minimizeTimer) {
    window.clearTimeout(minimizeTimer);
    minimizeTimer = 0;
  }
}

/** Track shell height while body max-height / transform tweens. */
function trackShellDuring(ms: number, onDone: () => void): void {
  stopMinimizeTrack();
  const start = performance.now();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    stopMinimizeTrack();
    onDone();
  };
  const tick = () => {
    syncShellHeight();
    if (performance.now() - start < ms) {
      minimizeRaf = requestAnimationFrame(tick);
    } else {
      minimizeRaf = 0;
      finish();
    }
  };
  minimizeRaf = requestAnimationFrame(tick);
  minimizeTimer = window.setTimeout(finish, ms + 40);
}

function applyAutoDock(on: boolean): void {
  autoDockEnabled = on;
  shell()?.setAutoDock?.(on);
  if (on) shell()?.dockBottomRight?.();
}

/**
 * Collapse / expand body: content scrolls down on minimize, up on maximize.
 * Header stays put; shell height tracks via rAF (bottom edge fixed).
 */
function setMinimized(willMinimize: boolean, btn: HTMLElement): void {
  const body = byId('widget-body');
  if (!body) return;

  const icon = byId('widget-minimize-icon');
  btn.setAttribute('aria-expanded', String(!willMinimize));
  if (icon) icon.textContent = willMinimize ? 'expand_more' : 'expand_less';

  const instant = preferReducedMotion();
  const duration = instant ? 0 : MINIMIZE_MS;

  if (willMinimize) {
    const startH = body.scrollHeight;
    body.style.display = 'flex';
    body.style.overflow = 'hidden';
    body.style.maxHeight = `${startH}px`;
    body.style.opacity = '1';
    body.style.transform = 'translateY(0)';
    void body.offsetHeight;
    widget.classList.add('is-minimized');
    if (instant) {
      body.style.maxHeight = '0px';
      body.style.opacity = '0';
      body.style.transform = `translateY(${Math.round(startH * 0.35)}px)`;
      body.style.display = 'none';
      syncShellHeight();
      return;
    }
    body.style.maxHeight = '0px';
    body.style.opacity = '0';
    body.style.transform = `translateY(${Math.round(startH * 0.35)}px)`;
    trackShellDuring(duration, () => {
      body.style.display = 'none';
      body.style.transform = '';
      syncShellHeight();
    });
  } else {
    widget.classList.remove('is-minimized');
    body.style.display = 'flex';
    body.style.overflow = 'hidden';
    body.style.maxHeight = '0px';
    body.style.opacity = '0';
    body.style.transform = 'translateY(24px)';
    void body.offsetHeight;
    const endH = body.scrollHeight;
    if (instant) {
      body.style.maxHeight = '';
      body.style.opacity = '1';
      body.style.transform = '';
      body.style.overflow = '';
      syncShellHeight();
      if (autoDockEnabled) shell()?.dockBottomRight?.();
      return;
    }
    body.style.maxHeight = `${endH}px`;
    body.style.opacity = '1';
    body.style.transform = 'translateY(0)';
    trackShellDuring(duration, () => {
      body.style.maxHeight = '';
      body.style.overflow = '';
      body.style.transform = '';
      syncShellHeight();
      if (autoDockEnabled) shell()?.dockBottomRight?.();
    });
  }
}

function clampOpacityFraction(v: number): number {
  return clamp(v, 0.4, 1);
}

function syncOpacityUi(fraction: number): void {
  const pct = Math.round(fraction * 100);
  const slider = byId<HTMLInputElement>('widget-opacity-slider');
  const label = byId('widget-opacity-val');
  if (slider && document.activeElement !== slider) {
    slider.value = String(fraction);
    slider.setAttribute('aria-valuenow', String(pct));
  }
  if (label) label.textContent = `${pct}%`;
}

function applyOpacity(fraction: number, persistLocal = true): void {
  widgetOpacity = clampOpacityFraction(fraction);
  syncOpacityUi(widgetOpacity);
  shell()?.setOpacity(widgetOpacity);
  if (persistLocal) storeOpacity(Math.round(widgetOpacity * 100));
}

function setOpacityPopover(open: boolean): void {
  const pop = byId('widget-opacity-popover');
  const btn = byId('widget-opacity-btn');
  pop?.setAttribute('data-open', String(open));
  btn?.setAttribute('aria-expanded', String(open));
}

function flash(cls: string[], ms = 800): void {
  widget.classList.add(...cls);
  window.setTimeout(() => widget.classList.remove(...cls), ms);
}

function readNum(id: string): number | null {
  const v = parseFloat(byId<HTMLInputElement>(id)?.value ?? '');
  return Number.isFinite(v) ? v : null;
}

/* ====================================================================== */
/* Actions (data-action)                                                  */
/* ====================================================================== */

bindActions({
  halt: () => {
    sphereDragging = false;
    flash(['ring-2', 'ring-error']);
    tx({ type: 'halt', source: 'widget' });
  },
  home: () => {
    tx({ type: 'home', source: 'widget' });
  },
  goto: () => {
    const pan = readNum('widget-goto-pan');
    const tilt = readNum('widget-goto-tilt');
    if (pan == null && tilt == null) {
      toast('ENTER PAN AND/OR TILT', 'warn');
      return;
    }
    tx({
      type: 'goto',
      pan: pan == null ? undefined : normalizePanCommand(pan),
      tilt: tilt == null ? undefined : clamp(tilt, TILT_MIN, TILT_MAX),
      source: 'widget',
    });
  },
  'tilt-slider': (el, ev) => {
    const input = el as HTMLInputElement;
    const tilt = clamp(parseFloat(input.value), TILT_MIN, TILT_MAX);
    const label = byId('widget-tilt-slider-label');
    if (label) label.textContent = fmtTilt(tilt);
    if (ev.type === 'change') {
      tx({ type: 'goto', tilt, source: 'widget' });
    }
  },
  'preset-call': (el) => {
    const id = Number(el.dataset.preset);
    if (!Number.isFinite(id)) return;
    // Quick-call only when the slot has been SET on the console.
    const val = byId(`w-preset-${id}-val`)?.textContent ?? '';
    if (/empty/i.test(val) || val.trim() === '—' || val.trim() === '') return;
    markActivePreset(id);
    tx({ type: 'preset.call', id, source: 'widget' });
  },
  'speed-mode': (el) => {
    setSpeedMode(el.dataset.mode === 'max' ? 'max' : 'creep');
  },
  'landing-res': (el) => {
    const deg = snapLandRes(Number(el.dataset.deg));
    syncLandingResUi(deg);
    tx({ type: 'settings.update', patch: { approach: { deadband: deg } } });
    toast(`LAND ±${deg}°`);
  },
  'widget-minimize': (el) => {
    setOpacityPopover(false);
    const willMinimize = !widget.classList.contains('is-minimized');
    setMinimized(willMinimize, el);
  },
  'widget-pin': () => {
    setOpacityPopover(false);
    setPinned(!pinned);
    tx({ type: 'widget.pinned', pinned }, false);
  },
  'widget-opacity-toggle': () => {
    const pop = byId('widget-opacity-popover');
    const open = pop?.getAttribute('data-open') !== 'true';
    setOpacityPopover(open);
  },
  'widget-opacity': (el) => {
    const v = clampOpacityFraction(parseFloat((el as HTMLInputElement).value));
    applyOpacity(v);
    tx({ type: 'widget.opacity', opacity: v }, false);
  },
  'open-console': () => {
    openConsoleInBrowser();
  },
});

document.addEventListener('pointerdown', (ev) => {
  const wrap = byId('widget-opacity-wrap');
  if (!wrap) return;
  if (wrap.contains(ev.target as Node)) return;
  setOpacityPopover(false);
});

bindDegreeNudge({
  getStep: () => STEP_BY_MODE[mode],
  getPose: () => pose,
  onNudge: (target, _flags, el) => {
    el.classList.add('is-held');
    tx({ type: 'goto', pan: target.pan, tilt: target.tilt, source: 'widget' });
  },
  onIdle: () => {
    qsa('.jog-btn').forEach((b) => b.classList.remove('is-held'));
  },
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    sphereDragging = false;
    flash(['ring-2', 'ring-error']);
    tx({ type: 'halt', source: 'widget' });
  }
});

/* ====================================================================== */
/* Server messages                                                        */
/* ====================================================================== */

ws.on('pose', (m) => {
  pose = { pan: m.pan, tilt: m.tilt, panRaw: m.panRaw, tiltRaw: m.tiltRaw, updatedAt: m.updatedAt };
  renderPose();
});
ws.on('status', (m) =>
  applyStatus({
    connected: m.connected,
    path: m.path,
    baudRate: m.baudRate,
    address: m.address,
    transport: (m as { transport?: 'serial' | 'udp' }).transport,
  }),
);
ws.on('presets', (m) => applyPresets(m.presets, m.active));
ws.on('settings', (m) => {
  const tMin = m.settings.limits?.tiltMin;
  const tMax = m.settings.limits?.tiltMax;
  if (typeof tMin === 'number' && typeof tMax === 'number') setTiltLimits(tMin, tMax);
  if (m.settings.widgetPinned != null) setPinned(m.settings.widgetPinned);
  if (m.settings.widgetAutoDock != null) applyAutoDock(!!m.settings.widgetAutoDock);
  if (typeof m.settings.widgetOpacity === 'number') applyOpacity(m.settings.widgetOpacity, false);
  syncLandingResUi(m.settings.approach?.deadband);
});
ws.on('error', (m) => toast(`SERVER: ${m.message}`, 'warn'));

ws.onState((s) => {
  renderWsState(s, ws.latencyMs);
  if (s === 'open') {
    ws.send({ type: 'settings.get' });
    ws.send({ type: 'presets.get' });
    ws.send({ type: 'pose.refresh' });
  } else {
    applyStatus({ connected: false, path: null, baudRate: 9600, address: 1 });
  }
});
window.setInterval(() => renderWsState(ws.state, ws.latencyMs), 1000);

/* ====================================================================== */
/* Boot                                                                   */
/* ====================================================================== */

setSpeedMode('creep');
setPinned(true);
applyOpacity(readStoredOpacity() / 100);
applyAutoDock(true);
paintSectorBadges('widget');
renderPose();
applyStatus({ connected: false, path: null, baudRate: 9600, address: 1 });
requestAnimationFrame(() => syncShellHeight());
window.addEventListener('resize', () => {
  if (!widget.classList.contains('is-minimized')) syncShellHeight();
});

/* Interactive 2D pan pad — tilt comes only from the tilt slider / live pose */
{
  const svg = byId<SVGSVGElement>('dome-sphere-svg');
  const hit = byId<SVGCircleElement>('dome-hit');
  const CX = 72;
  const CY = 72;
  const R = 60;
  const clientToLocal = (clientX: number, clientY: number) => {
    if (!svg) return { x: CX, y: CY };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: CX, y: CY };
    const local = pt.matrixTransform(ctm.inverse());
    return { x: local.x, y: local.y };
  };
  bindSphereControl(hit, {
    cx: CX,
    cy: CY,
    r: R,
    clientToLocal,
    liveCommitMs: 700,
    getPreferPan: () => pose?.pan ?? null,
    getTilt: () => {
      const slider = byId<HTMLInputElement>('widget-tilt-slider');
      if (slider && document.activeElement === slider) return parseFloat(slider.value);
      return pose?.tilt ?? 0;
    },
    onDragStart: () => {
      sphereDragging = true;
    },
    onDragEnd: () => {
      sphereDragging = false;
    },
    onPreview: (pan, tilt) => paintSphereAim('widget', pan, tilt),
    onCommit: (pan, tilt) => {
      tx({ type: 'goto', pan, tilt, source: 'widget' });
    },
  });
}

console.info(`[spectre] widget ${PRODUCT.version} · available on port ${resolveHttpPort()}`);
ws.connect();
