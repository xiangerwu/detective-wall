(() => {
  if (!window.__TAURI__) return;
  const invoke = window.__TAURI__.core.invoke;
  const subscriptions = [];
  const subscribe = (name, listener) => {
    let dispose, closed = false;
    const pending = window.__TAURI__.event.listen(name, event => listener(event.payload)).then(unlisten => {
      if (closed) unlisten(); else dispose = unlisten;
    });
    subscriptions.push(pending);
    return () => { closed = true; dispose?.(); };
  };
  window.caseGraph = Object.freeze({
    getState: () => invoke('get_state'),
    saveSettings: input => invoke('save_settings', {input}),
    pickDirectory: kind => invoke('pick_directory', {kind}),
    service: action => invoke('service', {action}),
    openClient: client => invoke('open_client', {client}),
    clearApplyError: () => invoke('clear_apply_error'),
    openLogFolder: () => invoke('open_log_folder'),
    openSettings: () => invoke('open_settings'),
    onStateChanged: listener => subscribe('casegraph:state-changed', listener),
    onOpenSettings: listener => subscribe('casegraph:open-settings', listener),
  });
  // Signal only after the page's inline scripts have registered their event listeners.
  document.addEventListener('DOMContentLoaded', () => Promise.all(subscriptions).then(() => invoke('renderer_ready')).catch(console.error), {once: true});
})();
