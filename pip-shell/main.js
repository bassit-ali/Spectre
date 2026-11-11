'use strict';

/**
 * SPECTRE pip-shell — thin always-on-top Electron window.
 * Loads the widget from the local SPECTRE server (default port 9000).
 * This is the real Windows on-screen overlay (frameless, transparent,
 * skip-taskbar, always-on-top) — not a browser popup.
 *
 * Prerequisite: SPECTRE server must be running (default port 9000),
 *   or set SPECTRE_WIDGET_URL to override the widget URL.
 *
 * Auto-dock (default on): bottom-right of the primary work area.
 * Height changes keep the bottom edge fixed so minimize/expand stays docked.
 */

const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const path = require('path');

const DEFAULT_URL = 'http://127.0.0.1:9000/widget.html?bg=transparent';
const WIDGET_URL = process.env.SPECTRE_WIDGET_URL || DEFAULT_URL;
const MARGIN = 24;

/** @type {BrowserWindow | null} */
let win = null;
let pinned = process.env.SPECTRE_WIDGET_PINNED !== '0';
/** When true, window stays glued to the bottom-right work-area corner. */
let autoDock = process.env.SPECTRE_WIDGET_AUTO_DOCK !== '0';
/** Startup opacity from env (config default 0.95); widget UI can change it live. */
let initialOpacity = 0.95;

// Single-instance: focus existing overlay instead of spawning duplicates.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) {
      createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

function clampOpacity(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.95;
  return Math.min(1, Math.max(0.4, n));
}

initialOpacity = clampOpacity(process.env.SPECTRE_WIDGET_OPACITY);

function applyPinned(next) {
  pinned = Boolean(next);
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(pinned, 'screen-saver');
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    /* optional on some platforms */
  }
}

function applyOpacity(value) {
  if (!win || win.isDestroyed()) return;
  win.setOpacity(clampOpacity(value));
}

/** Bottom-right of the primary display work area. */
function bottomRightBounds(width, height) {
  const work = screen.getPrimaryDisplay().workArea;
  const w = Math.max(280, Math.round(width));
  const h = Math.max(64, Math.round(height));
  return {
    x: work.x + work.width - w - MARGIN,
    y: work.y + work.height - h - MARGIN,
    width: w,
    height: h,
  };
}

function dockBottomRight() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getSize();
  win.setBounds(bottomRightBounds(w, h), false);
}

/**
 * Resize height while keeping the bottom edge fixed (minimize scrolls down / maximize up).
 * When auto-dock is on, also re-snap to the bottom-right corner.
 */
function applyContentHeight(height) {
  if (!win || win.isDestroyed()) return;
  const h = Math.max(64, Math.round(Number(height) || 0));
  const [x, y] = win.getPosition();
  const [w, prevH] = win.getSize();
  if (autoDock) {
    win.setBounds(bottomRightBounds(w, h), true);
    return;
  }
  const bottom = y + prevH;
  win.setBounds({ x, y: bottom - h, width: w, height: h }, true);
}

function createWindow() {
  const width = 420;
  const height = 720;
  const placed = autoDock
    ? bottomRightBounds(width, height)
    : (() => {
        const work = screen.getPrimaryDisplay().workArea;
        return {
          x: work.x + work.width - width - MARGIN,
          y: work.y + Math.max(MARGIN, Math.floor((work.height - height) / 2)),
          width,
          height,
        };
      })();

  win = new BrowserWindow({
    width: placed.width,
    height: placed.height,
    x: placed.x,
    y: placed.y,
    minWidth: 280,
    // Header-only minimize; height shrinks upward from the bottom edge.
    minHeight: 64,
    title: 'SPECTRE',
    frame: false,
    transparent: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: pinned,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  applyPinned(pinned);
  applyOpacity(initialOpacity);

  win.once('ready-to-show', () => {
    if (autoDock) dockBottomRight();
    win?.show();
    applyPinned(pinned);
  });

  win.on('closed', () => {
    win = null;
  });

  win.webContents.on('did-fail-load', (_e, code, desc, _url) => {
    console.error(
      `[spectre-pip-shell] Failed to load widget (${code}: ${desc}).\n` +
        `  Start the SPECTRE server on its listen port first, then run npm start again.\n` +
        `  Override URL with SPECTRE_WIDGET_URL if needed.`,
    );
  });

  console.info('[spectre-pip-shell] Loading widget overlay');
  void win.loadURL(WIDGET_URL);
}

function wireIpc() {
  ipcMain.on('shell:set-opacity', (_e, value) => {
    applyOpacity(value);
  });
  ipcMain.on('shell:set-pinned', (_e, next) => {
    applyPinned(next);
  });
  ipcMain.on('shell:set-content-height', (_e, height) => {
    applyContentHeight(height);
  });
  ipcMain.on('shell:set-auto-dock', (_e, next) => {
    autoDock = Boolean(next);
    if (autoDock) dockBottomRight();
  });
  ipcMain.on('shell:dock-bottom-right', () => {
    // Dock only — do not force auto-dock mode on.
    dockBottomRight();
  });
  ipcMain.on('shell:close', () => {
    win?.close();
  });
  ipcMain.on('shell:open-external', (_e, url) => {
    const s = String(url || '');
    if (!/^https?:\/\//i.test(s)) return;
    void shell.openExternal(s);
  });
}

if (gotLock) {
  app.whenReady().then(() => {
    wireIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
