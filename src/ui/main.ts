import { bindHoldJog, fmtDeg, getApi, PresetMeta } from './pelcoApi';

const api = getApi();
const logEl = document.getElementById('serialLog') as HTMLPreElement;
const lines: string[] = [];

function log(line: string): void {
  const ts = new Date().toLocaleTimeString();
  lines.push(`[${ts}] ${line}`);
  if (lines.length > 300) lines.shift();
  logEl.textContent = lines.join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function input(id: string): HTMLInputElement {
  return $(id) as HTMLInputElement;
}

function select(id: string): HTMLSelectElement {
  return $(id) as HTMLSelectElement;
}

async function refreshPorts(preferred?: string): Promise<void> {
  const ports = await api.listPorts();
  const sel = select('portSelect');
  sel.innerHTML = '';
  for (const p of ports) {
    const opt = document.createElement('option');
    opt.value = p.path;
    opt.textContent = p.friendlyName || p.path;
    sel.appendChild(opt);
  }
  if (preferred) sel.value = preferred;
  else if (ports.some((p) => p.path.toUpperCase() === 'COM13')) sel.value = 'COM13';
}

function setLink(connected: boolean, path?: string | null): void {
  const badge = $('linkBadge');
  badge.className = `badge ${connected ? 'on' : 'off'}`;
  badge.textContent = connected ? `Online ${path || ''}`.trim() : 'Offline';
}

function renderPose(pose: { pan: number | null; tilt: number | null; panRaw: number | null; tiltRaw: number | null }): void {
  $('panDeg').textContent = fmtDeg(pose.pan);
  $('tiltDeg').textContent = fmtDeg(pose.tilt);
  $('panRaw').textContent = pose.panRaw == null ? 'raw —' : `raw 0x${pose.panRaw.toString(16).toUpperCase()} (${pose.panRaw})`;
  $('tiltRaw').textContent = pose.tiltRaw == null ? 'raw —' : `raw 0x${pose.tiltRaw.toString(16).toUpperCase()} (${pose.tiltRaw})`;
}

function renderSnapshot(snap: unknown): void {
  const el = $('moveSnapshot');
  if (!snap) {
    el.textContent = 'No moves yet';
    return;
  }
  const s = snap as {
    label: string;
    before: { pan: number | null; tilt: number | null };
    after: { pan: number | null; tilt: number | null } | null;
  };
  el.textContent = `${s.label}\nBefore  pan=${fmtDeg(s.before.pan)}  tilt=${fmtDeg(s.before.tilt)}\nAfter   pan=${fmtDeg(s.after?.pan ?? null)}  tilt=${fmtDeg(s.after?.tilt ?? null)}`;
}

function renderPresets(presets: PresetMeta[]): void {
  const grid = $('presetGrid');
  grid.innerHTML = '';
  for (const p of presets) {
    const card = document.createElement('div');
    card.className = 'preset-card';
    card.innerHTML = `
      <header>
        <strong>#${p.id}</strong>
        <input class="label" data-id="${p.id}" value="${p.label.replace(/"/g, '&quot;')}" />
      </header>
      <small>${fmtDeg(p.pan)} / ${fmtDeg(p.tilt)}</small>
      <div class="actions">
        <button type="button" data-call="${p.id}" class="primary">Call</button>
        <button type="button" data-set="${p.id}">Set</button>
        <button type="button" data-clear="${p.id}" class="ghost">Clr</button>
      </div>`;
    grid.appendChild(card);
  }

  grid.querySelectorAll<HTMLButtonElement>('[data-call]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.getAttribute('data-call'));
      log(`CALL preset ${id}`);
      await api.callPreset(id);
    });
  });
  grid.querySelectorAll<HTMLButtonElement>('[data-set]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.getAttribute('data-set'));
      log(`SET preset ${id}`);
      const next = await api.setPreset(id);
      renderPresets(next);
    });
  });
  grid.querySelectorAll<HTMLButtonElement>('[data-clear]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.getAttribute('data-clear'));
      log(`CLEAR preset ${id}`);
      await api.clearPreset(id);
      renderPresets(await api.getPresetsMeta());
    });
  });
  grid.querySelectorAll<HTMLInputElement>('input.label').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const id = Number(inp.getAttribute('data-id'));
      const presets = await api.getPresetsMeta();
      const next = presets.map((p) => (p.id === id ? { ...p, label: inp.value } : p));
      await api.updateAppConfig({ presets: next });
    });
  });
}

