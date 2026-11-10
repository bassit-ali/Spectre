'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const POLL_MS = 250;

function readPinnedFromDom() {
  const btn = document.getElementById('widget-pin-btn');
  if (!btn) return null;
  return btn.getAttribute('aria-pressed') !== 'false';
}

contextBridge.exposeInMainWorld('spectreShell', {
  setOpacity(value) {
    // Opacity control removed from chrome — keep shell fully opaque.
    void value;
    ipcRenderer.send('shell:set-opacity', 1);
  },
  setPinned(pinned) {
    ipcRenderer.send('shell:set-pinned', Boolean(pinned));
  },
  setContentHeight(height) {
    ipcRenderer.send('shell:set-content-height', Number(height) || 0);
  },
  openExternal(url) {
    ipcRenderer.send('shell:open-external', String(url || ''));
  },
  close() {
    ipcRenderer.send('shell:close');
  },
});

/**
 * Keep pin in sync with the header button. Opacity is fixed at 1.
 */
window.addEventListener('DOMContentLoaded', () => {
  let lastPinned = null;

  const tick = () => {
    ipcRenderer.send('shell:set-opacity', 1);

    const pinned = readPinnedFromDom();
    if (pinned != null && pinned !== lastPinned) {
      lastPinned = pinned;
      ipcRenderer.send('shell:set-pinned', pinned);
    }
  };

  tick();
  window.setInterval(tick, POLL_MS);
});
