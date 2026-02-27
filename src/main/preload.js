const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (settings) => ipcRenderer.invoke('set-settings', settings),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectShellFolder: () => ipcRenderer.invoke('select-shell-folder'),

  // TitleDB
  updateTitleDB: () => ipcRenderer.invoke('update-titledb'),
  getTitleDBStatus: () => ipcRenderer.invoke('get-titledb-status'),

  // Scanning
  scanFolders: () => ipcRenderer.invoke('scan-folders'),

  // Processing
  processGames: (titleIds) => ipcRenderer.invoke('process-games', titleIds),
  cancelProcessing: () => ipcRenderer.invoke('cancel-processing'),
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),

  // Organize
  organizeAnalyze: (sourceFolder) => ipcRenderer.invoke('organize-analyze', sourceFolder),
  organizeExecute: (sourceFolder, actions) => ipcRenderer.invoke('organize-execute', sourceFolder, actions),

  // Progress events
  onProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('progress', listener);
    return () => ipcRenderer.removeListener('progress', listener);
  },
  onScanResult: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('scan-result', listener);
    return () => ipcRenderer.removeListener('scan-result', listener);
  },

  // Main process log forwarding
  onMainLog: (callback) => {
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on('main-log', listener);
    return () => ipcRenderer.removeListener('main-log', listener);
  },
});
