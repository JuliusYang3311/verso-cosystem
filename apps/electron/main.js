// Ensure Electron runs as app, not as Node.js
delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow, ipcMain, Menu, Tray, powerSaveBlocker } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const WebSocket = require('ws');
const { handleAuth } = require('./auth/auth-dispatcher.js');

// Prevent EPIPE crashes from killing the app (gateway pipe teardown)
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_IPC_CHANNEL_CLOSED') return;
  console.error('[Main] Uncaught exception:', err);
});

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
        && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

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
    titleBarStyle: 'hiddenInset',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false
  });

  void mainWindow.loadFile('renderer/index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Don't set mainWindow to null when closed, only when actually destroyed
  mainWindow.on('closed', () => {
    if (app.isQuitting) {
      mainWindow = null;
    }
  });
}

function createTray() {
  // Use tray-specific icon (macOS needs Template image for proper dark/light mode)
  tray = new Tray(path.join(__dirname, 'assets', 'tray-icon.png'));

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

  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
  });
}

function resolveGatewayToken(config) {
  // Match the gateway's own resolution order (auth.ts line 206):
  //   authConfig.token ?? env.VERSO_GATEWAY_TOKEN
  // Config token takes priority, then env, then launchd plist, then generate new.

  // 1. Check config (highest priority — matches gateway behavior)
  const configToken = config?.gateway?.auth?.token;
  if (configToken && configToken !== 'undefined' && configToken.length >= 16) {
    console.log('[Main] Using gateway token from config');
    return configToken;
  }

  // 2. Check process env
  const envToken = process.env.VERSO_GATEWAY_TOKEN;
  if (envToken && envToken !== 'undefined' && envToken.length >= 16) {
    console.log('[Main] Using gateway token from environment');
    return envToken;
  }

  // 3. Check the launchd plist for VERSO_GATEWAY_TOKEN
  const fs = require('fs');
  const os = require('os');
  try {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'bot.molt.gateway.plist');
    if (fs.existsSync(plistPath)) {
      const plistContent = fs.readFileSync(plistPath, 'utf8');
      const match = plistContent.match(/<key>VERSO_GATEWAY_TOKEN<\/key>\s*<string>([^<]+)<\/string>/);
      if (match && match[1]) {
        console.log('[Main] Using gateway token from launchd plist');
        return match[1];
      }
    }
  } catch {}

  // 4. Generate new
  console.log('[Main] Generated new gateway token');
  return crypto.randomBytes(32).toString('hex');
}

function ensureGatewayConfig() {
  // Ensure config allows the embedded Electron app to connect via ws://
  const fs = require('fs');
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

  if (!config.gateway) config.gateway = {};
  if (!config.gateway.controlUi) config.gateway.controlUi = {};
  if (!config.gateway.auth) config.gateway.auth = {};

  // Ensure gateway mode is set (required for gateway to start)
  if (!config.gateway.mode) {
    config.gateway.mode = 'local';
  }

  // Allow token-only auth over ws:// for the embedded control UI
  config.gateway.controlUi.allowInsecureAuth = true;

  // Resolve the gateway auth token (matches gateway's own resolution order)
  gatewayToken = resolveGatewayToken(config);

  // Always persist the resolved token to config so gateway and Electron agree
  config.gateway.auth.token = gatewayToken;

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function startGateway() {
  const port = '18789';

  // Ensure config allows embedded auth (writes token to config)
  ensureGatewayConfig();

  // Check if a gateway is already running on our port
  const net = require('net');
  const testConn = net.createConnection({ host: '127.0.0.1', port: parseInt(port) }, () => {
    testConn.destroy();
    // A gateway is already running (e.g., from a previous app session or daemon).
    // Its in-memory token may differ from what we just wrote to config.
    // Gracefully stop it and launch our own to guarantee token alignment.
    console.log('[Main] Gateway already running on port', port, '— replacing with our instance');
    killGatewayOnPort();
    // Wait for port to be released, then launch
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
        // Port is free — launch
        launchGateway(port);
      });
    };
    setTimeout(() => waitAndLaunch(10), 300);
  });
  testConn.on('error', () => {
    // Gateway not running, start one
    launchGateway(port);
  });
}

