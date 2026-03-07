// Auth dispatcher - routes auth requests to appropriate handlers
// Simplified version using CommonJS

const { shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Simple prompter implementation for Electron
class ElectronPrompter {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
  }

  async note(message, title) {
    console.log(`[${title}] ${message}`);
    return Promise.resolve();
  }

  async text({ message: _message, validate: _validate, placeholder: _placeholder }) {
    // For now, return empty - will be replaced with proper UI prompts
    return '';
  }

  async confirm({ message: _message, initialValue }) {
    return initialValue ?? true;
  }

  progress(message) {
    console.log(`[Progress] ${message}`);
    return {
      update: (msg) => console.log(`[Progress] ${msg}`),
      stop: (msg) => console.log(`[Progress Done] ${msg}`),
    };
  }
}

// Runtime logger
const runtime = {
  log: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

// Open URL in default browser
async function openUrl(url) {
  await shell.openExternal(url);
}

// Handle OpenAI Codex OAuth
async function handleOpenAICodexOAuth({ mainWindow, agentDir }) {
  try {
    // Use dynamic import for ES Module
    const piAi = await import('@mariozechner/pi-ai');
    const { loginOpenAICodex } = piAi;

    const prompter = new ElectronPrompter(mainWindow);
    const spin = prompter.progress('Starting OAuth flow…');

    const creds = await loginOpenAICodex({
      onAuth: async ({ url }) => {
        spin.update('Opening browser for authentication...');
        await openUrl(url);
        runtime.log(`Open: ${url}`);
      },
      onPrompt: async (_prompt) => {
        // Return empty for now - the OAuth should complete via callback
        // In a full implementation, we'd show a dialog here
        return '';
      },
      onProgress: (msg) => {
        spin.update(msg);
        console.log('[OAuth Progress]', msg);
      },
    });

    spin.stop('OpenAI OAuth complete');

    if (creds) {
      // Save credentials
      const credsPath = path.join(agentDir, 'oauth-credentials.json');
      let allCreds = {};
      if (fs.existsSync(credsPath)) {
        allCreds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      }
      allCreds['openai-codex'] = creds;
      fs.mkdirSync(path.dirname(credsPath), { recursive: true });
      fs.writeFileSync(credsPath, JSON.stringify(allCreds, null, 2));

      console.log('OpenAI Codex OAuth successful');

      return {
        success: true,
        credentials: creds,
      };
    }

    return {
      success: false,
      error: 'OAuth failed - no credentials returned',
    };
  } catch (err) {
    console.error('OpenAI Codex OAuth error:', err);
    return {
      success: false,
      error: err.message || 'OAuth failed',
    };
  }
}

// Handle API Key authentication
async function handleApiKeyAuth({ provider, apiKey, agentDir }) {
  try {
    const envPath = path.join(agentDir, '.env');
    let envContent = '';

    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    // Update or add API key
    const keyName = `${provider.toUpperCase()}_API_KEY`;
    const keyLine = `${keyName}=${apiKey}`;

    if (envContent.includes(keyName)) {
      envContent = envContent.replace(new RegExp(`${keyName}=.*`), keyLine);
    } else {
      envContent += `\n${keyLine}\n`;
    }

    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, envContent);

    return {
      success: true,
    };
  } catch (err) {
    console.error('API Key auth error:', err);
    return {
      success: false,
      error: err.message,
    };
  }
}

// Handle Anthropic setup-token
async function handleAnthropicToken({ token, agentDir }) {
  try {
    const profilePath = path.join(agentDir, 'auth-profiles.json');
    let profiles = {};

    if (fs.existsSync(profilePath)) {
      profiles = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    }

    profiles['anthropic:default'] = {
      type: 'token',
      provider: 'anthropic',
      token: token,
    };

    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, JSON.stringify(profiles, null, 2));

    return {
      success: true,
    };
  } catch (err) {
    console.error('Anthropic token auth error:', err);
    return {
      success: false,
      error: err.message,
    };
  }
}

async function handleAuth({ authMethod, providerType, mainWindow, config: _config, apiKey, token }) {
  const agentDir = path.join(os.homedir(), '.verso');

  console.log('[Auth Dispatcher] Received:', { authMethod, providerType, apiKey: !!apiKey, token: !!token });

  let result = null;

  // Route to appropriate handler based on auth method
  if (authMethod === 'openai-codex') {
    console.log('[Auth Dispatcher] Routing to OpenAI Codex OAuth');
    result = await handleOpenAICodexOAuth({ mainWindow, agentDir });
  } else if (authMethod === 'minimax-portal') {
    result = {
      success: false,
      error: 'MiniMax OAuth not yet implemented. Please use CLI: verso auth --provider minimax-portal',
    };
  } else if (authMethod === 'token' && providerType === 'anthropic') {
    // Anthropic setup-token
    if (!token) {
      result = {
        success: false,
        error: 'Token is required',
      };
    } else {
      result = await handleAnthropicToken({ token, agentDir });
    }
  } else if (authMethod && (authMethod.includes('api-key') || authMethod === 'apiKey')) {
    // API Key authentication
    if (!apiKey) {
      result = {
        success: false,
        error: 'API Key is required',
      };
    } else {
      result = await handleApiKeyAuth({ provider: providerType, apiKey, agentDir });
    }
  } else {
    console.log('[Auth Dispatcher] No matching handler for:', authMethod);
    result = {
      success: false,
      error: `OAuth login for ${authMethod} is not yet implemented in the desktop app.\n\nFor now, please use the CLI to authenticate:\n\nverso auth --provider ${authMethod}`,
    };
  }

  console.log('[Auth Dispatcher] Result:', result);
  return result;
}

module.exports = {
  handleAuth,
  handleApiKeyAuth,
  handleAnthropicToken,
};
