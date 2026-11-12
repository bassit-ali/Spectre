import './styles/spectre.css';
import {
  PRODUCT,
  clampHttpPort,
  resolveHttpPort,
  resolveLocalWs,
} from './shared/endpoint';
import type {
  ClientMsg,
  PoseMsg,
  PortInfo,
  PresetInfo,
  SelfTestItem,
  SerialStatus,
  ServerMsg,
  Settings,
} from './shared/protocol';
import { SpectreSocket } from './shared/ws-client';
import {
  TILT_MAX,
  TILT_MIN,
  bindActions,
  bindCopyChips,
  bindEndpointChips,
  bindDegreeNudge,
  bindText,
  byId,
  clamp,
  fmtPan,
  fmtTilt,
  normalizePanCommand,
  bindSphereControl,
  paintSectorBadges,
  paintSphereAim,
  qsa,
  renderPoseText,
  renderWsState,
  setDot,
  setTiltLimits,
  toast,
} from './shared/ui';

/* ====================================================================== */
/* State                                                                  */
/* ====================================================================== */

let pose: Partial<PoseMsg> | null = null;
let jogStep = 1;
let selfTestTimer: number | undefined;
let status: SerialStatus = { connected: false, path: null, baudRate: 9600, address: 1 };
/** While dragging the sphere, don't let live pose overwrite the aim ball. */
let sphereDragging = false;

const ws = new SpectreSocket(resolveLocalWs(), {
  type: 'hello',
  client: 'console',
  version: PRODUCT.version,
});

/* ====================================================================== */
/* Wire log                                                               */
/* ====================================================================== */

function logLine(kind: 'TX' | 'RX' | 'SYS', text: string): void {
  const box = byId('wire-log');
  if (!box) return;
  const t = new Date();
  const ts = `${t.toTimeString().slice(0, 8)}.${String(t.getMilliseconds()).padStart(3, '0')}`;
  const row = document.createElement('div');
  row.className = kind === 'TX' ? 'text-primary-fixed-dim' : kind === 'RX' ? 'text-secondary' : 'text-outline';
  row.textContent = `${ts}  ${kind.padEnd(3)}  ${text.length > 180 ? text.slice(0, 177) + '…' : text}`;
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
  box.appendChild(row);
  while (box.childElementCount > 200) box.firstElementChild?.remove();
  if (stick) box.scrollTop = box.scrollHeight;
}

const QUIET: ReadonlySet<string> = new Set([
  'ping',
  'pong',
  'pose',
  'serial.tx',
  'serial.rx',
  'system.health',
  'encoderHealth',
]);

ws.onTx((m, sent) => {
  if (QUIET.has(String(m.type))) return;
  logLine('TX', `${sent ? '' : '(DROPPED – not connected) '}${JSON.stringify(m)}`);
});
ws.onAny((m) => {
  if (QUIET.has(String(m.type))) return;
  logLine('RX', JSON.stringify(m));
});

/** Send, warning the operator when the server link is down. */
function tx(msg: ClientMsg, warn = true): boolean {
  const ok = ws.send(msg);
  if (!ok && warn) toast('SERVER NOT CONNECTED — command not sent', 'warn');
  return ok;
}

/* ====================================================================== */
/* Renderers                                                              */
/* ====================================================================== */

function setMotion(text: string): void {
  bindText('motion', text);
}

function renderPose(): void {
  renderPoseText(pose);
  const pan = pose?.pan ?? null;
  const tilt = pose?.tilt ?? null;

  const dir = byId('sphere-direction-readout');
  const hgt = byId('sphere-height-readout');
  if (dir) dir.textContent = pan == null ? '—°' : fmtPan(pan);
  if (hgt) hgt.textContent = tilt == null ? '—°' : `${fmtTilt(tilt)}${Math.abs(tilt) < 1 ? ' [LEVEL / STORAGE]' : tilt > 0 ? ' [UP]' : ' [DOWN]'}`;

  const tiltSlider = byId<HTMLInputElement>('tilt-slider');
  if (tilt != null && tiltSlider && document.activeElement !== tiltSlider) tiltSlider.value = String(clamp(tilt, TILT_MIN, TILT_MAX));
  const tl = byId('tilt-slider-label');
  if (tl && document.activeElement !== tiltSlider) tl.textContent = tilt == null ? '—°' : fmtTilt(tilt);

  if (!sphereDragging && pan != null && tilt != null) {
    paintSphereAim('console', pan, tilt);
  } else if (!sphereDragging) {
    byId('sphere-vector-layer')?.setAttribute('opacity', '0.2');
  }
}

