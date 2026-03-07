#!/usr/bin/env node

// Gateway entry point for embedded Electron app
// Starts verso gateway as a subprocess
const path = require('path');

// Determine if we're in production (packaged) or development
const isPackaged = process.env.ELECTRON_IS_PACKAGED === 'true';

let gatewayRoot;
if (isPackaged) {
  // In production, the gateway root is passed via env or inferred from this script's location.
  // When packaged, this file is in Resources/app/gateway/index.js (or asar-unpacked).
  // The verso dist/node_modules are in Resources/gateway/.
  // The main process passes VERSO_GATEWAY_ROOT for clarity.
  gatewayRoot = process.env.VERSO_GATEWAY_ROOT || path.join(__dirname, '..', '..', 'gateway');
} else {
  // In development, use the root project directory (gateway/ -> electron/ -> apps/ -> verso/)
  gatewayRoot = path.join(__dirname, '../../..');
}

const port = process.env.VERSO_GATEWAY_PORT || '18789';

console.log('[Gateway] Starting embedded gateway...');
console.log('[Gateway] Root:', gatewayRoot);
console.log('[Gateway] Packaged:', isPackaged);

// Run verso gateway command
const versoBin = path.join(gatewayRoot, 'dist', 'index.js');

// Set argv to simulate: verso gateway --port 18789
process.argv = [process.execPath, versoBin, 'gateway', '--port', port];

// Set working directory to verso root
process.chdir(gatewayRoot);

// Import and run
async function boot() {
  try {
    await import(versoBin);
  } catch (err) {
    console.error('[Gateway] Failed to load gateway runtime:', err);
    console.error('[Gateway] Attempted to load:', versoBin);
    process.exit(1);
  }
}
boot().catch(err => { console.error('Gateway boot failed:', err); process.exit(1); });
