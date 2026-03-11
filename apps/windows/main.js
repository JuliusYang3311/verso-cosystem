// Verso Desktop — Windows main process
delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow, ipcMain, Menu, Tray, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const WebSocket = require('ws');
const { handleAuth } = require('./auth/auth-dispatcher.js');
const { deepMerge } = require('../shared/js/lib/deep-merge.cjs');
const { resolveGatewayToken: resolveToken, ensureGatewayFields, loadLicenseText: findLicense } = require('../shared/js/lib/gateway-config.cjs');

// Prevent EPIPE crashes from killing the app (gateway pipe teardown)
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_IPC_CHANNEL_CLOSED') return;
  console.error('[Main] Uncaught exception:', err);
});

let mainWindow;
let tray;
let gatewayProcess;
let gatewayWs = null;
let gatewayToken = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    show: false
  });

  void mainWindow.loadFile('renderer/index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      if (mainWindow.isFullScreen()) {
        mainWindow.once('leave-full-screen', () => mainWindow.hide());
        mainWindow.setFullScreen(false);
      } else {
        mainWindow.hide();
      }
    }
  });

  mainWindow.on('closed', () => {
    if (app.isQuitting) {
      mainWindow = null;
    }
  });
}

function createTray() {
  // Windows: use .ico for tray icon
  const trayIcon = path.join(__dirname, 'assets', 'icon.ico');
  tray = new Tray(trayIcon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Verso', click: () => mainWindow.show() },
    { label: 'Settings', click: () => showSettings() },
    { type: 'separator' },
    { label: 'Quit', click: () => {
      app.isQuitting = true;
      app.quit();
    }}
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip('Verso');

  // Windows: single-click on tray icon toggles window
  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// resolveGatewayToken — delegates to shared lib

function ensureGatewayConfig() {
  const os = require('os');
  const configPath = path.join(os.homedir(), '.verso', 'verso.json');
  const configDir = path.dirname(configPath);

  let config = {};
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {
    config = {};
  }

  gatewayToken = resolveToken({ config, env: process.env, fs, crypto });
  ensureGatewayFields(config, gatewayToken);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function startGateway() {
  const port = '18789';
  ensureGatewayConfig();

  const net = require('net');
  const testConn = net.createConnection({ host: '127.0.0.1', port: parseInt(port) }, () => {
    testConn.destroy();
    console.log('[Main] Gateway already running on port', port, '— replacing with our instance');
    killGatewayOnPort();
    const waitAndLaunch = (attempts) => {
      if (attempts <= 0) {
        console.error('[Main] Port', port, 'still occupied after waiting');
        sendGatewayError('Cannot start gateway: port ' + port + ' is still in use');
        return;
      }
      const check = net.createConnection({ host: '127.0.0.1', port: parseInt(port) }, () => {
        check.destroy();
        setTimeout(() => waitAndLaunch(attempts - 1), 300);
      });
      check.on('error', () => {
        launchGateway(port);
      });
    };
    setTimeout(() => waitAndLaunch(10), 300);
  });
  testConn.on('error', () => {
    launchGateway(port);
  });
}

function launchGateway(port) {
  // In packaged app, __dirname is inside app.asar — use app.asar.unpacked for gateway/
  const gatewayPath = app.isPackaged
    ? path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'gateway', 'index.js')
    : path.join(__dirname, 'gateway', 'index.js');

  const os = require('os');
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'gateway')]
    : [
        // Dev mode: windows/ → apps/ → verso/
        path.resolve(__dirname, '..', '..'),
        (() => {
          try {
            const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.verso', 'verso.json'), 'utf8'));
            return cfg.agents?.defaults?.workspace;
          } catch { return null; }
        })(),
        path.join(os.homedir(), 'Documents', 'verso'),
        path.join(os.homedir(), 'verso'),
      ].filter(Boolean);

  const resolvedGatewayRoot = candidates.find(p => fs.existsSync(path.join(p, 'dist', 'index.js')));
  if (!resolvedGatewayRoot) {
    sendGatewayError('Gateway dist not found. Searched: ' + candidates.join(', '));
    return;
  }

  console.log('[Main] Gateway root:', resolvedGatewayRoot);

  // Use Electron's own Node.js runtime — it's already signed and trusted by Windows,
  // avoiding security blocks (SmartScreen, Defender) that hit standalone node.exe.
  const nodeBin = app.isPackaged ? process.execPath : 'node';

  console.log('[Main] Starting embedded gateway:', nodeBin, gatewayPath);

  const env = { ...process.env };
  env.ELECTRON_RUN_AS_NODE = '1';
  env.VERSO_GATEWAY_PORT = port;
  env.VERSO_GATEWAY_TOKEN = gatewayToken;
  env.VERSO_EMBEDDED = 'true';
  env.ELECTRON_IS_PACKAGED = app.isPackaged ? 'true' : 'false';
  env.VERSO_GATEWAY_ROOT = resolvedGatewayRoot;

  gatewayProcess = spawn(nodeBin, [gatewayPath], {
    stdio: 'pipe',
    env,
    // Windows: hide the console window for the child process
    windowsHide: true,
  });

  let stderrBuf = '';

  gatewayProcess.stdout.on('error', () => {});
  gatewayProcess.stderr.on('error', () => {});

  gatewayProcess.stdout.on('data', (data) => {
    const str = data.toString();
    try { console.log(`[Gateway] ${str}`); } catch {}
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('gateway-log', str); } catch {}
    }
  });

  gatewayProcess.stderr.on('data', (data) => {
    const str = data.toString();
    try { console.error(`[Gateway Error] ${str}`); } catch {}
    stderrBuf += str;
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('gateway-log', '[ERROR] ' + str); } catch {}
    }
  });

  gatewayProcess.on('close', (code) => {
    console.log(`[Main] Gateway process exited with code ${code}`);
    gatewayProcess = null;
    if (code !== 0 && code !== null) {
      const errMsg = stderrBuf.trim().slice(-500) || `exit code ${code}`;
      sendGatewayError(`Gateway crashed: ${errMsg}`);
    }
    if (!app.isQuitting) {
      console.log('[Main] Auto-restarting gateway in 2s...');
      setTimeout(() => {
        if (!app.isQuitting && !gatewayProcess) {
          startGateway();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('gateway-restarted');
          }
        }
      }, 2000);
    }
  });

  gatewayProcess.on('error', (err) => {
    console.error('[Main] Failed to spawn gateway:', err);
    sendGatewayError(`Failed to start gateway: ${err.message}`);
    gatewayProcess = null;
  });
}

