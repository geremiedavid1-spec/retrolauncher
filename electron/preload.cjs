const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("retro", {
  scan: () => ipcRenderer.invoke("scan"),
  listGames: () => ipcRenderer.invoke("listGames"),
  play: (id) => ipcRenderer.invoke("play", id),
  toggleFavorite: (id) => ipcRenderer.invoke("toggleFavorite", id),
  onScanProgress: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on("scanProgress", listener);
    return () => ipcRenderer.removeListener("scanProgress", listener);
  }
});
