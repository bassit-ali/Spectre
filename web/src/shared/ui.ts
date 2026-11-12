import { clampHttpPort, endpointChipText, resolveHttpPort } from './endpoint';
import type { MoveFlags, PoseMsg } from './protocol';
import type { WsState } from './ws-client';

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

export const byId = <T extends Element = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

export const qsa = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll<T>(sel));

/** Set text of every element carrying data-bind="<name>". */
export function bindText(name: string, text: string): void {
  qsa(`[data-bind="${name}"]`).forEach((el) => {
    el.textContent = text;
  });
}

/** Set width % of every element carrying data-bar="<name>". */
export function bindBar(name: string, pct: number): void {
  const w = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
  qsa(`[data-bar="${name}"]`).forEach((el) => {
    el.style.width = w;
  });
}

export type DotState = 'on' | 'warn' | 'off' | 'err';
export function setDot(name: string, state: DotState): void {
  qsa(`[data-dot="${name}"]`).forEach((el) => {
    el.dataset.state = state;
  });
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const DASH = '—';

export function fmtPan(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return `${DASH}°`;
  return `${v.toFixed(2).padStart(6, '0')}°`;
}

export function fmtTilt(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return `${DASH}°`;
  const abs = Math.abs(v).toFixed(2).padStart(5, '0');
  return `${v < 0 ? '-' : '+'}${abs}°`;
}

export function fmtRaw(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '0x----';
  return `0x${(v & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Pan angle as whole degrees (no compass — platform has no north reference). */
export function fmtPanShort(az: number | null | undefined): string {
  if (az == null || Number.isNaN(az)) return DASH;
  const d = ((az % 360) + 360) % 360;
  return `${Math.round(d).toString().padStart(3, '0')}°`;
}

/** @deprecated compass removed — alias of fmtPanShort for older call sites */
export function cardinal(az: number | null | undefined): string {
  return fmtPanShort(az);
}

/**
 * Live soft limits — updated from server settings.
 * Table convention: 0° = level (middle), + = tilt up, − = tilt down.
 * Hardcoded soft limits for this head: ±50°.
 */
export const TILT_MIN = -50;
export const TILT_MAX = 50;

/** Kept for call sites — tilt limits are hardcoded ±50 and cannot be changed. */
export function setTiltLimits(_min?: number, _max?: number): void {
  /* fixed ±50 */
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * 2D top-down pan pad (SAME math for console + widget):
 *  - Angle from center = pan (0° top, 90° right, 180° bottom, 270° left)
 *  - Tilt is NOT on this pad — use the dedicated vertical tilt slider
 */
/**
 * Camera FOV sectors (≈120° each) on pan:
 * Sector A @ 0° · Sector B @ 120° · Sector C @ 240°
 */
export const SPHERE_SECTOR_MARKS = [
  { sector: 'A', pan: 0 },
  { sector: 'B', pan: 120 },
  { sector: 'C', pan: 240 },
] as const;

export const SPHERE_LAYOUT = {
  console: { cx: 130, cy: 120, r: 100 },
  widget: { cx: 72, cy: 72, r: 60 },
} as const;

/** Aim marker sits on this fraction of the pad radius (clear of the hub). */
const PAD_AIM_R = 0.78;
const PAD_BADGE_R = 0.92;
const PAD_TICK_R = 0.72;

/**
 * Sector chip anchors on the 2D pan ring.
 * A@0° top · B@120° lower-right · C@240° lower-left.
 */
export function sphereBadgePoint(
  pan: number,
  cx: number,
  cy: number,
  r: number,
): { x: number; y: number } {
  return projectPan2D(pan, cx, cy, r * PAD_BADGE_R);
}

/** Rim tick where the sector pan meets the aim ring. */
function sphereSectorTick(
  pan: number,
  cx: number,
  cy: number,
  r: number,
): { x: number; y: number } {
  return projectPan2D(pan, cx, cy, r * PAD_TICK_R);
}

/** Clean A/B/C sector tags — small chips + short leaders, no clustered blocks. */
export function paintSectorBadges(which: 'console' | 'widget'): void {
  const isConsole = which === 'console';
  const layout = SPHERE_LAYOUT[isConsole ? 'console' : 'widget'];
  const host = byId(isConsole ? 'sphere-pan-badges' : 'dome-pan-badges');
  if (!host) return;

  const ns = 'http://www.w3.org/2000/svg';
  const el = <K extends keyof SVGElementTagNameMap>(name: K) =>
    document.createElementNS(ns, name) as SVGElementTagNameMap[K];

  host.replaceChildren();
  host.setAttribute('pointer-events', 'none');
  host.setAttribute('aria-label', 'Camera sectors A 0° B 120° C 240°');

  const chipW = isConsole ? 46 : 34;
  const chipH = isConsole ? 18 : 14;
  const fs = isConsole ? 9 : 7;

  for (const mark of SPHERE_SECTOR_MARKS) {
    const tick = sphereSectorTick(mark.pan, layout.cx, layout.cy, layout.r);
    const label = sphereBadgePoint(mark.pan, layout.cx, layout.cy, layout.r);

    const spoke = el('line');
    spoke.setAttribute('x1', String(layout.cx));
    spoke.setAttribute('y1', String(layout.cy));
    spoke.setAttribute('x2', tick.x.toFixed(1));
    spoke.setAttribute('y2', tick.y.toFixed(1));
    spoke.setAttribute('stroke', '#ffb4ab');
    spoke.setAttribute('stroke-width', isConsole ? '1' : '0.8');
    spoke.setAttribute('stroke-opacity', '0.35');
    spoke.setAttribute('stroke-dasharray', isConsole ? '2 3' : '1.5 2.5');
    host.append(spoke);

    const leader = el('line');
    leader.setAttribute('x1', tick.x.toFixed(1));
    leader.setAttribute('y1', tick.y.toFixed(1));
    leader.setAttribute('x2', label.x.toFixed(1));
    leader.setAttribute('y2', label.y.toFixed(1));
    leader.setAttribute('stroke', '#ffdad6');
    leader.setAttribute('stroke-width', isConsole ? '1.2' : '1');
    leader.setAttribute('stroke-opacity', '0.75');
    host.append(leader);

    const dot = el('circle');
    dot.setAttribute('cx', tick.x.toFixed(1));
    dot.setAttribute('cy', tick.y.toFixed(1));
    dot.setAttribute('r', isConsole ? '3' : '2.2');
    dot.setAttribute('fill', '#ffdad6');
    dot.setAttribute('stroke', '#9f1d15');
    dot.setAttribute('stroke-width', '1');
    host.append(dot);

    const g = el('g');
    g.setAttribute('transform', `translate(${label.x.toFixed(1)}, ${label.y.toFixed(1)})`);
    g.setAttribute('data-sector', mark.sector);
    g.setAttribute('data-pan', String(mark.pan));

    const chip = el('rect');
    chip.setAttribute('x', String(-chipW / 2));
    chip.setAttribute('y', String(-chipH / 2));
    chip.setAttribute('width', String(chipW));
    chip.setAttribute('height', String(chipH));
    chip.setAttribute('rx', String(chipH / 2));
    chip.setAttribute('fill', '#1a0a0a');
    chip.setAttribute('fill-opacity', '0.88');
    chip.setAttribute('stroke', '#ffb4ab');
    chip.setAttribute('stroke-width', isConsole ? '1.2' : '1');

    const text = el('text');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('y', '0.5');
    text.setAttribute('fill', '#ffdad6');
    text.setAttribute('font-family', 'ui-monospace, monospace');
    text.setAttribute('font-size', String(fs));
    text.setAttribute('font-weight', '700');
    text.setAttribute('letter-spacing', '0.04em');
    text.textContent = `${mark.sector} ${mark.pan}°`;

    g.append(chip, text);
    host.append(g);
  }
}

function normPan360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Signed pan in (−180, +180]. */
function toSigned180Local(deg: number): number {
  let d = ((((deg + 180) % 360) + 360) % 360) - 180;
  if (d <= -180) return 180;
  return d;
}

/**
 * Accept device 0..360 or signed travel −180..+180 → device pan 0..360.
 * Example: −160 → 200°, 160 → 160°, 350 → 350°.
 */
export function normalizePanCommand(pan: number): number {
  if (!Number.isFinite(pan)) return 0;
  if (pan < 0 || pan > 360) {
    const s = toSigned180Local(pan);
    return s < 0 ? s + 360 : s;
  }
  return pan;
}

/** Plot pan on the 2D pad: 0° = top, 90° = right, 180° = bottom, 270° = left. */
export function projectPan2D(pan: number, cx: number, cy: number, r: number): { x: number; y: number } {
  const az = (normPan360(pan) * Math.PI) / 180;
  return {
    x: cx + r * Math.sin(az),
    y: cy - r * Math.cos(az),
  };
}

/**
 * Read pan from a pad click. Angle-only — no front/back ambiguity.
 * Dead-center keeps `preferPan` (or 0°) so home stays stable.
 */
export function unprojectPan2D(
  x: number,
  y: number,
  cx: number,
  cy: number,
  preferPan?: number,
): number {
  const sx = x - cx;
  const sy = cy - y; // screen-up → +north
  if (Math.hypot(sx, sy) < 6) {
    if (preferPan != null && Number.isFinite(preferPan)) return normPan360(preferPan);
    return 0;
  }
  return normPan360((Math.atan2(sx, sy) * 180) / Math.PI);
}

/** @deprecated alias — 2D pad ignores tilt; kept for older call sites / tests. */
export function projectVector(pan: number, _tilt: number, cx: number, cy: number, r: number): { x: number; y: number } {
  return projectPan2D(pan, cx, cy, r * PAD_AIM_R);
}

/** @deprecated alias — returns pan from 2D pad; tilt always 0 (use the tilt slider). */
export function unprojectVector(
  x: number,
  y: number,
  cx: number,
  cy: number,
  _r?: number,
  preferPan?: number,
): { pan: number; tilt: number } {
  return { pan: unprojectPan2D(x, y, cx, cy, preferPan), tilt: 0 };
}

/**
 * Pointer drag on the 2D pan pad.
 * Preview updates every move; motor commits sparsely so RS-485 is not flooded.
 * Tilt is supplied by the caller (live pose / tilt slider) — never from the pad.
 */
export function bindSphereControl(
  hit: HTMLElement | SVGGraphicsElement | null,
  opts: {
    cx: number;
    cy: number;
    r: number;
    clientToLocal: (clientX: number, clientY: number) => { x: number; y: number };
    onPreview: (pan: number, tilt: number) => void;
    onCommit: (pan: number, tilt: number) => void;
    onDragStart?: () => void;
    onDragEnd?: () => void;
    getPreferPan?: () => number | null | undefined;
    /** Current tilt to pair with pan commits (pad itself does not encode tilt). */
    getTilt?: () => number | null | undefined;
    liveCommitMs?: number;
  },
): void {
  if (!hit) return;
  let dragging = false;
  let pointerId: number | null = null;
  let lastSent = 0;
  let latestPan: number | null = null;
  let preferPan: number | null = null;
  const liveMs = opts.liveCommitMs ?? 700;

  const tiltNow = () => {
    const t = opts.getTilt?.();
    return t != null && Number.isFinite(t) ? clamp(t, TILT_MIN, TILT_MAX) : 0;
  };

  const sample = (ev: PointerEvent, forceCommit = false) => {
    const local = opts.clientToLocal(ev.clientX, ev.clientY);
    const pan = unprojectPan2D(local.x, local.y, opts.cx, opts.cy, preferPan ?? undefined);
    preferPan = pan;
    latestPan = pan;
    const tilt = tiltNow();
    opts.onPreview(pan, tilt);
    if (!forceCommit && liveMs <= 0) return;
    const now = performance.now();
    if (forceCommit || (liveMs > 0 && now - lastSent >= liveMs)) {
      lastSent = now;
      opts.onCommit(pan, tilt);
    }
  };

  hit.addEventListener('pointerdown', (raw) => {
    const ev = raw as PointerEvent;
    if (ev.button !== 0) return;
    ev.preventDefault();
    dragging = true;
    pointerId = ev.pointerId;
    lastSent = 0;
    const seed = opts.getPreferPan?.();
    preferPan = seed != null && Number.isFinite(seed) ? normPan360(seed) : null;
    opts.onDragStart?.();
    try {
      (hit as Element).setPointerCapture?.(ev.pointerId);
    } catch {
      /* optional */
    }
    sample(ev, false);
  });
  hit.addEventListener('pointermove', (raw) => {
    const ev = raw as PointerEvent;
    if (!dragging || (pointerId != null && ev.pointerId !== pointerId)) return;
    sample(ev, false);
  });
  const end = (raw: Event) => {
    const ev = raw as PointerEvent;
    if (!dragging || (pointerId != null && ev.pointerId !== pointerId)) return;
    dragging = false;
    pointerId = null;
    if (latestPan != null) {
      const tilt = tiltNow();
      opts.onPreview(latestPan, tilt);
      opts.onCommit(latestPan, tilt);
    }
    latestPan = null;
    preferPan = null;
    opts.onDragEnd?.();
  };
  hit.addEventListener('pointerup', end);
  hit.addEventListener('pointercancel', end);
}

/** Paint the console / widget aim marker from pan (2D ring) + tilt readout. */
export function paintSphereAim(
  which: 'console' | 'widget',
  pan: number,
  tilt: number,
): void {
  const layout = SPHERE_LAYOUT[which === 'console' ? 'console' : 'widget'];
  const { x, y } = projectPan2D(pan, layout.cx, layout.cy, layout.r * PAD_AIM_R);
  if (which === 'console') {
    const layer = byId('sphere-vector-layer');
    layer?.setAttribute('opacity', '1');
    const beam = byId('sphere-vector-beam');
    beam?.setAttribute('x2', x.toFixed(1));
    beam?.setAttribute('y2', y.toFixed(1));
    beam?.setAttribute('stroke-dasharray', '4,2');
    beam?.setAttribute('stroke', '#00dbe9');
    byId('sphere-hub-ring')?.setAttribute('stroke', '#00dbe9');
    byId('sphere-hub-core')?.setAttribute('fill', '#00f0ff');
    byId('vector-target-node')?.setAttribute('transform', `translate(${x.toFixed(1)}, ${y.toFixed(1)})`);
    byId('sphere-aim-glow')?.setAttribute('fill', 'url(#cursorGlow)');
    byId('sphere-aim-ring')?.setAttribute('stroke', '#00f0ff');
    byId('sphere-aim-core')?.setAttribute('fill', '#dbfcff');
    byId('sphere-aim-h')?.setAttribute('stroke', '#00f0ff');
    byId('sphere-aim-v')?.setAttribute('stroke', '#00f0ff');
    const aimTag = byId('sphere-aim-label');
    if (aimTag) aimTag.textContent = fmtPan(pan);
    const dir = byId('sphere-direction-readout');
    const hgt = byId('sphere-height-readout');
    if (dir) dir.textContent = fmtPan(pan);
    if (hgt) {
      const tag =
        Math.abs(tilt) < 1 ? ' [LEVEL / STORAGE]' : tilt > 0 ? ' [UP]' : ' [DOWN]';
      hgt.textContent = `${fmtTilt(tilt)}${tag}`;
    }
    return;
  }
  const domeLayer = byId('dome-vector-layer');
  domeLayer?.setAttribute('opacity', '1');
  const domeBeam = byId('dome-beam');
  domeBeam?.setAttribute('x2', x.toFixed(1));
  domeBeam?.setAttribute('y2', y.toFixed(1));
  domeBeam?.setAttribute('stroke-dasharray', '4,2');
  domeBeam?.setAttribute('stroke', '#00dbe9');
  const node = byId('dome-node');
  node?.setAttribute('cx', x.toFixed(1));
  node?.setAttribute('cy', y.toFixed(1));
  node?.setAttribute('fill', '#00f0ff');
  node?.setAttribute('stroke', '#dbfcff');
  const ping = byId('dome-ping');
  ping?.setAttribute('cx', x.toFixed(1));
  ping?.setAttribute('cy', y.toFixed(1));
  ping?.setAttribute('stroke', '#00f0ff');
  const domeTag = byId('dome-aim-label');
  if (domeTag) {
    domeTag.setAttribute('x', x.toFixed(1));
    domeTag.setAttribute('y', (y - 10).toFixed(1));
    domeTag.textContent = fmtPanShort(pan);
  }
}

/* ------------------------------------------------------------------ */
/* data-action dispatcher                                              */
/* ------------------------------------------------------------------ */

export type ActionHandler = (el: HTMLElement, ev: Event) => void;

export function bindActions(
  handlers: Record<string, ActionHandler>,
  root: ParentNode = document,
): void {
  const fire = (ev: Event) => {
    const el = (ev.target as Element | null)?.closest?.('[data-action]') as HTMLElement | null;
    if (!el) return;
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
      // Skip raw click on inputs/selects; also skip input events on checkboxes
      // (they fire via change). Ranges/text use input + change.
      if (
        ev.type === 'click' ||
        (el instanceof HTMLInputElement && el.type === 'checkbox' && ev.type === 'input')
      ) {
        return;
      }
    } else if (ev.type !== 'click') {
      return;
    }
    const name = el.dataset.action;
    if (!name) return;
    const fn = handlers[name];
    if (fn) fn(el, ev);
    else console.warn(`[spectre] no handler for data-action="${name}"`);
  };
  root.addEventListener('click', fire);
  root.addEventListener('input', fire);
  root.addEventListener('change', fire);
}

/* ------------------------------------------------------------------ */
/* Hold-to-jog (data-jog="up|down|left|right|upleft|...")              */
/* ------------------------------------------------------------------ */

function flagsFromJog(token: string): MoveFlags {
  const flags: MoveFlags = {};
  if (token.includes('up')) flags.up = true;
  if (token.includes('down')) flags.down = true;
  if (token.includes('left')) flags.left = true;
  if (token.includes('right')) flags.right = true;
  return flags;
}

export function bindHoldJog(
  onStart: (flags: MoveFlags, el: HTMLElement) => void,
  onEnd: () => void,
): void {
  let activePointer: number | null = null;
  let held = false;

  const release = (pointerId?: number) => {
    if (!held) return;
    if (pointerId != null && activePointer != null && pointerId !== activePointer) return;
    held = false;
    activePointer = null;
    onEnd();
  };

  qsa('[data-jog]').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      activePointer = e.pointerId;
      held = true;
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        /* optional */
      }
      onStart(flagsFromJog(btn.dataset.jog ?? ''), btn);
    });
    btn.addEventListener('pointerup', (e) => release(e.pointerId));
    btn.addEventListener('pointercancel', (e) => release(e.pointerId));
    btn.addEventListener('lostpointercapture', (e) => release(e.pointerId));
  });
  window.addEventListener('blur', () => release());
  document.addEventListener('pointerup', (e) => release(e.pointerId));
}

/**
 * Degree-step nudges on [data-jog]: one click = ±getStep()° closed-loop goto;
 * hold repeats the same nudge on an interval (not free-speed jog).
 */
export function bindDegreeNudge(opts: {
  getStep: () => number;
  getPose: () => { pan?: number | null; tilt?: number | null } | null;
  onNudge: (target: { pan?: number; tilt?: number }, flags: MoveFlags, el: HTMLElement) => void;
  onIdle?: () => void;
  repeatMs?: number;
}): void {
  const repeatMs = opts.repeatMs ?? 450;
  let activePointer: number | null = null;
  let held = false;
  let timer: number | undefined;
  let activeBtn: HTMLElement | null = null;
  let activeFlags: MoveFlags = {};

  const fire = () => {
    if (!activeBtn) return;
    const step = Math.max(0.05, opts.getStep());
    const p = opts.getPose();
    const pan0 = p?.pan;
    const tilt0 = p?.tilt;
    const target: { pan?: number; tilt?: number } = {};
    if (activeFlags.left || activeFlags.right) {
      const base = pan0 != null && Number.isFinite(pan0) ? pan0 : 0;
      const delta = activeFlags.left ? -step : step;
      target.pan = normalizePanCommand(base + delta);
    }
    if (activeFlags.up || activeFlags.down) {
      const base = tilt0 != null && Number.isFinite(tilt0) ? tilt0 : 0;
      const delta = activeFlags.up ? step : -step;
      target.tilt = clamp(base + delta, TILT_MIN, TILT_MAX);
    }
    if (target.pan == null && target.tilt == null) return;
    opts.onNudge(target, activeFlags, activeBtn);
  };

  const release = (pointerId?: number) => {
    if (!held) return;
    if (pointerId != null && activePointer != null && pointerId !== activePointer) return;
    held = false;
    activePointer = null;
    activeBtn = null;
    activeFlags = {};
    if (timer != null) {
      window.clearInterval(timer);
      timer = undefined;
    }
    opts.onIdle?.();
  };

  qsa('[data-jog]').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      activePointer = e.pointerId;
      held = true;
      activeBtn = btn;
      activeFlags = flagsFromJog(btn.dataset.jog ?? '');
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        /* optional */
      }
      fire();
      timer = window.setInterval(fire, repeatMs);
    });
    btn.addEventListener('pointerup', (e) => release(e.pointerId));
    btn.addEventListener('pointercancel', (e) => release(e.pointerId));
    btn.addEventListener('lostpointercapture', (e) => release(e.pointerId));
  });
  window.addEventListener('blur', () => release());
  document.addEventListener('pointerup', (e) => release(e.pointerId));
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

let toastEl: HTMLDivElement | null = null;
let toastTimer: number | undefined;

export function toast(msg: string, kind: 'info' | 'warn' | 'err' = 'info'): void {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'toast';
    toastEl.setAttribute('role', 'status');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.dataset.kind = kind;
  toastEl.classList.add('toast-show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove('toast-show'), 1600);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function bindEndpointChips(port: number = resolveHttpPort()): void {
  const p = clampHttpPort(port);
  const text = endpointChipText(p);
  qsa('[data-endpoint-chip]').forEach((n) => {
    const t = n.querySelector('[data-endpoint-text]');
    if (t) t.textContent = text;
    n.dataset.copy = String(p);
    n.title = `Copy port ${p}`;
  });
  qsa('[data-bind="http-port"]').forEach((el) => {
    el.textContent = String(p);
  });
  const portInput = byId<HTMLInputElement>('http-port-input');
  if (portInput && document.activeElement !== portInput) portInput.value = String(p);
}

/** One-time click handler for copyable chips (port or other data-copy values). */
export function bindCopyChips(): void {
  document.addEventListener('click', async (n) => {
    const t = (n.target as Element | null)?.closest?.('[data-copy]') as HTMLElement | null;
    if (!t) return;
    n.preventDefault();
    const ok = await copyText(t.dataset.copy ?? '');
    toast(ok ? `COPIED  ${t.dataset.copy}` : 'COPY FAILED', ok ? 'info' : 'warn');
    t.classList.add('copied');
    window.setTimeout(() => t.classList.remove('copied'), 900);
  });
}

export function renderWsState(state: WsState, latencyMs: number | null): void {
  bindText('ws', state === 'open' ? 'WS CONNECTED' : state === 'connecting' ? 'WS CONNECTING' : 'WS NOT CONNECTED');
  bindText('ws-latency', state === 'open' && latencyMs != null ? `${latencyMs} ms` : DASH);
  setDot('ws', state === 'open' ? 'on' : state === 'connecting' ? 'warn' : 'off');
}

export function renderPoseText(pose: Partial<PoseMsg> | null | undefined): void {
  const pan = pose?.pan ?? null;
  const tilt = pose?.tilt ?? null;
  bindText('pan', fmtPan(pan));
  bindText('tilt', fmtTilt(tilt));
  bindText('pan-raw', fmtRaw(pose?.panRaw));
  bindText('tilt-raw', fmtRaw(pose?.tiltRaw));
  bindText('pan-cardinal', fmtPanShort(pan));
  bindText('pan-short', fmtPanShort(pan));
  bindText(
    'tilt-short',
    tilt == null ? DASH : `${tilt >= 0 ? '+' : ''}${Math.round(tilt)}°`,
  );
  bindBar('pan', pan == null ? 0 : (pan / 360) * 100);
  bindBar('tilt', tilt == null ? 0 : ((tilt - TILT_MIN) / (TILT_MAX - TILT_MIN)) * 100);
}

const OPACITY_MIN = 40;
const OPACITY_MAX = 100;
const OPACITY_DEFAULT = 95;
const OPACITY_KEY = 'spectre.widgetOpacity';

export function readStoredOpacity(): number {
  const n = Number(localStorage.getItem(OPACITY_KEY));
  return Number.isFinite(n) && n >= OPACITY_MIN && n <= OPACITY_MAX ? n : OPACITY_DEFAULT;
}

export function storeOpacity(n: number): number {
  const t = Math.round(clamp(n, OPACITY_MIN, OPACITY_MAX));
  try {
    localStorage.setItem(OPACITY_KEY, String(t));
  } catch {
    /* ignore */
  }
  return t;
}

export function onOpacityStorage(cb: (pct: number) => void): void {
  window.addEventListener('storage', (t) => {
    if (t.key === OPACITY_KEY) cb(readStoredOpacity());
  });
}
