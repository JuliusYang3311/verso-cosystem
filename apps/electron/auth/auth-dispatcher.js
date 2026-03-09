// Auth dispatcher — handles OAuth, API key, and token auth for Electron
const { shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');

const STATE_DIR = path.join(os.homedir(), '.verso');
const AUTH_AGENT_DIR = path.join(STATE_DIR, 'agents', 'main', 'agent');
const AUTH_PROFILE_PATH = path.join(AUTH_AGENT_DIR, 'auth-profiles.json');

// OAuth methods handled via pi-ai
const OAUTH_METHODS = new Set([
  'openai-codex', 'minimax-portal', 'google-antigravity',
  'google-gemini-cli', 'qwen-portal', 'github-copilot',
]);

// ---------------------------------------------------------------------------
// Write OAuth credentials to auth-profiles.json (same format as gateway CLI)
// ---------------------------------------------------------------------------
function writeOAuthToAuthProfiles(provider, creds) {
  fs.mkdirSync(AUTH_AGENT_DIR, { recursive: true });
  let store = { version: 1, profiles: {} };
  try { store = JSON.parse(fs.readFileSync(AUTH_PROFILE_PATH, 'utf8')); } catch {}
  if (!store.profiles) store.profiles = {};

  const email = typeof creds.email === 'string' && creds.email.trim() ? creds.email.trim() : 'default';
  const profileId = `${provider}:${email}`;
  store.profiles[profileId] = {
    type: 'oauth',
    provider,
    ...creds,
  };
  store.version = store.version || 1;
  fs.writeFileSync(AUTH_PROFILE_PATH, JSON.stringify(store, null, 2));
  console.log('[Auth] Wrote auth profile:', profileId, 'to', AUTH_PROFILE_PATH);
}

// ---------------------------------------------------------------------------
// ESM import helper — resolve from asar.unpacked when packaged
// ---------------------------------------------------------------------------
function resolveUnpackedModule(packageName) {
  // In dev mode, normal resolution works fine
  const resolved = require.resolve(`${packageName}/package.json`);
  // In packaged app, redirect from app.asar → app.asar.unpacked
  return pathToFileURL(
    path.join(
      path.dirname(resolved.replace('app.asar', 'app.asar.unpacked')),
      'dist', 'index.js'
    )
  ).href;
}

// ---------------------------------------------------------------------------
// OAuth — import pi-ai from unpacked path to avoid ESM-in-asar issues
// ---------------------------------------------------------------------------
async function handleOAuth({ authMethod, mainWindow: _mainWindow }) {
  try {
    console.log('[Auth] Starting OAuth:', authMethod);
    const piAiUrl = resolveUnpackedModule('@mariozechner/pi-ai');
    console.log('[Auth] Importing pi-ai from:', piAiUrl);
    const piAi = await import(piAiUrl);

    if (authMethod === 'openai-codex') {
      const { loginOpenAICodex } = piAi;
      const creds = await loginOpenAICodex({
        onAuth: async ({ url }) => {
          console.log('[Auth] Opening browser:', url);
          await shell.openExternal(url);
        },
        onPrompt: async () => '',
        onProgress: (msg) => console.log('[Auth Progress]', msg),
      });

      if (creds) {
        writeOAuthToAuthProfiles('openai-codex', creds);
        return { success: true, credentials: creds };
      }
      return { success: false, error: 'No credentials returned' };
    }

    // For other OAuth methods, try the generic loginXxx pattern
    const methodMap = {
      'minimax-portal': 'loginMiniMaxPortal',
      'google-antigravity': 'loginGoogleAntigravity',
      'google-gemini-cli': 'loginGoogleGeminiCli',
      'qwen-portal': 'loginQwenPortal',
      'github-copilot': 'loginGithubCopilot',
    };

    const fnName = methodMap[authMethod];
    if (fnName && typeof piAi[fnName] === 'function') {
      const creds = await piAi[fnName]({
        onAuth: async ({ url }) => { await shell.openExternal(url); },
        onPrompt: async () => '',
        onProgress: (msg) => console.log('[Auth Progress]', msg),
      });
      if (creds) {
        writeOAuthToAuthProfiles(authMethod, creds);
        return { success: true, credentials: creds };
      }
      return { success: false, error: 'No credentials returned' };
    }

    return { success: false, error: `OAuth method "${authMethod}" not found in pi-ai` };
  } catch (err) {
    console.error('[Auth] OAuth error:', err);
    return { success: false, error: err.message || 'OAuth failed' };
  }
}

// ---------------------------------------------------------------------------
// API Key — write directly (no ESM needed)
// ---------------------------------------------------------------------------
async function handleApiKeyAuth({ provider, apiKey }) {
  try {
    fs.mkdirSync(AUTH_AGENT_DIR, { recursive: true });
    let store = { version: 1, profiles: {} };
    try { store = JSON.parse(fs.readFileSync(AUTH_PROFILE_PATH, 'utf8')); } catch {}
    if (!store.profiles) store.profiles = {};

    store.profiles[`${provider}:default`] = { type: 'api_key', provider, key: apiKey };
    store.version = store.version || 1;
    fs.writeFileSync(AUTH_PROFILE_PATH, JSON.stringify(store, null, 2));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Anthropic token — write to auth-profiles.json
// ---------------------------------------------------------------------------
async function handleAnthropicToken(token) {
  try {
    fs.mkdirSync(AUTH_AGENT_DIR, { recursive: true });
    let store = { version: 1, profiles: {} };
    try { store = JSON.parse(fs.readFileSync(AUTH_PROFILE_PATH, 'utf8')); } catch {}
    if (!store.profiles) store.profiles = {};

    store.profiles['anthropic:default'] = { type: 'token', provider: 'anthropic', token };
    store.version = store.version || 1;
    fs.writeFileSync(AUTH_PROFILE_PATH, JSON.stringify(store, null, 2));
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
    return handleOAuth({ authMethod, mainWindow });
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
