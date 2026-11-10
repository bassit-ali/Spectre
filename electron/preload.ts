import { contextBridge, ipcRenderer } from 'electron';

export type PelcoApi = {
  listPorts: () => Promise<unknown>;
  connect: (path: string, baudRate: number) => Promise<unknown>;
  disconnect: () => Promise<unknown>;
  getStatus: () => Promise<unknown>;
  getSettings: () => Promise<unknown>;
  updateSettings: (patch: unknown) => Promise<unknown>;
  getPose: () => Promise<unknown>;
  getLastMove: () => Promise<unknown>;
  getPresetsMeta: () => Promise<unknown>;
  jog: (flags: unknown) => Promise<unknown>;
  stop: () => Promise<unknown>;
  refreshEncoders: () => Promise<unknown>;
  setPreset: (id: number) => Promise<unknown>;
  callPreset: (id: number) => Promise<unknown>;
  clearPreset: (id: number) => Promise<unknown>;
  gotoAbsolute: (pan?: number, tilt?: number) => Promise<unknown>;
  setWidgetOpacity: (opacity: number) => Promise<unknown>;
  setWidgetPinned: (pinned: boolean) => Promise<unknown>;
  setWidgetVisible: (visible: boolean) => Promise<unknown>;
  getAppConfig: () => Promise<unknown>;
  updateAppConfig: (patch: unknown) => Promise<unknown>;
  onEvent: (channel: string, cb: (payload: unknown) => void) => () => void;
};

const api: PelcoApi = {
  listPorts: () => ipcRenderer.invoke('serial:list'),
  connect: (path, baudRate) => ipcRenderer.invoke('serial:connect', { path, baudRate }),
  disconnect: () => ipcRenderer.invoke('serial:disconnect'),
  getStatus: () => ipcRenderer.invoke('serial:status'),
  getSettings: () => ipcRenderer.invoke('motion:settings'),
  updateSettings: (patch) => ipcRenderer.invoke('motion:updateSettings', patch),
  getPose: () => ipcRenderer.invoke('motion:pose'),
  getLastMove: () => ipcRenderer.invoke('motion:lastMove'),
  getPresetsMeta: () => ipcRenderer.invoke('presets:get'),
  jog: (flags) => ipcRenderer.invoke('motion:jog', flags),
  stop: () => ipcRenderer.invoke('motion:stop'),
  refreshEncoders: () => ipcRenderer.invoke('motion:refresh'),
  setPreset: (id) => ipcRenderer.invoke('motion:setPreset', id),
  callPreset: (id) => ipcRenderer.invoke('motion:callPreset', id),
  clearPreset: (id) => ipcRenderer.invoke('motion:clearPreset', id),
  gotoAbsolute: (pan, tilt) => ipcRenderer.invoke('motion:goto', { pan, tilt }),
  setWidgetOpacity: (opacity) => ipcRenderer.invoke('widget:opacity', opacity),
  setWidgetPinned: (pinned) => ipcRenderer.invoke('widget:pinned', pinned),
  setWidgetVisible: (visible) => ipcRenderer.invoke('widget:visible', visible),
  getAppConfig: () => ipcRenderer.invoke('app:getConfig'),
  updateAppConfig: (patch) => ipcRenderer.invoke('app:updateConfig', patch),
  onEvent: (channel, cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('pelco', api);