function parseUdpEndpoint(path: string | undefined | null): { host: string; port: number } | null {
  if (!path) return null;
  const m = /^udp:\/\/([^:/]+)(?::(\d+))?\/?$/i.exec(path.trim());
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : 6666;
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

function formatUdpEndpoint(host: string, port: number): string {
  return `udp://${host.trim()}:${port}`;
}

function fillUdpFieldsFromPath(udpPath: string | undefined): void {
  const ep = parseUdpEndpoint(udpPath);
  const hostEl = byId<HTMLInputElement>('udp-host-input');
  const portEl = byId<HTMLInputElement>('udp-port-input');
  if (!ep) return;
  if (hostEl && document.activeElement !== hostEl) hostEl.value = ep.host;
  if (portEl && document.activeElement !== portEl) portEl.value = String(ep.port);
}

function linkStatusLabel(s: SerialStatus): string {
  if (!(s.connected && s.path)) return 'No Device Connected';
  const isUdp = s.transport === 'udp' || /^udp:\/\//i.test(s.path);
  return isUdp ? 'Connected via LAN' : 'Connected via Serial';
}

function applyStatus(s: SerialStatus): void {
  status = s;
  // Status headings never show COM paths or udp://host:port.
  const isUdp = s.transport === 'udp' || /^udp:\/\//i.test(s.path ?? '');
  bindText('link', linkStatusLabel(s));
  setDot('link', s.connected ? 'on' : 'off');
  const addrNum = Number.isFinite(s.address) ? Number(s.address) : 1;
  bindText(
    'bus',
    isUdp
      ? `LAN · PELCO-D · ADDR ${String(addrNum).padStart(2, '0')}`
      : `SERIAL · PELCO-D ${s.baudRate || 9600}-8N1 · ADDR ${String(addrNum).padStart(2, '0')}`,
  );
  const transportLabel = isUdp && s.connected ? 'LAN' : 'SERIAL';
  bindText('link-transport', transportLabel);
  bindText('unit-transport', transportLabel);

  const baud = byId<HTMLSelectElement>('serial-baud-select');
  if (baud && s.connected && !isUdp) baud.value = String(s.baudRate);
  const addrInput = byId<HTMLInputElement>('pelco-address-input');
  if (addrInput && s.connected && document.activeElement !== addrInput) addrInput.value = String(addrNum);
  const sel = byId<HTMLSelectElement>('serial-port-select');
  if (sel && s.path && s.connected) sel.value = s.path;

  const c = byId<HTMLButtonElement>('serial-connect-btn');
  const d = byId<HTMLButtonElement>('serial-disconnect-btn');
  if (c) {
    c.disabled = s.connected;
    c.classList.toggle('opacity-40', s.connected);
  }
  if (d) {
    d.disabled = !s.connected;
    d.classList.toggle('opacity-40', !s.connected);
  }
}

function applyPorts(ports: PortInfo[]): void {
  const sel = byId<HTMLSelectElement>('serial-port-select');
  if (!sel) return;
  const prev = sel.value;
  sel.replaceChildren();
  if (ports.length === 0) {
    sel.append(new Option('— no ports found —', ''));
  } else {
    for (const p of ports) {
      const label = p.friendlyName || p.manufacturer ? `${p.friendlyName ?? p.manufacturer} (${p.path})` : p.path;
      sel.append(new Option(label, p.path));
    }
    const want = status.path ?? prev;
    if (want && ports.some((p) => p.path === want)) sel.value = want;
  }
}

function fmtPresetAxis(v: number | null, signed: boolean): string {
  if (v == null) return '—';
  return signed ? fmtTilt(v) : fmtPan(v);
}

function applyPresets(presets: PresetInfo[], active?: number | null): void {
  for (const p of presets) {
    if (p.id < 1 || p.id > 9) continue;
    const label = byId(`preset-${p.id}-label`);
    if (label && p.label) label.textContent = p.label;
    const pan = byId(`preset-${p.id}-pan`);
    const tilt = byId(`preset-${p.id}-tilt`);
    if (pan) pan.textContent = fmtPresetAxis(p.pan, false);
    if (tilt) tilt.textContent = fmtPresetAxis(p.tilt, true);
    const dot = byId(`preset-${p.id}-dot`);
    if (dot) dot.dataset.state = p.pan != null || p.tilt != null ? 'on' : 'off';
  }
  if (active !== undefined) markActivePreset(active);
}

function markActivePreset(id: number | null): void {
  qsa('.preset-card').forEach((card) => {
    const on = id != null && card.dataset.preset === String(id);
    card.classList.toggle('ring-1', on);
    card.classList.toggle('ring-secondary-container', on);
    card.classList.toggle('shadow-[0_0_8px_rgba(255,186,32,0.3)]', on);
  });
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function refreshSettingLabels(): void {
  const poll = byId<HTMLInputElement>('poll-slider');
  const pd = byId('poll-display');
  if (poll && pd) {
    const ms = Number(poll.value);
    pd.textContent = `${ms} ms (${(1000 / ms).toFixed(1)} Hz)`;
  }
  const ps = byId<HTMLInputElement>('pan-speed-slider');
  const ts = byId<HTMLInputElement>('tilt-speed-slider');
  if (ps) bindText2('pan-speed-val', `${ps.value} / 63`);
  if (ts) bindText2('tilt-speed-val', `${ts.value} / 63`);
}

function bindText2(id: string, text: string): void {
  const el = byId(id);
  if (el) el.textContent = text;
}

/** Sync Enable/Disable button pair (`#${prefix}-enable` / `#${prefix}-disable`). */
function syncEnableDisable(prefix: string, on: boolean): void {
  const en = byId(`${prefix}-enable`);
  const dis = byId(`${prefix}-disable`);
  const paint = (btn: HTMLElement | null, active: boolean) => {
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(active));
    btn.classList.toggle('bg-primary-container', active);
    btn.classList.toggle('text-on-primary-container', active);
    btn.classList.toggle('bg-surface-container', !active);
    btn.classList.toggle('text-on-surface-variant', !active);
  };
  paint(en, on);
  paint(dis, !on);
}

function applySettings(s: Settings): void {
  const tMin = s.limits?.tiltMin;
  const tMax = s.limits?.tiltMax;
  if (typeof tMin === 'number' && typeof tMax === 'number') setTiltLimits(tMin, tMax);
  const tiltSlider = byId<HTMLInputElement>('tilt-slider');
  if (tiltSlider) {
    tiltSlider.min = String(TILT_MIN);
    tiltSlider.max = String(TILT_MAX);
  }

  qsa<HTMLInputElement>('[data-setting]').forEach((el) => {
    const v = getPath(s as Record<string, unknown>, el.dataset.setting ?? '');
    if (v === undefined || v === null) return;
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else el.value = String(v);
  });
  refreshSettingLabels();

  if (s.address != null) {
    const a = byId<HTMLInputElement>('pelco-address-input');
    if (a) a.value = String(s.address);
  }
  if (s.baudRate != null) {
    const b = byId<HTMLSelectElement>('serial-baud-select');
    if (b) b.value = String(s.baudRate);
  }
  if (s.widgetVisible != null) syncEnableDisable('widget-visible', s.widgetVisible);
  if (s.widgetPinned != null) syncEnableDisable('widget-pin', s.widgetPinned);
  if (s.widgetAutoDock != null) syncEnableDisable('widget-autodock', s.widgetAutoDock);
  if (s.httpPort != null) bindEndpointChips(s.httpPort);
  if (s.udpPath) fillUdpFieldsFromPath(s.udpPath);
  const preferUdp = byId<HTMLInputElement>('prefer-udp-check');
  if (preferUdp && s.preferUdp != null && document.activeElement !== preferUdp) {
    preferUdp.checked = Boolean(s.preferUdp);
  }
  syncLandingResUi(s.approach?.deadband);
  bindText('settings-sync', 'SYNCED');
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
  const hidden = byId<HTMLInputElement>('approach-deadband-input');
  if (hidden) hidden.value = String(deg);
  qsa<HTMLButtonElement>('.land-res-btn').forEach((b) => {
    const on = Number(b.dataset.deg) === deg;
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('bg-primary-container', on);
    b.classList.toggle('text-on-primary-container', on);
    b.classList.toggle('font-semibold', on);
    b.classList.toggle('bg-surface-container-lowest', !on);
    b.classList.toggle('text-on-surface-variant', !on);
  });
}

function applySelfTest(ok: boolean, items: SelfTestItem[]): void {
  window.clearTimeout(selfTestTimer);
  const st = byId('selftest-status');
  if (st) {
    st.textContent = ok ? 'PASS' : 'FAIL';
    st.className = `font-label-telemetry-sm text-label-telemetry-sm ${ok ? 'text-primary' : 'text-error'}`;
  }
  const ul = byId('selftest-results');
  if (!ul) return;
  ul.replaceChildren();
  for (const it of items) {
    const li = document.createElement('li');
    li.className = it.ok ? 'text-primary-fixed-dim' : 'text-error';
    li.textContent = `${it.ok ? '✓' : '✗'} ${it.name}${it.detail ? ' — ' + it.detail : ''}`;
    ul.append(li);
  }
}

/* ====================================================================== */
/* Settings helpers                                                       */
/* ====================================================================== */

function patchFromPath(path: string, value: unknown): Settings {
  const keys = path.split('.');
  const root: Record<string, unknown> = {};
  let cur = root;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = value;
    else cur = (cur[k] = {}) as Record<string, unknown>;
  });
  return root as Settings;
}

