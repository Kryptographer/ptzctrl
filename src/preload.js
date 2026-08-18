'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ptz', {
  // config
  getConfig: () => ipcRenderer.invoke('config:get'),
  setMapping: (mapping) => ipcRenderer.invoke('config:setMapping', mapping),
  resetMapping: () => ipcRenderer.invoke('config:resetMapping'),
  setSettings: (settings) => ipcRenderer.invoke('config:setSettings', settings),

  // cameras
  addCamera: (cam) => ipcRenderer.invoke('cameras:add', cam),
  updateCamera: (id, patch) => ipcRenderer.invoke('cameras:update', id, patch),
  removeCamera: (id) => ipcRenderer.invoke('cameras:remove', id),
  setActiveCamera: (id) => ipcRenderer.invoke('cameras:setActive', id),
  testCamera: (id) => ipcRenderer.invoke('cameras:test', id),

  // discovery
  discover: () => ipcRenderer.invoke('discovery:run'),
  onDiscoveryProgress: (cb) => {
    const listener = (e, evt) => cb(evt);
    ipcRenderer.on('discovery:progress', listener);
    return () => ipcRenderer.removeListener('discovery:progress', listener);
  },

  // AI tracking: onnxruntime wasm + tracker model bytes (see main ai:assets)
  aiAssets: () => ipcRenderer.invoke('ai:assets'),

  // live video
  getStreamUrl: (id) => ipcRenderer.invoke('stream:getUrl', id),
  streamDiagnose: () => ipcRenderer.invoke('stream:diagnose'),
  findStream: (id) => ipcRenderer.invoke('stream:find', id),
  onFindProgress: (cb) => {
    const listener = (e, p) => cb(p);
    ipcRenderer.on('stream:findProgress', listener);
    return () => ipcRenderer.removeListener('stream:findProgress', listener);
  },

  // native controller (read in the main process via XInput so it keeps
  // working when the app window is unfocused). Emits a standard-mapping pad
  // snapshot, or null when no controller is connected.
  onNativeGamepad: (cb) => {
    const listener = (e, pad) => cb(pad);
    ipcRenderer.on('gamepad:native', listener);
    return () => ipcRenderer.removeListener('gamepad:native', listener);
  },

  // control (fire-and-forget)
  panTilt: (id, pan, tilt) => ipcRenderer.send('ptz:panTilt', id, pan, tilt),
  zoom: (id, speed) => ipcRenderer.send('ptz:zoom', id, speed),
  focus: (id, speed) => ipcRenderer.send('ptz:focus', id, speed),
  focusMode: (id, auto) => ipcRenderer.send('ptz:focusMode', id, auto),
  home: (id) => ipcRenderer.send('ptz:home', id),
  presetSave: (id, n) => ipcRenderer.send('ptz:presetSave', id, n),
  presetRecall: (id, n) => ipcRenderer.send('ptz:presetRecall', id, n),
  power: (id, on) => ipcRenderer.send('ptz:power', id, on),
  menu: (id) => ipcRenderer.send('ptz:menu', id),
  stopAll: () => ipcRenderer.send('ptz:stopAll'),
});
