'use strict';

const {contextBridge, ipcRenderer} = require('electron');

const actions = new Set(['start', 'stop', 'restart', 'useFreePort']);

contextBridge.exposeInMainWorld('caseGraph', Object.freeze({
  getState: () => ipcRenderer.invoke('casegraph:get-state'),
  saveSettings: input => {
    const value = {
      port: input?.port,
      activeProjectFolder: input?.activeProjectFolder,
      aiWorkdir: input?.aiWorkdir ?? null,
    };
    return ipcRenderer.invoke('casegraph:save-settings', value);
  },
  pickDirectory: kind => {
    if (kind !== 'project' && kind !== 'aiWorkdir') throw new TypeError('invalid directory kind');
    return ipcRenderer.invoke('casegraph:pick-directory', kind);
  },
  service: action => {
    if (typeof action !== 'string' || !actions.has(action)) throw new TypeError('invalid service action');
    return ipcRenderer.invoke('casegraph:service', action);
  },
  openLogFolder: () => ipcRenderer.invoke('casegraph:open-log-folder'),
  openSettings: () => ipcRenderer.invoke('casegraph:open-settings'),
  onStateChanged: listener => {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const wrapped = (_event, value) => listener(value);
    ipcRenderer.on('casegraph:state-changed', wrapped);
    return () => ipcRenderer.removeListener('casegraph:state-changed', wrapped);
  },
  onOpenSettings: listener => {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const wrapped = () => listener();
    ipcRenderer.on('casegraph:open-settings', wrapped);
    return () => ipcRenderer.removeListener('casegraph:open-settings', wrapped);
  },
}));
