const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  listen: (channel, fn) => {
    const sub = (_event, ...args) => fn({ payload: args[0] });
    ipcRenderer.on(channel, sub);
    return () => ipcRenderer.removeListener(channel, sub);
  },
});

// Tauri compatibility: expose same shape so existing frontend works
contextBridge.exposeInMainWorld('__TAURI__', {
  core: {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  },
  event: {
    listen: (channel, fn) => {
      const sub = (_event, ...args) => fn({ payload: args[0] });
      ipcRenderer.on(channel, sub);
      return () => ipcRenderer.removeListener(channel, sub);
    },
  },
  window: {
    getCurrentWindow: () => ({
      startDragging: () => ipcRenderer.send('window-drag'),
    }),
  },
  webviewWindow: {
    getCurrentWebviewWindow: () => ({
      startDragging: () => ipcRenderer.send('window-drag'),
    }),
  },
});