function sendGatewayError(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('gateway-error', msg);
  }
}

function stopGateway() {
  return new Promise((resolve) => {
    if (gatewayProcess) {
      gatewayProcess.once('close', () => {
        gatewayProcess = null;
        resolve();
      });
      // Windows: SIGTERM is not reliable, use taskkill for the PID
      try {
        const { execSync } = require('child_process');
        execSync(`taskkill /PID ${gatewayProcess.pid} /T /F`, { timeout: 5000 });
      } catch {
        try { gatewayProcess.kill(); } catch {}
      }

      setTimeout(() => {
        if (gatewayProcess) {
          try { gatewayProcess.kill(); } catch {}
          gatewayProcess = null;
          resolve();
        }
      }, 5000);
    } else {
      resolve();
    }
  });
}

async function restartGateway() {
  console.log('[Main] Restarting Gateway...');
  await stopGateway();
  await new Promise(resolve => setTimeout(resolve, 1000));
  startGateway();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('gateway-restarted');
  }
}

function showSettings() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('show-settings');
    mainWindow.show();
  }
}

function loadLicenseText() {
  const candidates = [
    path.join(process.resourcesPath, 'LICENSE.txt'),
    path.join(__dirname, '..', '..', 'LICENSE.txt'),
    path.join(__dirname, 'LICENSE.txt'),
  ];
  return findLicense(fs, candidates);
}

function showEula() {
  return new Promise((resolve) => {
    const eulaWin = new BrowserWindow({
      width: 600,
      height: 720,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
      icon: path.join(__dirname, 'assets', 'icon.ico'),
      show: false,
    });

    void eulaWin.loadFile('renderer/eula.html');

    eulaWin.once('ready-to-show', () => {
      const text = loadLicenseText() || 'License file not found. By using this software you agree to the End User License Agreement.';
      eulaWin.webContents.send('eula-content', text);
      eulaWin.show();
    });

    ipcMain.once('eula-response', (_e, accepted) => {
      eulaWin.close();
      resolve(accepted);
    });

    eulaWin.on('closed', () => resolve(false));
  });
}

void app.whenReady().then(async () => {
  const eulaAcceptedPath = path.join(app.getPath('userData'), '.eula-accepted');
  if (!fs.existsSync(eulaAcceptedPath)) {
    const accepted = await showEula();
    if (!accepted) { app.quit(); return; }
    fs.mkdirSync(path.dirname(eulaAcceptedPath), { recursive: true });
    fs.writeFileSync(eulaAcceptedPath, new Date().toISOString());
  }

  const sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  app.on('will-quit', () => powerSaveBlocker.stop(sleepBlockerId));

  createWindow();
  createTray();
  startGateway();

  // Windows menu (File, Edit, View, Help)
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Settings', click: () => showSettings() },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            app.isQuitting = true;
            app.quit();
          }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About Verso', role: 'about' },
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
});

// Keep app running in tray when all windows are closed
app.on('window-all-closed', () => {
  // Don't quit — stay in system tray
});

