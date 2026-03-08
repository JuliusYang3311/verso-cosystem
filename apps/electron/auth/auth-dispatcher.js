// Auth dispatcher — routes auth to CLI subprocess (outside asar, no ESM issues)
const { app, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const AGENT_DIR = path.join(os.homedir(), '.verso');

// OAuth methods handled via CLI subprocess
const OAUTH_METHODS = new Set([
  'openai-codex', 'minimax-portal', 'google-antigravity',
  'google-gemini-cli', 'qwen-portal', 'github-copilot', 'chutes',
]);

// ---------------------------------------------------------------------------
// Gateway node binary + CLI entry (runs outside asar)
// ---------------------------------------------------------------------------
function resolveCliPaths() {
  const res = process.resourcesPath || path.join(__dirname, '..', '..', '..');
  const bundled = path.join(res, 'gateway', 'node');
  const nodeBin = (app.isPackaged && fs.existsSync(bundled)) ? bundled : process.execPath;
  const roots = [path.join(res, 'gateway'), path.join(__dirname, '..', '..')];
  const gatewayRoot = roots.find(p => fs.existsSync(path.join(p, 'dist', 'index.js')));
  return { nodeBin, cliEntry: gatewayRoot ? path.join(gatewayRoot, 'dist', 'index.js') : null };
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const { nodeBin, cliEntry } = resolveCliPaths();
    if (!cliEntry) return reject(new Error('Gateway dist not found'));

    const child = spawn(nodeBin, [cliEntry, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VERSO_EMBEDDED: 'true' },
    });

    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => resolve({
      success: code === 0,
      output: out.trim(),
      error: code !== 0 ? (err.trim() || out.trim() || `Exit ${code}`) : undefined,
    }));
    child.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// OAuth — delegate to CLI (runs outside asar, all ESM deps available)
// ---------------------------------------------------------------------------
async function handleOAuth(authMethod) {
  try {
    return await runCli(['models', 'auth', 'login', '--provider', authMethod, '--method', authMethod]);
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// API Key — write to config directly (no ESM needed)
// ---------------------------------------------------------------------------
async function handleApiKeyAuth({ provider, apiKey }) {
  try {
    const envPath = path.join(AGENT_DIR, '.env');
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

    const key = `${provider.toUpperCase()}_API_KEY`;
    const line = `${key}=${apiKey}`;
    content = content.includes(key)
      ? content.replace(new RegExp(`${key}=.*`), line)
      : content + `\n${line}\n`;

    fs.mkdirSync(AGENT_DIR, { recursive: true });
    fs.writeFileSync(envPath, content);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Anthropic token — write to auth-profiles.json directly
// ---------------------------------------------------------------------------
async function handleAnthropicToken(token) {
  try {
    const profilePath = path.join(AGENT_DIR, 'auth-profiles.json');
    let profiles = {};
    try { profiles = JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch {}

    profiles['anthropic:default'] = { type: 'token', provider: 'anthropic', token };
    fs.mkdirSync(AGENT_DIR, { recursive: true });
    fs.writeFileSync(profilePath, JSON.stringify(profiles, null, 2));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function handleAuth({ authMethod, providerType, mainWindow, apiKey, token }) {
  console.log('[Auth]', { authMethod, providerType, apiKey: !!apiKey, token: !!token });

  if (OAUTH_METHODS.has(authMethod)) {
    return handleOAuth(authMethod);
  }
  if (authMethod === 'token' && providerType === 'anthropic') {
    return token ? handleAnthropicToken(token) : { success: false, error: 'Token is required' };
  }
  if (authMethod?.includes('api-key') || authMethod === 'apiKey') {
    return apiKey ? handleApiKeyAuth({ provider: providerType, apiKey }) : { success: false, error: 'API Key is required' };
  }
  return { success: false, error: `Unsupported auth method: ${authMethod}` };
}

module.exports = { handleAuth };