function bindRange(id: string, valId: string, onChange: (n: number) => void): void {
  const el = input(id);
  const val = $(valId);
  const sync = () => {
    val.textContent = el.value;
    onChange(Number(el.value));
  };
  el.addEventListener('input', () => {
    val.textContent = el.value;
  });
  el.addEventListener('change', sync);
}

async function pushMotionSettings(): Promise<void> {
  await api.updateSettings({
    address: Number(input('addressInput').value),
    panSpeed: Number(input('panSpeed').value),
    tiltSpeed: Number(input('tiltSpeed').value),
    approach: {
      speedFast: Number(input('speedFast').value),
      speedSlow: Number(input('speedSlow').value),
      rampDistance: Number(input('rampDistance').value),
      deadband: Number(input('deadband').value),
    },
    limits: {
      enabled: input('limitsEnabled').checked,
      panMin: -180,
      panMax: 180,
      tiltMin: Number(input('tiltMin').value),
      tiltMax: Number(input('tiltMax').value),
    },
  });
}

async function boot(): Promise<void> {
  const cfg = await api.getAppConfig();
  await refreshPorts(String(cfg.lastPort || ''));
  select('baudSelect').value = String(cfg.baudRate || 9600);
  input('addressInput').value = String(cfg.address || 1);
  input('panSpeed').value = String(cfg.panSpeed || 32);
  input('tiltSpeed').value = String(cfg.tiltSpeed || 24);
  $('panSpeedVal').textContent = input('panSpeed').value;
  $('tiltSpeedVal').textContent = input('tiltSpeed').value;

  const approach = (cfg.approach || {}) as Record<string, number>;
  input('speedFast').value = String(approach.speedFast ?? 48);
  input('speedSlow').value = String(approach.speedSlow ?? 8);
  input('rampDistance').value = String(approach.rampDistance ?? 15);
  input('deadband').value = String(approach.deadband ?? 0.4);
  $('speedFastVal').textContent = input('speedFast').value;
  $('speedSlowVal').textContent = input('speedSlow').value;

  const limits = (cfg.limits || {}) as Record<string, number | boolean>;
  input('limitsEnabled').checked = limits.enabled !== false;
  input('tiltMin').value = String(limits.tiltMin ?? -90);
  input('tiltMax').value = String(limits.tiltMax ?? 90);

  input('showWidget').checked = cfg.showWidget !== false;
  input('widgetPinned').checked = cfg.widgetPinned !== false;
  input('widgetOpacity').value = String(cfg.widgetOpacity ?? 0.85);
  input('openAtLogin').checked = cfg.openAtLogin !== false;
  input('autoConnect').checked = cfg.autoConnect !== false;

  renderPresets((await api.getPresetsMeta()) as PresetMeta[]);
  renderPose(await api.getPose());
  renderSnapshot(await api.getLastMove());
  const status = await api.getStatus();
  setLink(status.connected, status.path);

  $('refreshPorts').addEventListener('click', () => void refreshPorts(select('portSelect').value));
  $('connectBtn').addEventListener('click', async () => {
    const path = select('portSelect').value;
    const baud = Number(select('baudSelect').value);
    await pushMotionSettings();
    log(`Connecting ${path} @ ${baud}`);
    const st = await api.connect(path, baud);
    setLink(st.connected, st.path);
  });
  $('disconnectBtn').addEventListener('click', async () => {
    const st = await api.disconnect();
    setLink(st.connected);
    log('Disconnected');
  });

  bindHoldJog(
    $('jogPad'),
    (flags) => void api.jog(flags),
    () => void api.stop(),
  );
  $('stopBtn').addEventListener('click', () => void api.stop());
  $('refreshEnc').addEventListener('click', async () => {
    const pose = await api.refreshEncoders();
    renderPose(pose);
    log(`Encoders pan=${fmtDeg(pose.pan)} tilt=${fmtDeg(pose.tilt)}`);
  });
  $('gotoBtn').addEventListener('click', async () => {
    const panRaw = input('gotoPan').value;
    const tiltRaw = input('gotoTilt').value;
    const pan = panRaw === '' ? undefined : Number(panRaw);
    const tilt = tiltRaw === '' ? undefined : Number(tiltRaw);
    log(`GOTO pan=${pan ?? '-'} tilt=${tilt ?? '-'}`);
    await api.gotoAbsolute(pan, tilt);
  });

  bindRange('panSpeed', 'panSpeedVal', () => void pushMotionSettings());
  bindRange('tiltSpeed', 'tiltSpeedVal', () => void pushMotionSettings());
  bindRange('speedFast', 'speedFastVal', () => void pushMotionSettings());
  bindRange('speedSlow', 'speedSlowVal', () => void pushMotionSettings());
  for (const id of ['rampDistance', 'deadband', 'tiltMin', 'tiltMax', 'addressInput', 'limitsEnabled']) {
    $(id).addEventListener('change', () => void pushMotionSettings());
  }

  $('setTiltMinNow').addEventListener('click', async () => {
    const pose = await api.getPose();
    if (pose.tilt != null) {
      input('tiltMin').value = String(pose.tilt.toFixed(2));
      await pushMotionSettings();
    }
  });
  $('setTiltMaxNow').addEventListener('click', async () => {
    const pose = await api.getPose();
    if (pose.tilt != null) {
      input('tiltMax').value = String(pose.tilt.toFixed(2));
      await pushMotionSettings();
    }
  });

  input('showWidget').addEventListener('change', async () => {
    await api.setWidgetVisible(input('showWidget').checked);
    await api.updateAppConfig({ showWidget: input('showWidget').checked });
  });
  input('widgetPinned').addEventListener('change', async () => {
    await api.setWidgetPinned(input('widgetPinned').checked);
  });
  input('widgetOpacity').addEventListener('input', async () => {
    await api.setWidgetOpacity(Number(input('widgetOpacity').value));
  });
  input('openAtLogin').addEventListener('change', async () => {
    await api.updateAppConfig({ openAtLogin: input('openAtLogin').checked });
  });
  input('autoConnect').addEventListener('change', async () => {
    await api.updateAppConfig({ autoConnect: input('autoConnect').checked });
  });

  api.onEvent('serial:status', (s) => {
    const st = s as { connected: boolean; path: string | null };
    setLink(st.connected, st.path);
  });
  api.onEvent('serial:tx', (hex) => log(`TX ${hex}`));
  api.onEvent('serial:rx', (hex) => log(`RX ${hex}`));
  api.onEvent('serial:error', (err) => log(`ERR ${err}`));
  api.onEvent('motion:pose', (pose) => renderPose(pose as never));
  api.onEvent('motion:moveSnapshot', (snap) => renderSnapshot(snap));
  api.onEvent('motion:limitHit', (payload) =>
    log(`PAN LOCK — full revolution blocked ${JSON.stringify(payload)}`),
  );
  api.onEvent('presets:updated', (presets) => renderPresets(presets as PresetMeta[]));
  api.onEvent('motion:state', (st) => log(`STATE ${JSON.stringify(st)}`));
}

void boot().catch((err) => {
  log(String(err));
  console.error(err);
});