function killGatewayOnPort() {
  try {
    const { execSync } = require('child_process');
    const out = execSync('netstat -ano | findstr :18789 | findstr LISTENING', { encoding: 'utf8', timeout: 5000 });
    const pids = [...new Set(out.trim().split('\n').map(l => l.trim().split(/\s+/).pop()).filter(Boolean))];
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { timeout: 5000 }); } catch {}
    }
  } catch {
    // No process on port or netstat failed — fine
  }
}

app.on('before-quit', () => {
  app.isQuitting = true;
  if (gatewayProcess) {
    try {
      const { execSync } = require('child_process');
      execSync(`taskkill /PID ${gatewayProcess.pid} /T /F`, { timeout: 5000 });
    } catch {
      try { gatewayProcess.kill(); } catch {}
    }
  }
  killGatewayOnPort();
});

app.on('will-quit', () => {
  if (gatewayProcess) {
    try {
      const { execSync } = require('child_process');
      execSync(`taskkill /PID ${gatewayProcess.pid} /T /F`, { timeout: 5000 });
    } catch {
      try { gatewayProcess.kill(); } catch {}
    }
  }
  killGatewayOnPort();
});

// IPC handlers
ipcMain.handle('get-config', async () => {
  const os = require('os');
  const configPath = path.join(os.homedir(), '.verso', 'verso.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
});

ipcMain.handle('save-config', async (event, updates) => {
  const os = require('os');
  const configPath = path.join(os.homedir(), '.verso', 'verso.json');
  const configDir = path.dirname(configPath);

  let existing = {};
  try {
    if (fs.existsSync(configPath)) {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {}

  const replaceKeys = updates._replaceKeys || [];
  delete updates._replaceKeys;
  const merged = deepMerge(existing, updates, replaceKeys);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
  return true;
});

// Provider UI metadata
const providerMetaPath = path.join(require('os').homedir(), '.verso', 'provider-meta.json');

ipcMain.handle('load-provider-meta', async () => {
  try { return JSON.parse(fs.readFileSync(providerMetaPath, 'utf8')); } catch { return {}; }
});

ipcMain.handle('save-provider-meta', async (_event, meta) => {
  fs.mkdirSync(path.dirname(providerMetaPath), { recursive: true });
  fs.writeFileSync(providerMetaPath, JSON.stringify(meta, null, 2));
});

ipcMain.handle('get-gateway-token', async () => {
  return gatewayToken;
});

ipcMain.handle('connect-gateway', async (event, url) => {
  const wsUrl = url || 'ws://localhost:18789';
  if (gatewayWs) {
    gatewayWs.close();
  }

  return new Promise((resolve, reject) => {
    try {
      gatewayWs = new WebSocket(wsUrl, {
        origin: 'https://localhost:18789',
        headers: { 'Origin': 'https://localhost:18789' }
      });

      gatewayWs.on('open', () => {
        console.log('Gateway WebSocket connected');
        mainWindow.webContents.send('gateway-connected');
        resolve(true);
      });

      gatewayWs.on('message', (data) => {
        try {
          const raw = Buffer.isBuffer(data) ? data.toString('utf8') : typeof data === 'string' ? data : JSON.stringify(data);
          const message = JSON.parse(raw);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('gateway-message', message);
          }
        } catch (err) {
          console.error('Failed to parse gateway message:', err);
        }
      });

      gatewayWs.on('close', (code, reason) => {
        console.log('Gateway WebSocket disconnected, code:', code, 'reason:', reason?.toString());
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('gateway-disconnected');
        }
        gatewayWs = null;
      });

      gatewayWs.on('error', (err) => {
        console.error('Gateway WebSocket error:', err);
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
});

ipcMain.handle('send-gateway-message', async (event, message) => {
  if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
    gatewayWs.send(JSON.stringify(message));
    return true;
  }
  return false;
});

ipcMain.handle('start-oauth', async (event, { providerName, authMethod, providerType, apiKey, token }) => {
  try {
    console.log('Starting OAuth for:', { providerName, authMethod, providerType });
    const configPath = path.join(require('os').homedir(), '.verso', 'verso.json');
    let config = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }

    const result = await handleAuth({
      authMethod,
      providerType,
      mainWindow,
      config,
      apiKey,
      token,
    });

    if (result && result.success) {
      if (result.config) {
        fs.writeFileSync(configPath, JSON.stringify(result.config, null, 2));
      }
      return {
        success: true,
        credentials: result.credentials,
        token: result.credentials?.access_token || result.token,
        refreshToken: result.credentials?.refresh_token || result.refreshToken,
      };
    }

    return { success: false, error: result?.error || 'Authentication failed' };
  } catch (err) {
    console.error('OAuth error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('restart-gateway', async () => {
  try {
    await restartGateway();
    return { success: true };
  } catch (err) {
    console.error('Failed to restart gateway:', err);
    return { success: false, error: err.message };
  }
});
