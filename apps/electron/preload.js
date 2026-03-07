const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('verso', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getGatewayToken: () => ipcRenderer.invoke('get-gateway-token'),
  onGatewayLog: (callback) => ipcRenderer.on('gateway-log', (event, data) => callback(data)),
  onShowSettings: (callback) => ipcRenderer.on('show-settings', callback),

  // Gateway WebSocket connection
  connectGateway: (url) => ipcRenderer.invoke('connect-gateway', url),
  sendGatewayMessage: (message) => ipcRenderer.invoke('send-gateway-message', message),
  onGatewayMessage: (callback) => ipcRenderer.on('gateway-message', (event, data) => callback(data)),
  onGatewayConnected: (callback) => ipcRenderer.on('gateway-connected', callback),
  onGatewayDisconnected: (callback) => ipcRenderer.on('gateway-disconnected', callback),
  onGatewayRestarted: (callback) => ipcRenderer.on('gateway-restarted', callback),
  onGatewayError: (callback) => ipcRenderer.on('gateway-error', (event, msg) => callback(msg)),
  restartGateway: () => ipcRenderer.invoke('restart-gateway'),

  // OAuth authentication
  startOAuth: (params) => ipcRenderer.invoke('start-oauth', params),
});
