import { bindHoldJog, fmtDeg, getApi, PresetMeta } from './pelcoApi';

const api = getApi();

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function input(id: string): HTMLInputElement {
  return $(id) as HTMLInputElement;
}

function renderPose(pose: { pan: number | null; tilt: number | null }): void {
  $('wPose').textContent = `${fmtDeg(pose.pan)} / ${fmtDeg(pose.tilt)}`;
}

function setLink(on: boolean): void {
  $('wLink').className = `dot ${on ? 'on' : ''}`;
}

function renderPresets(presets: PresetMeta[]): void {
  const grid = $('wPresets');
  grid.innerHTML = '';
  for (const p of presets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary';
    btn.textContent = String(p.id);
    btn.title = `${p.label} (${fmtDeg(p.pan)} / ${fmtDeg(p.tilt)})`;
    btn.addEventListener('click', () => void api.callPreset(p.id));
    grid.appendChild(btn);
  }
}

async function boot(): Promise<void> {
  const cfg = await api.getAppConfig();
  input('wOpacity').value = String(cfg.widgetOpacity ?? 0.85);
  input('wPinned').checked = cfg.widgetPinned !== false;
  renderPresets(await api.getPresetsMeta());
  renderPose(await api.getPose());
  setLink((await api.getStatus()).connected);

  bindHoldJog(
    $('wJog'),
    (flags) => void api.jog(flags),
    () => void api.stop(),
  );
  $('wStop').addEventListener('click', () => void api.stop());

  let collapsed = false;
  $('wCollapse').addEventListener('click', () => {
    collapsed = !collapsed;
    $('wBody').style.display = collapsed ? 'none' : '';
  });

  input('wOpacity').addEventListener('input', () => {
    void api.setWidgetOpacity(Number(input('wOpacity').value));
  });
  input('wPinned').addEventListener('change', () => {
    void api.setWidgetPinned(input('wPinned').checked);
  });

  api.onEvent('serial:status', (s) => setLink(Boolean((s as { connected: boolean }).connected)));
  api.onEvent('motion:pose', (pose) => renderPose(pose as never));
  api.onEvent('presets:updated', (presets) => renderPresets(presets as PresetMeta[]));
}

void boot().catch(console.error);