function readSettingValue(el: HTMLInputElement): number | boolean | null {
  if (el.type === 'checkbox') return el.checked;
  const n = el.dataset.kind === 'int' ? parseInt(el.value, 10) : parseFloat(el.value);
  return Number.isFinite(n) ? n : null;
}

/* ====================================================================== */
/* Actions (data-action)                                                  */
/* ====================================================================== */

function readNum(id: string): number | null {
  const v = parseFloat(byId<HTMLInputElement>(id)?.value ?? '');
  return Number.isFinite(v) ? v : null;
}

function resetSphereDrag(): void {
  sphereDragging = false;
}

function halt(): void {
  resetSphereDrag();
  setMotion('HALTED');
  tx({ type: 'halt', source: 'console' });
  window.setTimeout(() => setMotion('IDLE'), 1200);
}

function openSettings(): void {
  const sec = byId('sec-settings');
  if (!sec) return;
  try {
    history.replaceState(null, '', '#settings');
  } catch {
    /* ignore */
  }
  sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  sec.classList.add('ring-1', 'ring-primary/50');
  window.setTimeout(() => sec.classList.remove('ring-1', 'ring-primary/50'), 1200);
}

bindActions({
  /* ---- motion ---- */
  halt: () => halt(),
  'open-settings': () => openSettings(),
  home: () => {
    setMotion('HOMING → 0° / 0°');
    tx({ type: 'home', source: 'console' });
    window.setTimeout(() => setMotion('IDLE'), 1200);
  },
  'set-step': (el) => {
    jogStep = Number(el.dataset.step) || 1;
    qsa('.step-btn').forEach((b) => {
      const on = b === el;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('bg-primary-container', on);
      b.classList.toggle('text-on-primary-container', on);
      b.classList.toggle('font-bold', on);
      b.classList.toggle('shadow', on);
      b.classList.toggle('text-on-surface', !on);
    });
  },
  'tilt-slider': (el, ev) => {
    const input = el as HTMLInputElement;
    const tilt = clamp(parseFloat(input.value), TILT_MIN, TILT_MAX);
    bindText2('tilt-slider-label', fmtTilt(tilt));
    const hgt = byId('sphere-height-readout');
    if (hgt) {
      const tag = Math.abs(tilt) < 1 ? ' [LEVEL / STORAGE]' : tilt > 0 ? ' [UP]' : ' [DOWN]';
      hgt.textContent = `${fmtTilt(tilt)}${tag}`;
    }
    if (ev.type === 'change') {
      setMotion('SLEWING');
      tx({ type: 'goto', tilt, source: 'console' });
    }
  },
  goto: () => {
    const pan = readNum('goto-pan-input');
    const tilt = readNum('goto-tilt-input');
    if (pan == null && tilt == null) {
      toast('ENTER PAN AND/OR TILT', 'warn');
      return;
    }
    setMotion('SLEWING');
    tx({
      type: 'goto',
      // Accept 0..360 or signed −180..+180 (e.g. −160 → device 200°)
      pan: pan == null ? undefined : normalizePanCommand(pan),
      tilt: tilt == null ? undefined : clamp(tilt, TILT_MIN, TILT_MAX),
      source: 'console',
    });
  },
  'read-live': () => {
    if (pose?.pan == null && pose?.tilt == null) {
      toast('NO LIVE POSITION YET', 'warn');
      tx({ type: 'pose.refresh' }, false);
      return;
    }
    const p = byId<HTMLInputElement>('goto-pan-input');
    const t = byId<HTMLInputElement>('goto-tilt-input');
    if (p && pose?.pan != null) p.value = pose.pan.toFixed(2);
    if (t && pose?.tilt != null) t.value = pose.tilt.toFixed(2);
  },

  /* ---- presets ---- */
  'preset-call': (el) => {
    const id = Number(el.dataset.preset);
    markActivePreset(id);
    setMotion('SLEWING');
    tx({ type: 'preset.call', id, source: 'console' });
  },
  'preset-set': (el) => {
    tx({ type: 'preset.set', id: Number(el.dataset.preset), source: 'console' });
  },
  'preset-clear': (el) => {
    tx({ type: 'preset.clear', id: Number(el.dataset.preset), source: 'console' });
  },

  /* ---- serial ---- */
  'serial-refresh': () => {
    tx({ type: 'serial.list' });
  },
  'serial-connect': () => {
    const path = byId<HTMLSelectElement>('serial-port-select')?.value ?? '';
    if (!path) {
      toast('SELECT A PORT / ENDPOINT', 'warn');
      return;
    }
    const baudRate = parseInt(byId<HTMLSelectElement>('serial-baud-select')?.value ?? '9600', 10);
    const address = clamp(parseInt(byId<HTMLInputElement>('pelco-address-input')?.value ?? '1', 10) || 1, 1, 255);
    tx({ type: 'serial.connect', path, baudRate, address });
  },
  'serial-disconnect': () => {
    tx({ type: 'serial.disconnect' });
  },
  'serial-port': () => {
    /* selection only; applied on Connect */
  },
  'serial-baud': () => {
    /* applied on Connect */
  },
  'eth-apply': () => {
    const host = (byId<HTMLInputElement>('udp-host-input')?.value ?? '').trim();
    const port = parseInt(byId<HTMLInputElement>('udp-port-input')?.value ?? '6666', 10);
    if (!host) {
      toast('ENTER ETHERNET IP', 'warn');
      return;
    }
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      toast('UDP PORT 1–65535', 'warn');
      return;
    }
    const udpPath = formatUdpEndpoint(host, port);
    const preferUdp = Boolean(byId<HTMLInputElement>('prefer-udp-check')?.checked);
    if (!tx({ type: 'settings.update', patch: { udpPath, preferUdp } })) return;
    tx({ type: 'serial.list' });
    const sel = byId<HTMLSelectElement>('serial-port-select');
    if (sel) sel.value = udpPath;
    toast('ETHERNET SETTINGS APPLIED');
  },
  'pelco-address': (el, ev) => {
    if (ev.type !== 'change') return;
    const address = clamp(parseInt((el as HTMLInputElement).value, 10) || 1, 1, 255);
    (el as HTMLInputElement).value = String(address);
    tx({ type: 'settings.update', patch: { address } });
  },

  /* ---- landing resolution 0.5° / 1° / 2° (home settle ±1.5°) ---- */
  'landing-res': (el) => {
    const deg = snapLandRes(Number(el.dataset.deg));
    syncLandingResUi(deg);
    tx({ type: 'settings.update', patch: { approach: { deadband: deg } } });
    toast(`LANDING ±${deg}°`);
  },

  /* ---- generic settings (data-setting="a.b") ---- */
  setting: (el, ev) => {
    refreshSettingLabels();
    if (ev.type !== 'change') return;
    const input = el as HTMLInputElement;
    const value = readSettingValue(input);
    if (value == null) return;
    tx({ type: 'settings.update', patch: patchFromPath(input.dataset.setting ?? '', value) });
  },

  /* ---- widget (real Windows always-on-top overlay via pip-shell) ---- */
  'open-widget': () => {
    // Enable + open; UI syncs from settings ack (do not flip Enable optimistically).
    if (!tx({ type: 'widget.open', source: 'console' })) return;
    toast('OPENING DESKTOP WIDGET');
  },
  'widget-visible': (el) => {
    const on = el.dataset.on !== 'false';
    if (on) tx({ type: 'widget.open', source: 'console' });
    else tx({ type: 'widget.close', source: 'console' });
  },
  'widget-pin': (el) => {
    const on = el.dataset.on !== 'false';
    tx({ type: 'widget.pinned', pinned: on });
  },
  'widget-autodock': (el) => {
    const on = el.dataset.on !== 'false';
    tx({ type: 'settings.update', patch: { widgetAutoDock: on } });
  },

  /* ---- local HTTP/WS listen port (persisted; applies on restart) ---- */
  'http-port': (el, ev) => {
    if (ev.type !== 'change') return;
    const port = clampHttpPort((el as HTMLInputElement).value);
    (el as HTMLInputElement).value = String(port);
    if (!tx({ type: 'settings.update', patch: { httpPort: port } })) return;
    bindEndpointChips(port);
    toast(`PORT ${port} SAVED — restart SPECTRE to apply`, 'info');
  },

  /* ---- unit info ---- */
  selftest: () => {
    const st = byId('selftest-status');
    const ul = byId('selftest-results');
    ul?.replaceChildren();
    if (st) {
      st.textContent = 'RUNNING…';
      st.className = 'font-label-telemetry-sm text-label-telemetry-sm text-secondary';
    }
    window.clearTimeout(selfTestTimer);
    if (!tx({ type: 'selftest.run' }, false)) {
      if (st) st.textContent = 'SERVER NOT CONNECTED';
      return;
    }
    selfTestTimer = window.setTimeout(() => {
      if (st) st.textContent = 'NO RESPONSE';
    }, 6000);
  },
  'log-clear': () => byId('wire-log')?.replaceChildren(),
});

