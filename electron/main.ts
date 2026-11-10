import {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  screen,
  shell,
} from 'electron';
import path from 'path';
import fs from 'fs';
import Store from 'electron-store';
import { PortManager } from './serial/portManager';
import { MotionController, ControllerSettings } from './motion/controller';
import { PresetId } from './protocol/pelcoD';

type PresetMeta = {
  id: number;
  label: string;
  pan: number | null;
  tilt: number | null;
  /** Unwrapped pan travel for closed-loop recall (no revolution wrap). */
  panTravel: number | null;
  updatedAt: number | null;
};

type AppConfig = {
  lastPort: string;
  baudRate: number;
  address: number;
  panSpeed: number;
  tiltSpeed: number;
  autoConnect: boolean;
  showWidget: boolean;
  widgetOpacity: number;
  widgetPinned: boolean;
  widgetBounds: { x: number; y: number; width: number; height: number } | null;
  limits: ControllerSettings['limits'];
  approach: ControllerSettings['approach'];
  presets: PresetMeta[];
  openAtLogin: boolean;
};

const defaults: AppConfig = {
  lastPort: process.platform === 'win32' ? 'COM13' : '/dev/ttyUSB0',
  baudRate: 9600,
  address: 1,
  panSpeed: 32,
  tiltSpeed: 24,
  autoConnect: true,
  showWidget: true,
  widgetOpacity: 0.85,
  widgetPinned: true,
  widgetBounds: null,
  limits: {
    enabled: true,
    panMin: -180,
    panMax: 180,
    tiltMin: -50,
    tiltMax: 50,
  },
  approach: {
    speedFast: 48,
    speedSlow: 8,
    rampDistance: 15,
    deadband: 0.4,
    pollMs: 120,
  },
  presets: Array.from({ length: 9 }, (_, i) => ({
    id: i + 1,
    label: `P${i + 1}`,
    pan: null,
    tilt: null,
    panTravel: null,
    updatedAt: null,
  })),
  openAtLogin: true,
};

