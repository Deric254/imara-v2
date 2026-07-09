// preload.js — Secure IPC Bridge
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  // App info
  getAppInfo: () => {
    return new Promise((resolve) => {
      ipcRenderer.once('app-info-reply', (_event, data) => {
        resolve(data);
      });
      ipcRenderer.send('app-info');
    });
  },

  // Update handlers
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('update-available', callback);
  },

  onUpdateDownloaded: (callback) => {
    ipcRenderer.on('update-downloaded', callback);
  },

  installUpdate: () => {
    ipcRenderer.send('install-update');
  },

  removeUpdateListener: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },

  // Backup resilience
  chooseBackupFolder: () => ipcRenderer.invoke('backup:choose-folder'),
  writeBackupSecond:  (args) => ipcRenderer.invoke('backup:write-second', args),

  // Restores real keyboard focus to the window after a native confirm()/prompt()/
  // alert() dialog closes — see focus-window handler in electron-main.js.
  focusWindow: () => ipcRenderer.send('focus-window'),
});