function launchGateway(port) {
  const fs = require('fs');

  // In packaged app, __dirname is inside app.asar which external node can't read.
  // asarUnpack puts gateway/ into app.asar.unpacked/ — use that path instead.
  const gatewayPath = app.isPackaged
    ? path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'gateway', 'index.js')
    : path.join(__dirname, 'gateway', 'index.js');

  // Resolve the verso gateway root.
  const os = require('os');
  const candidates = app.isPackaged
    ? [
        // Packaged: always prefer bundled resources
        path.join(process.resourcesPath, 'gateway'),
      ]
    : [
        // Dev mode: electron/  →  apps/  →  verso/
        path.resolve(__dirname, '..', '..', '..'),
        // Read workspace from config
        (() => {
          try {
            const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.verso', 'verso.json'), 'utf8'));
            return cfg.agents?.defaults?.workspace;
          } catch { return null; }
        })(),
        // Common install locations
        path.join(os.homedir(), 'Documents', 'verso'),
        path.join(os.homedir(), 'verso'),
      ].filter(Boolean);

  const resolvedGatewayRoot = candidates.find(p => fs.existsSync(path.join(p, 'dist', 'index.js')));
  if (!resolvedGatewayRoot) {
    sendGatewayError('Gateway dist not found. Searched: ' + candidates.join(', '));
    return;
  }

  console.log('[Main] Gateway root:', resolvedGatewayRoot);

  // Use bundled node if available, otherwise system node
  const bundledNode = app.isPackaged
    ? path.join(process.resourcesPath, 'gateway', 'node')
    : null;
  const nodeBin = (bundledNode && fs.existsSync(bundledNode)) ? bundledNode : 'node';

  console.log('[Main] Starting embedded gateway:', nodeBin, gatewayPath);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.VERSO_GATEWAY_PORT = port;
  env.VERSO_GATEWAY_TOKEN = gatewayToken;
  env.VERSO_EMBEDDED = 'true';
  env.ELECTRON_IS_PACKAGED = app.isPackaged ? 'true' : 'false';
  env.VERSO_GATEWAY_ROOT = resolvedGatewayRoot;

  gatewayProcess = spawn(nodeBin, [gatewayPath], {
    stdio: 'pipe',
    env
  });

  let stderrBuf = '';

  // Prevent EPIPE crashes when gateway process exits while pipes still have data
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
    // Auto-restart gateway unless app is quitting
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
      gatewayProcess.kill('SIGTERM');

      // Force kill after 5 seconds
      setTimeout(() => {
        if (gatewayProcess) {
          gatewayProcess.kill('SIGKILL');
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

  // Wait a bit before restarting
  await new Promise(resolve => setTimeout(resolve, 1000));

  startGateway();

  if (mainWindow) {
    mainWindow.webContents.send('gateway-restarted');
  }
}

function showSettings() {
  mainWindow.webContents.send('show-settings');
  mainWindow.show();
}

void app.whenReady().then(() => {
  // Prevent system sleep while Verso is running
  const sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  app.on('will-quit', () => powerSaveBlocker.stop(sleepBlockerId));

  createWindow();
  createTray();
  startGateway();

  // Set up application menu for Cmd+Q and Dock Quit
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: 'Quit Verso',
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
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  app.on('activate', () => {
    // On macOS, clicking the dock icon should show the window
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Keep app running on macOS
});

function killGatewayOnPort() {
  try {
    const { execSync } = require('child_process');
    const pids = execSync("lsof -ti:18789 2>/dev/null").toString().trim().split('\n').filter(Boolean);
    for (const pid of pids) {
      try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
    }
  } catch {
    // No process on port or lsof failed — fine
  }
}

app.on('before-quit', () => {
  app.isQuitting = true;
  // Kill the gateway we spawned (if any)
  if (gatewayProcess) {
    try {
      gatewayProcess.kill('SIGKILL');
    } catch (err) {
      console.error('Error killing gateway process:', err);
    }
  }
  // Also kill any gateway on port 18789 (even if it was already running before Electron)
  killGatewayOnPort();
});

app.on('will-quit', () => {
  if (gatewayProcess) {
    try {
      gatewayProcess.kill('SIGKILL');
    } catch {
      // Ignore errors on will-quit
    }
  }
  killGatewayOnPort();
});

// IPC handlers
ipcMain.handle('get-config', async () => {
  // Load config from ~/.verso/verso.json
  const fs = require('fs');
  const os = require('os');
  const configPath = path.join(os.homedir(), '.verso', 'verso.json');

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config;
  } catch {
    return {};
  }
});

ipcMain.handle('save-config', async (event, updates) => {
  const fs = require('fs');
  const os = require('os');
  const configPath = path.join(os.homedir(), '.verso', 'verso.json');
  const configDir = path.dirname(configPath);

  // Read existing config first to preserve gateway settings
  let existing = {};
  try {
    if (fs.existsSync(configPath)) {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {}

  // Deep merge: updates override existing, but preserve nested keys not in updates
  const merged = deepMerge(existing, updates);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
  return true;
});

// Gateway auth token handler
ipcMain.handle('get-gateway-token', async () => {
  return gatewayToken;
});

// Gateway WebSocket handlers
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

      gatewayWs.on('message', (/** @type {Buffer|string} */ data) => {
        try {
          const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
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

// OAuth authentication handler
ipcMain.handle('start-oauth', async (event, { providerName, authMethod, providerType, apiKey, token }) => {
  try {
    console.log('Starting OAuth for:', { providerName, authMethod, providerType });

    // Load current config
    const configPath = path.join(require('os').homedir(), '.verso', 'verso.json');
    let config = {};
    if (require('fs').existsSync(configPath)) {
      config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
    }

    // Handle authentication
    const result = await handleAuth({
      authMethod,
      providerType,
      mainWindow,
      config,
      apiKey,
      token,
    });

    if (result && result.success) {
      // Save updated config if provided
      if (result.config) {
        require('fs').writeFileSync(configPath, JSON.stringify(result.config, null, 2));
      }

      return {
        success: true,
        credentials: result.credentials,
        token: result.credentials?.access_token || result.token,
        refreshToken: result.credentials?.refresh_token || result.refreshToken,
      };
    }

    return {
      success: false,
      error: result?.error || 'Authentication failed',
    };
  } catch (err) {
    console.error('OAuth error:', err);
    return {
      success: false,
      error: err.message,
    };
  }
});

// Restart Gateway handler
ipcMain.handle('restart-gateway', async () => {
  try {
    await restartGateway();
    return { success: true };
  } catch (err) {
    console.error('Failed to restart gateway:', err);
    return { success: false, error: err.message };
  }
});