const store = new Store<AppConfig>({ name: 'pelco-pt-config', defaults });
const portManager = new PortManager();
let motion: MotionController;
let mainWindow: BrowserWindow | null = null;
let widgetWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function resolveHtml(file: string): string {
  return path.join(__dirname, '..', 'dist', file);
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: 'PelcoPT — Pan/Tilt Controller',
    backgroundColor: '#0f1419',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(resolveHtml('index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createWidgetWindow(): void {
  const cfg = store.store;
  const display = screen.getPrimaryDisplay().workArea;
  const width = cfg.widgetBounds?.width ?? 320;
  const height = cfg.widgetBounds?.height ?? 420;
  const x = cfg.widgetBounds?.x ?? display.x + display.width - width - 24;
  const y = cfg.widgetBounds?.y ?? display.y + display.height - height - 24;

  widgetWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: cfg.widgetPinned,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: cfg.showWidget,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  widgetWindow.setAlwaysOnTop(cfg.widgetPinned, 'screen-saver');
  widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  widgetWindow.loadFile(resolveHtml('widget.html'));
  widgetWindow.setOpacity(cfg.widgetOpacity);

  widgetWindow.on('moved', saveWidgetBounds);
  widgetWindow.on('resized', saveWidgetBounds);
  widgetWindow.on('closed', () => {
    widgetWindow = null;
  });
}

function saveWidgetBounds(): void {
  if (!widgetWindow) return;
  const b = widgetWindow.getBounds();
  store.set('widgetBounds', b);
}

function createTray(): void {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  const img = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPElEQVQ4T2NkYGD4z0ABYBzVMKoBBgYGBgYGRgYGhv8gGgQYGBgY/kMzGBiIBaOaYZqB0QzG0QzG0QyGAQArWwMJm0i8VwAAAABJRU5ErkJggg==',
      );
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('PelcoPT');
  const menu = Menu.buildFromTemplate([
    {
      label: 'Show Control Page',
      click: () => {
        if (!mainWindow) createMainWindow();
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    {
      label: 'Toggle Floating Widget',
      click: () => {
        const show = !store.get('showWidget');
        store.set('showWidget', show);
        if (show) {
          if (!widgetWindow) createWidgetWindow();
          widgetWindow?.show();
        } else {
          widgetWindow?.hide();
        }
      },
    },
    {
      label: 'Panic Stop',
      click: () => void motion.stop(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        void shutdownAndQuit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function applyOpenAtLogin(enabled: boolean): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: false,
      path: process.execPath,
      args: app.isPackaged ? [] : ['.'],
    });
  } catch (err) {
    console.error('setLoginItemSettings failed', err);
  }
}

async function autoConnectIfNeeded(): Promise<void> {
  const cfg = store.store;
  if (!cfg.autoConnect || !cfg.lastPort) return;
  try {
    await portManager.open(cfg.lastPort, cfg.baudRate);
    await motion.stop();
    motion.startPolling(500);
    broadcast('serial:status', portManager.getStatus());
    broadcast('motion:pose', motion.getPose());
  } catch (err) {
    broadcast('serial:error', String(err));
  }
}

function wireIpc(): void {
  ipcMain.handle('serial:list', async () => PortManager.listPorts());
  ipcMain.handle('serial:status', () => portManager.getStatus());
  ipcMain.handle('serial:connect', async (_e, { path: p, baudRate }) => {
    await portManager.open(p, baudRate);
    store.set('lastPort', p);
    store.set('baudRate', baudRate);
    await motion.stop();
    motion.startPolling(500);
    return portManager.getStatus();
  });
  ipcMain.handle('serial:disconnect', async () => {
    motion.stopPolling();
    await motion.stop().catch(() => undefined);
    await portManager.close();
    return portManager.getStatus();
  });

  ipcMain.handle('motion:settings', () => motion.getSettings());
  ipcMain.handle('motion:updateSettings', (_e, patch) => {
    const next = motion.updateSettings(patch);
    store.set('address', next.address);
    store.set('panSpeed', next.panSpeed);
    store.set('tiltSpeed', next.tiltSpeed);
    store.set('limits', next.limits);
    store.set('approach', next.approach);
    return next;
  });
  ipcMain.handle('motion:pose', () => motion.getPose());
  ipcMain.handle('motion:lastMove', () => motion.getLastMove());
  ipcMain.handle('motion:jog', async (_e, flags) => {
    await motion.jog(flags);
  });
  ipcMain.handle('motion:stop', async () => {
    await motion.stop();
  });
  ipcMain.handle('motion:refresh', async () => motion.refreshEncoders());
  ipcMain.handle('motion:setPreset', async (_e, id: number) => {
    await motion.setPreset(id as PresetId);
    const pose = motion.getPose();
    const presets = store.get('presets');
    const idx = presets.findIndex((p) => p.id === id);
    if (idx >= 0) {
      presets[idx] = {
        ...presets[idx]!,
        pan: pose.pan,
        tilt: pose.tilt,
        panTravel: pose.panTravel,
        updatedAt: Date.now(),
      };
      store.set('presets', presets);
    }
    broadcast('presets:updated', store.get('presets'));
    return store.get('presets');
  });
  ipcMain.handle('motion:callPreset', async (_e, id: number) => {
    const meta = store.get('presets').find((p) => p.id === id);
    await motion.callPreset(id as PresetId, meta);
  });
  ipcMain.handle('motion:clearPreset', async (_e, id: number) => {
    await motion.clearPresetCmd(id as PresetId);
    const presets = store.get('presets');
    const idx = presets.findIndex((p) => p.id === id);
    if (idx >= 0) {
      presets[idx] = {
        ...presets[idx]!,
        pan: null,
        tilt: null,
        panTravel: null,
        updatedAt: null,
      };
      store.set('presets', presets);
    }
    broadcast('presets:updated', store.get('presets'));
  });
  ipcMain.handle('motion:goto', async (_e, { pan, tilt }) => {
    await motion.gotoAbsolute(pan, tilt);
  });

  ipcMain.handle('presets:get', () => store.get('presets'));

  ipcMain.handle('widget:opacity', (_e, opacity: number) => {
    const o = Math.max(0.2, Math.min(1, opacity));
    store.set('widgetOpacity', o);
    widgetWindow?.setOpacity(o);
    return o;
  });
  ipcMain.handle('widget:pinned', (_e, pinned: boolean) => {
    store.set('widgetPinned', pinned);
    widgetWindow?.setAlwaysOnTop(pinned, 'screen-saver');
    return pinned;
  });
  ipcMain.handle('widget:visible', (_e, visible: boolean) => {
    store.set('showWidget', visible);
    if (visible) {
      if (!widgetWindow) createWidgetWindow();
      widgetWindow?.show();
    } else {
      widgetWindow?.hide();
    }
    return visible;
  });

  ipcMain.handle('app:getConfig', () => store.store);
  ipcMain.handle('app:updateConfig', (_e, patch: Partial<AppConfig>) => {
    for (const [k, v] of Object.entries(patch)) {
      store.set(k as keyof AppConfig, v as never);
    }
    if (typeof patch.openAtLogin === 'boolean') applyOpenAtLogin(patch.openAtLogin);
    if (patch.presets) broadcast('presets:updated', store.get('presets'));
    return store.store;
  });
}

async function shutdownAndQuit(): Promise<void> {
  try {
    await motion.shutdown();
    await portManager.close();
  } finally {
    app.exit(0);
  }
}

app.whenReady().then(async () => {
  const cfg = store.store;
  // Migrate / repair pan travel configs to signed ±180 no-revolution mode.
  const limits = { ...cfg.limits };
  const brokenRange =
    !Number.isFinite(limits.panMin) ||
    !Number.isFinite(limits.panMax) ||
    limits.panMax <= limits.panMin ||
    (limits.panMin === 0 && limits.panMax === 0) ||
    (limits.panMin === 0 && limits.panMax === 360);
  if (brokenRange) {
    limits.panMin = -180;
    limits.panMax = 180;
    limits.enabled = true;
  }
  limits.panMin = Math.max(-180, Math.min(179, limits.panMin ?? -180));
  limits.panMax = Math.min(180, Math.max(limits.panMin + 1, limits.panMax ?? 180));
  store.set('limits', limits);

  motion = new MotionController(portManager, {
    address: cfg.address,
    panSpeed: cfg.panSpeed,
    tiltSpeed: cfg.tiltSpeed,
    limits,
    approach: cfg.approach,
  });

  motion.on('pose', (pose) => broadcast('motion:pose', pose));
  motion.on('settings', (s) => broadcast('motion:settings', s));
  motion.on('state', (s) => broadcast('motion:state', s));
  motion.on('moveSnapshot', (s) => broadcast('motion:moveSnapshot', s));
  motion.on('limitHit', (l) => {
    broadcast('motion:limitHit', l);
    broadcast('serial:rx', `LIMIT ${JSON.stringify(l)}`);
  });
  motion.on('preset', (p) => broadcast('motion:preset', p));
  motion.on('error', (e) => broadcast('motion:error', String(e)));

  portManager.on('status', (s) => broadcast('serial:status', s));
  portManager.on('tx', (hex) => broadcast('serial:tx', hex));
  portManager.on('rx', (hex) => broadcast('serial:rx', hex));
  portManager.on('error', (e) => broadcast('serial:error', String(e)));

  wireIpc();
  applyOpenAtLogin(cfg.openAtLogin);
  createMainWindow();
  createWidgetWindow();
  createTray();
  await autoConnectIfNeeded();

  app.on('activate', () => {
    if (!mainWindow) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  // Keep process alive for tray + floating widget lifecycle.
});

app.on('before-quit', () => {
  void motion?.shutdown();
});

// Ensure dist exists hint for dev
const distPath = path.join(__dirname, '..', 'dist', 'index.html');
if (!fs.existsSync(distPath)) {
  console.warn('UI not built yet. Run: npm run build:renderer');
}

// Open external links safely if ever used
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
});
