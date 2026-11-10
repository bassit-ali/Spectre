'use strict';

/**
 * SPECTRE pip-shell — thin always-on-top Electron window.
 * Loads the widget from the local SPECTRE server (default :9000).
 * This is the real Windows on-screen overlay (frameless, transparent,
 * skip-taskbar, always-on-top) — not a browser popup.
 *
 * Prerequisite: SPECTRE server must be running on http://127.0.0.1:9000
 *   (or set SPECTRE_WIDGET_URL to override the widget URL).
 */

const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const path = require('path');

const DEFAULT_URL = 'http://127.0.0.1:9000/widget.html?bg=transparent';
const WIDGET_URL = process.env.SPECTRE_WIDGET_URL || DEFAULT_URL;

/** @type {BrowserWindow | null} */
let win = null;
let pinned = true;

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

/** Resize height while keeping the top edge fixed (minimize collapses downward). */
function applyContentHeight(height) {
  if (!win || win.isDestroyed()) return;
  const h = Math.max(56, Math.round(Number(height) || 0));
  const [x, y] = win.getPosition();
  const [w] = win.getSize();
  win.setBounds({ x, y, width: w, height: h }, false);
}

function createWindow() {
  const work = screen.getPrimaryDisplay().workArea;
  const width = 420;
  const height = 720;
  const x = work.x + work.width - width - 24;
  const y = work.y + Math.max(24, Math.floor((work.height - height) / 2));

  win = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 280,
    // Allow header-only minimize (top edge fixed; height shrinks downward).
    minHeight: 64,
    title: 'SPECTRE',
    frame: false,
    transparent: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
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

  applyPinned(true);
  applyOpacity(1);

  win.once('ready-to-show', () => {
    win?.show();
    win?.setAlwaysOnTop(true, 'screen-saver');
  });

  win.on('closed', () => {
    win = null;
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(
      `[spectre-pip-shell] Failed to load ${url} (${code}: ${desc}).\n` +
        `  Start the SPECTRE server on :9000 first, then run npm start again.\n` +
        `  Override URL with SPECTRE_WIDGET_URL if needed.`,
    );
  });

  console.info(`[spectre-pip-shell] Loading ${WIDGET_URL}`);
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