/* Degree nudges on [data-jog] — 1°/5°/10° closed-loop goto; hold repeats */
bindDegreeNudge({
  getStep: () => jogStep,
  getPose: () => pose,
  onNudge: (target, _flags, el) => {
    el.classList.add('is-held');
    setMotion(`NUDGE ${jogStep}°`);
    tx({ type: 'goto', pan: target.pan, tilt: target.tilt, source: 'console' });
  },
  onIdle: () => {
    qsa('.jog-btn').forEach((b) => b.classList.remove('is-held'));
    setMotion('IDLE');
  },
});

/* Escape = HALT, anywhere in the console */
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') halt();
});

if (location.hash === '#settings') {
  window.requestAnimationFrame(() => openSettings());
}

/* ====================================================================== */
/* Server messages                                                        */
/* ====================================================================== */

ws.on('pose', (m: Extract<ServerMsg, { type: 'pose' }>) => {
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
ws.on('ports', (m) => applyPorts(m.ports));
ws.on('presets', (m) => applyPresets(m.presets, m.active));
ws.on('settings', (m) => applySettings(m.settings));
ws.on('selftest', (m) => applySelfTest(m.ok, m.items));
ws.on('error', (m) => toast(`SERVER: ${m.message}`, 'warn'));

ws.onState((s) => {
  renderWsState(s, ws.latencyMs);
  logLine('SYS', `ws ${s} · port ${resolveHttpPort()}`);
  if (s === 'open') {
    ws.send({ type: 'serial.list' });
    ws.send({ type: 'settings.get' });
    ws.send({ type: 'presets.get' });
    ws.send({ type: 'pose.refresh' });
  } else {
    bindText('settings-sync', 'NOT SYNCED');
    applyStatus({ ...status, connected: false });
  }
});
window.setInterval(() => renderWsState(ws.state, ws.latencyMs), 1000);

/* ====================================================================== */
/* Boot                                                                   */
/* ====================================================================== */

bindCopyChips();
bindEndpointChips();
bindText('app-version', `v${PRODUCT.version}`);

refreshSettingLabels();
paintSectorBadges('console');
renderPose();
applyStatus(status);
renderWsState(ws.state, ws.latencyMs);

/* Interactive 2D pan pad — tilt comes only from the tilt slider / live pose */
{
  const svg = byId<SVGSVGElement>('gimbal-sphere-svg');
  const hit = byId<SVGCircleElement>('sphere-hit');
  // Keep in lockstep with SPHERE_LAYOUT.console / widget.ts
  const CX = 130;
  const CY = 120;
  const R = 100;
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
      const slider = byId<HTMLInputElement>('tilt-slider');
      if (slider && document.activeElement === slider) return parseFloat(slider.value);
      return pose?.tilt ?? 0;
    },
    onDragStart: () => {
      sphereDragging = true;
    },
    onDragEnd: () => {
      sphereDragging = false;
    },
    onPreview: (pan, tilt) => paintSphereAim('console', pan, tilt),
    onCommit: (pan, tilt) => {
      setMotion('SLEWING');
      // Pad commits pan only; keep current tilt so axes stay independent.
      tx({ type: 'goto', pan, tilt, source: 'console' });
    },
  });
}

logLine('SYS', `SPECTRE console ${PRODUCT.version} · available on port ${resolveHttpPort()}`);
ws.connect();
