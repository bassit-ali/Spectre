'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const POLL_MS = 250;

function clampOpacity(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.95;
  return Math.min(1, Math.max(0.4, n));
}

function readPinnedFromDom() {
  const btn = document.getElementById('widget-pin-btn');
  if (!btn) return null;
  return btn.getAttribute('aria-pressed') !== 'false';
}

contextBridge.exposeInMainWorld('spectreShell', {
  setOpacity(value) {
    ipcRenderer.send('shell:set-opacity', clampOpacity(value));
  },
  setPinned(pinned) {
    ipcRenderer.send('shell:set-pinned', Boolean(pinned));
  },
  setContentHeight(height) {
    ipcRenderer.send('shell:set-content-height', Number(height) || 0);
  },
  setAutoDock(on) {
    ipcRenderer.send('shell:set-auto-dock', Boolean(on));
  },
  dockBottomRight() {
    ipcRenderer.send('shell:dock-bottom-right');
  },
  openExternal(url) {
    ipcRenderer.send('shell:open-external', String(url || ''));
  },
  close() {
    ipcRenderer.send('shell:close');
  },
});

/**
 * Keep pin in sync with the header button. Opacity is set by the widget UI.
 */
window.addEventListener('DOMContentLoaded', () => {
  let lastPinned = null;

  const tick = () => {
    const pinned = readPinnedFromDom();
    if (pinned != null && pinned !== lastPinned) {
      lastPinned = pinned;
      ipcRenderer.send('shell:set-pinned', pinned);
    }
  };

  tick();
  window.setInterval(tick, POLL_MS);
});
