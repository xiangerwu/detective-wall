'use strict';

const {contextBridge, ipcRenderer} = require('electron');

const actions = new Set(['start', 'stop', 'restart', 'useFreePort']);

contextBridge.exposeInMainWorld('caseGraph', Object.freeze({
  getState: () => ipcRenderer.invoke('casegraph:get-state'),
  service: action => {
    if (typeof action !== 'string' || !actions.has(action)) throw new TypeError('invalid service action');
    return ipcRenderer.invoke('casegraph:service', action);
  },
  onStateChanged: listener => {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const wrapped = (_event, value) => listener(value);
    ipcRenderer.on('casegraph:state-changed', wrapped);
    return () => ipcRenderer.removeListener('casegraph:state-changed', wrapped);
  },
}));
