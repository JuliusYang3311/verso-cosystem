// App initialization and navigation

// ==================== LOAD GUARD (dedup) ====================
const _loadingSection = {};
function guardedLoad(section, fn) {
  if (_loadingSection[section]) return;
  _loadingSection[section] = true;
  Promise.resolve(fn()).catch(e => console.error(`[${section}] load error:`, e)).finally(() => { _loadingSection[section] = false; });
}

// ==================== NAVIGATION ====================

// Cache nav and section elements once
const _navItems = document.querySelectorAll('.nav-item');
const _sections = document.querySelectorAll('.section');

_navItems.forEach(item => {
  item.addEventListener('click', () => {
    const section = item.dataset.section;
    _navItems.forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    _sections.forEach(s => s.classList.remove('active'));
    document.getElementById(section).classList.add('active');
    loadSection(section);
  });
});

function loadSection(section) {
  switch (section) {
    case 'chat': guardedLoad('chat', loadChatSessions); break;
    case 'overview': guardedLoad('overview', loadOverview); break;
    case 'sessions': guardedLoad('sessions', loadSessions); break;
    case 'channels': guardedLoad('channels', loadChannels); break;
    case 'cron': guardedLoad('cron', loadCronJobs); break;
    case 'orchestration': guardedLoad('orchestration', loadOrchestration); break;
    case 'instances': guardedLoad('instances', loadInstances); break;
    case 'usage': guardedLoad('usage', loadUsage); break;
    case 'settings':
      loadGeneralSettings();
      break;
  }
}

// ==================== SETTINGS TABS ====================

// Cache settings tabs and panels for fast switching
const _settingsTabs = document.querySelectorAll('.settings-tab');
const _settingsPanels = document.querySelectorAll('.settings-panel');
const _settingsLoaded = new Set(); // track which tabs have been loaded

_settingsTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    // Instant tab switch (no async)
    _settingsTabs.forEach(t => t.classList.remove('active'));
    _settingsPanels.forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');

    // Load data in background (only on first visit or explicit refresh)
    const tabId = tab.dataset.tab;
    if (!_settingsLoaded.has(tabId)) {
      _settingsLoaded.add(tabId);
      if (tabId === 'general-tab') loadGeneralSettings();
      else if (tabId === 'providers-tab' && window.loadProviders) { loadProviders().then(() => renderProviders()); }
      else if (tabId === 'channels-tab') loadChannelsConfig();
      else if (tabId === 'config-tab') loadRawConfig();
      else if (tabId === 'evolver-tab') loadEvolverSettings();
      else if (tabId === 'memory-tab' || tabId === 'browser-tab' || tabId === 'webtools-tab') loadSettingsFromConfig();
    }
  });
});

// ==================== CHAT EVENT HANDLERS ====================

document.getElementById('chat-session-select').addEventListener('change', () => loadChatHistory());

document.getElementById('chat-send-btn').addEventListener('click', () => sendChatMessage());
document.getElementById('chat-abort-btn').addEventListener('click', () => abortChat());
document.getElementById('chat-refresh-btn').addEventListener('click', () => loadChatHistory());

document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

// Auto-resize chat input
document.getElementById('chat-input').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

// ==================== BUTTON HANDLERS ====================

document.getElementById('sessions-refresh-btn').addEventListener('click', () => loadSessions());
document.getElementById('session-back-btn').addEventListener('click', () => sessionBack());
document.getElementById('session-reset-btn').addEventListener('click', () => resetSession());
document.getElementById('session-compact-btn').addEventListener('click', () => compactSession());
document.getElementById('session-delete-btn').addEventListener('click', () => deleteSession());

document.getElementById('channels-refresh-btn').addEventListener('click', () => loadChannels());
document.getElementById('cron-refresh-btn').addEventListener('click', () => loadCronJobs());
document.getElementById('cron-add-btn').addEventListener('click', () => showCronAddModal());
document.getElementById('cron-save-btn').addEventListener('click', () => saveCronJob());
document.getElementById('orch-refresh-btn').addEventListener('click', () => loadOrchestration());
document.getElementById('instances-refresh-btn').addEventListener('click', () => loadInstances());
document.getElementById('usage-refresh-btn').addEventListener('click', () => loadUsage());
document.getElementById('usage-period').addEventListener('change', () => loadUsage());

document.getElementById('config-save-btn').addEventListener('click', () => saveRawConfig());
document.getElementById('config-reload-btn').addEventListener('click', () => loadRawConfig());

// ==================== GATEWAY STATUS ====================

window.verso.onGatewayConnected(() => {
  document.getElementById('status-dot').classList.add('connected');
  document.getElementById('status-text').textContent = 'Gateway: Connected';
  document.getElementById('status-text').style.color = '';
});

window.verso.onGatewayDisconnected(() => {
  document.getElementById('status-dot').classList.remove('connected');
  document.getElementById('status-text').textContent = 'Gateway: Disconnected';
});

window.verso.onGatewayError((msg) => {
  document.getElementById('status-dot').classList.remove('connected');
  document.getElementById('status-text').textContent = 'Gateway Error: ' + msg.slice(0, 120);
  document.getElementById('status-text').style.color = '#ff9800';
  console.error('[Gateway Error]', msg);
});

// When handshake completes, load the active section
window.gatewayClient.on('handshake', () => {
  const activeNav = document.querySelector('.nav-item.active');
  if (activeNav) {
    loadSection(activeNav.dataset.section);
  }
});

// ==================== GATEWAY RPC HELPER ====================

// Wraps gateway RPC with a timeout so the UI never hangs when gateway is disconnected
function gatewayRpcWithTimeout(fn, timeoutMs = 3000) {
  return Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Gateway RPC timeout')), timeoutMs))
  ]).catch(err => {
    console.warn('Gateway RPC failed (non-blocking):', err.message);
  });
}

// Apply config to gateway (fire-and-forget with timeout)
// config.set requires baseHash from config.get to prevent conflicts
window.applyConfigToGateway = applyConfigToGateway;
async function applyConfigToGateway(config) {
  await gatewayRpcWithTimeout(async () => {
    // Get current hash first
    const current = await window.gatewayClient.getGatewayConfig();
    const baseHash = current?.hash || current?.baseHash || '';
    await window.gatewayClient.setGatewayConfig({
      raw: JSON.stringify(config, null, 2),
      baseHash,
    });
  });
}

// ==================== UNIFIED SAVE ALL SETTINGS ====================

window.saveAllSettings = async function() {
  const btn = document.getElementById('save-all-settings-btn');
  if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }

  try {
    const config = await window.verso.getConfig();

    // --- General ---
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    const ws = document.getElementById('general-workspace')?.value?.trim();
    if (ws) config.agents.defaults.workspace = ws;
    else delete config.agents.defaults.workspace;

    // --- Providers (use the provider module's data) ---
    if (window.providers && typeof window.toGatewayProvider === 'function') {
      if (!config.models) config.models = {};
      const gatewayProviders = {};
      for (const [name, provider] of Object.entries(window.providers)) {
        gatewayProviders[name] = window.toGatewayProvider(provider);
      }
      config.models.providers = gatewayProviders;
    }

    // --- Channels (delegate to channels-config if available) ---
    if (typeof window.collectChannelConfig === 'function') {
      window.collectChannelConfig(config);
    } else {
      // Fallback: inline channel collection
      if (!config.channels) config.channels = {};
      const setIfExists = (id) => {
        const el = document.getElementById(id);
        return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined;
      };
      const tgToken = setIfExists('telegram-token');
      const tgEnabled = setIfExists('telegram-enabled');
      if (tgToken || tgEnabled !== undefined) {
        if (!config.channels.telegram) config.channels.telegram = {};
        if (tgToken) config.channels.telegram.botToken = tgToken;
        if (tgEnabled !== undefined) config.channels.telegram.enabled = tgEnabled;
      }
      const dcToken = setIfExists('discord-token');
      const dcEnabled = setIfExists('discord-enabled');
      if (dcToken || dcEnabled !== undefined) {
        if (!config.channels.discord) config.channels.discord = {};
        if (dcToken) config.channels.discord.token = dcToken;
        if (dcEnabled !== undefined) config.channels.discord.enabled = dcEnabled;
      }
      const slBot = setIfExists('slack-bot-token');
      const slApp = setIfExists('slack-app-token');
      const slEnabled = setIfExists('slack-enabled');
      if (slBot || slApp || slEnabled !== undefined) {
        if (!config.channels.slack) config.channels.slack = {};
        if (slBot) config.channels.slack.botToken = slBot;
        if (slApp) config.channels.slack.appToken = slApp;
        if (slEnabled !== undefined) config.channels.slack.enabled = slEnabled;
      }
    }

    // --- Memory ---
    if (!config.agents.defaults.memorySearch) config.agents.defaults.memorySearch = {};
    const me = document.getElementById('memory-enabled');
    if (me) config.agents.defaults.memorySearch.enabled = me.checked;
    const ep = document.getElementById('embedding-provider');
    if (ep) config.agents.defaults.memorySearch.provider = ep.value;
    const em = document.getElementById('embedding-model');
    if (em) config.agents.defaults.memorySearch.model = em.value;

    // --- Browser ---
    if (!config.browser) config.browser = {};
    const be = document.getElementById('browser-enabled');
    if (be) config.browser.enabled = be.checked;
    const bh = document.getElementById('browser-headless');
    if (bh) config.browser.headless = bh.checked;

    // --- Evolver ---
    if (!config.evolver) config.evolver = {};
    const reviewEl = document.getElementById('evolver-review');
    if (reviewEl) config.evolver.review = reviewEl.checked;

    // --- Web Tools ---
    if (!config.tools) config.tools = {};
    if (!config.tools.web) config.tools.web = {};
    if (!config.tools.web.search) config.tools.web.search = {};
    const we = document.getElementById('web-enabled');
    if (we) config.tools.web.search.enabled = we.checked;
    const ba = document.getElementById('brave-api-key');
    if (ba) config.tools.web.search.apiKey = ba.value;

    // --- Save once ---
    await window.verso.saveConfig(config);

    // --- Apply to gateway once (with timeout) ---
    await applyConfigToGateway(config);

    showNotification('All settings saved');
  } catch (err) {
    console.error('saveAllSettings error:', err);
    showNotification('Failed to save: ' + err.message, 'error');
  } finally {
    if (btn) { btn.textContent = 'Save All Settings'; btn.disabled = false; }
  }
}

// ==================== SETTINGS LOAD/SAVE ====================

async function loadSettingsFromConfig() {
  const config = await window.verso.getConfig();
  loadConfig(config);
}

async function loadChannelsConfig() {
  const config = await window.verso.getConfig();
  const container = document.getElementById('channels-config-container');
  if (!container) return;

  const channelTypes = ['telegram', 'whatsapp', 'discord', 'slack'];
  const channelLabels = { telegram: 'Telegram', whatsapp: 'WhatsApp', discord: 'Discord', slack: 'Slack' };

  // Only show supported channels (telegram, whatsapp, discord, slack)
  const allChannels = channelTypes;

  container.innerHTML = allChannels.map(ch => {
    const chConfig = config?.channels?.[ch] || {};
    const label = channelLabels[ch] || ch;
    const isConfigured = Object.keys(chConfig).length > 0;

    return `
      <div style="background:#1a1a1a;border-radius:8px;padding:16px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <h4>${escapeHtml(label)}</h4>
          <div style="display:flex;gap:6px;align-items:center;">
            ${isConfigured ? '<span style="color:#4caf50;font-size:11px;">Configured</span>' : '<span style="color:#888;font-size:11px;">Not configured</span>'}
            <button class="btn btn-small btn-secondary" onclick="configureChannel('${escapeHtml(ch)}')">Configure & Pair</button>
          </div>
        </div>
        <div style="font-size:12px;color:#888;">
          ${ch === 'whatsapp' ? 'QR code pairing' : ch === 'telegram' ? 'Bot token from @BotFather' : ch === 'discord' ? 'Bot token from Developer Portal' : ch === 'slack' ? 'Bot + App tokens' : 'Custom channel'}
        </div>
      </div>
    `;
  }).join('');
}

function loadConfig(config) {
  // Memory
  if (config?.agents?.defaults?.memorySearch) {
    const ms = config.agents.defaults.memorySearch;
    const el = document.getElementById('memory-enabled');
    if (el) el.checked = ms.enabled !== false;
    const ep = document.getElementById('embedding-provider');
    if (ep && ms.provider) {
      ep.value = ms.provider;
      // Update model list to match selected provider
      if (window.onEmbeddingProviderChange) window.onEmbeddingProviderChange();
    }
    // Set model after provider change updated the options
    const emSel = document.getElementById('embedding-model');
    if (emSel && ms.model) emSel.value = ms.model;
  }

  // Browser
  if (config?.browser) {
    const be = document.getElementById('browser-enabled');
    if (be) be.checked = config.browser.enabled !== false;
    const bh = document.getElementById('browser-headless');
    if (bh) bh.checked = config.browser.headless !== false;
  }

  // Web Tools
  if (config?.tools?.web) {
    const we = document.getElementById('web-enabled');
    if (we) we.checked = config.tools.web.enabled !== false;
    const ba = document.getElementById('brave-api-key');
    if (ba && config.tools.web.search?.apiKey) ba.value = config.tools.web.search.apiKey;
  }
}

window.saveChannels = async function() {
  const config = await window.verso.getConfig();
  if (!config.channels) config.channels = {};

  const setIfExists = (id) => {
    const el = document.getElementById(id);
    return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined;
  };

  // Telegram
  const tgToken = setIfExists('telegram-token');
  const tgEnabled = setIfExists('telegram-enabled');
  if (tgToken || tgEnabled !== undefined) {
    if (!config.channels.telegram) config.channels.telegram = {};
    if (tgToken) config.channels.telegram.botToken = tgToken;
    if (tgEnabled !== undefined) config.channels.telegram.enabled = tgEnabled;
  }

  // Discord
  const dcToken = setIfExists('discord-token');
  const dcEnabled = setIfExists('discord-enabled');
  if (dcToken || dcEnabled !== undefined) {
    if (!config.channels.discord) config.channels.discord = {};
    if (dcToken) config.channels.discord.token = dcToken;
    if (dcEnabled !== undefined) config.channels.discord.enabled = dcEnabled;
  }

  // Slack
  const slBot = setIfExists('slack-bot-token');
  const slApp = setIfExists('slack-app-token');
  const slEnabled = setIfExists('slack-enabled');
  if (slBot || slApp || slEnabled !== undefined) {
    if (!config.channels.slack) config.channels.slack = {};
    if (slBot) config.channels.slack.botToken = slBot;
    if (slApp) config.channels.slack.appToken = slApp;
    if (slEnabled !== undefined) config.channels.slack.enabled = slEnabled;
  }

  // WhatsApp — top-level WhatsAppConfigSchema does not support 'enabled' (strict schema)
  // WhatsApp is enabled by having valid config; no explicit enabled flag needed

  await window.verso.saveConfig(config);
  showNotification('Channel settings saved');
}

window.saveMemory = async function() {
  const config = await window.verso.getConfig();
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.memorySearch) config.agents.defaults.memorySearch = {};

  const me = document.getElementById('memory-enabled');
  if (me) config.agents.defaults.memorySearch.enabled = me.checked;

  const ep = document.getElementById('embedding-provider');
  if (ep) config.agents.defaults.memorySearch.provider = ep.value;

  const em = document.getElementById('embedding-model');
  if (em) config.agents.defaults.memorySearch.model = em.value;

  await window.verso.saveConfig(config);
  showNotification('Memory settings saved');
}

window.saveBrowser = async function() {
  const config = await window.verso.getConfig();
  if (!config.browser) config.browser = {};
  const be = document.getElementById('browser-enabled');
  if (be) config.browser.enabled = be.checked;
  const bh = document.getElementById('browser-headless');
  if (bh) config.browser.headless = bh.checked;
  await window.verso.saveConfig(config);
  showNotification('Browser settings saved');
}

window.saveWebTools = async function() {
  const config = await window.verso.getConfig();
  if (!config.tools) config.tools = {};
  if (!config.tools.web) config.tools.web = {};
  if (!config.tools.web.search) config.tools.web.search = {};

  const we = document.getElementById('web-enabled');
  if (we) config.tools.web.search.enabled = we.checked;
  const ba = document.getElementById('brave-api-key');
  if (ba) config.tools.web.search.apiKey = ba.value;

  await window.verso.saveConfig(config);
  showNotification('Web tools settings saved');
}

// ==================== GENERAL SETTINGS ====================

async function loadGeneralSettings() {
  const config = await window.verso.getConfig();
  const ws = config?.agents?.defaults?.workspace || '';
  const el = document.getElementById('general-workspace');
  if (el) el.value = ws;
  const portEl = document.getElementById('general-gateway-port');
  if (portEl) portEl.value = '18789';
}
window.loadGeneralSettings = loadGeneralSettings;

window.saveGeneral = async function() {
  // Now handled by saveAllSettings — kept as no-op for backwards compat
  showNotification('Use "Save All Settings" to save');
}

// ==================== EVOLVER SETTINGS ====================

async function loadEvolverSettings() {
  const config = await window.verso.getConfig();
  const ev = config?.evolver || {};
  const el = document.getElementById('evolver-review');
  if (el) el.checked = !!ev.review;

  // Check evolver running status via chat command
  const statusEl = document.getElementById('evolver-status');
  const toggleEl = document.getElementById('evolver-enabled');
  if (statusEl) statusEl.textContent = 'Checking...';
  try {
    const result = await window.gatewayClient.chatInject({
      sessionKey: 'agent:main:main',
      message: '/evolve status',
    });
    const text = result?.text || result?.reply?.text || '';
    const running = text.includes('running');
    if (statusEl) statusEl.textContent = running ? 'Running' : 'Stopped';
    if (statusEl) statusEl.style.color = running ? '#4caf50' : '#888';
    if (toggleEl) toggleEl.checked = running;
  } catch {
    if (statusEl) statusEl.textContent = 'Unknown';
    if (statusEl) statusEl.style.color = '#888';
  }
}
window.loadEvolverSettings = loadEvolverSettings;

window.toggleEvolver = async function() {
  const toggleEl = document.getElementById('evolver-enabled');
  const statusEl = document.getElementById('evolver-status');
  if (!toggleEl) return;

  const enable = toggleEl.checked;
  const command = enable ? '/evolve on' : '/evolve off';

  if (statusEl) {
    statusEl.textContent = enable ? 'Starting...' : 'Stopping...';
    statusEl.style.color = '#ff9800';
  }

  try {
    const result = await window.gatewayClient.chatInject({
      sessionKey: 'agent:main:main',
      message: command,
    });
    const text = result?.text || result?.reply?.text || '';
    const started = text.includes('started') || text.includes('running');
    const stopped = text.includes('stopped') || text.includes('not running');
    if (statusEl) {
      statusEl.textContent = started ? 'Running' : stopped ? 'Stopped' : text.slice(0, 60);
      statusEl.style.color = started ? '#4caf50' : '#888';
    }
    showNotification(enable ? 'Evolver started' : 'Evolver stopped');
  } catch (err) {
    if (statusEl) { statusEl.textContent = 'Error'; statusEl.style.color = '#f44336'; }
    showNotification('Failed to toggle evolver: ' + err.message, 'error');
    toggleEl.checked = !enable; // revert
  }
}

window.saveEvolver = async function() {
  // Now handled by saveAllSettings — kept as no-op for backwards compat
  showNotification('Use "Save All Settings" to save');
}

window.onEmbeddingProviderChange = function() {
  const provider = document.getElementById('embedding-provider')?.value;
  const modelSelect = document.getElementById('embedding-model');
  const apiKeyGroup = document.getElementById('embedding-api-key-group');
  if (!modelSelect) return;

  const options = {
    openai: [['text-embedding-3-small', 'text-embedding-3-small'], ['text-embedding-3-large', 'text-embedding-3-large']],
    voyage: [['voyage-3', 'voyage-3'], ['voyage-3-lite', 'voyage-3-lite']],
    gemini: [['gemini-embedding-001', 'gemini-embedding-001']],
    local: [['nomic-embed-text', 'nomic-embed-text'], ['mxbai-embed-large', 'mxbai-embed-large']],
  };

  modelSelect.innerHTML = (options[provider] || []).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  if (apiKeyGroup) apiKeyGroup.style.display = (provider === 'local' || provider === 'auto') ? 'none' : 'block';
}

window.loadModelSection = async function() {
  const config = await window.verso.getConfig();
  const list = document.getElementById('available-models-list');
  const select = document.getElementById('primary-model-select');
  if (!list || !select) return;

  list.innerHTML = '';
  select.innerHTML = '<option value="">Select a primary model</option>';

  const providers = config.models?.providers || {};
  const currentPrimary = config.agents?.defaults?.model?.primary || '';

  // Collect all models from all providers
  const allModels = [];
  Object.entries(providers).forEach(([name, prov]) => {
    const models = prov.models || [];
    models.forEach(m => {
      const id = typeof m === 'string' ? m : m.id;
      const full = `${name}/${id}`;
      allModels.push(full);
    });
  });

  if (allModels.length === 0) {
    list.innerHTML = '<p style="color:#888;font-size:13px;">No models configured. Add a provider and models first.</p>';
    return;
  }

  // Show all models as options in the primary select
  allModels.forEach(full => {
    const opt = document.createElement('option');
    opt.value = full;
    opt.textContent = full;
    if (currentPrimary === full) opt.selected = true;
    select.appendChild(opt);

    // Also show in the list for reference
    const item = document.createElement('div');
    item.style.cssText = 'padding:8px 12px;background:#1a1a1a;border-radius:6px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;';
    item.innerHTML = `<span style="font-size:13px;">${escapeHtml(full)}</span>${currentPrimary === full ? '<span style="color:#4caf50;font-size:11px;font-weight:600;">Primary</span>' : ''}`;
    list.appendChild(item);
  });
}

window.saveModelSelection = async function() {
  const primary = document.getElementById('primary-model-select').value;
  if (!primary) { showNotification('Select a primary model', 'error'); return; }

  const config = await window.verso.getConfig();
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.model) config.agents.defaults.model = {};
  config.agents.defaults.model.primary = primary;

  await window.verso.saveConfig(config);
  applyConfigToGateway(config);

  showNotification('Primary model saved: ' + primary);
  loadModelSection();
}

// ==================== GATEWAY LOG ====================

window.verso.onGatewayLog((data) => {
  console.log('Gateway:', data);
});

// ==================== AUTO REFRESH ====================

let refreshInterval = null;

function startAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(() => {
    // Skip refresh when window is hidden/minimized
    if (document.hidden) return;
    const activeNav = document.querySelector('.nav-item.active');
    if (!activeNav) return;
    const section = activeNav.dataset.section;
    if (['overview', 'sessions', 'channels', 'cron', 'orchestration', 'instances', 'usage'].includes(section)) {
      loadSection(section);
    }
  }, 30000); // 30s instead of 10s — reduces API load and DOM churn
}

// ==================== INIT ====================

window.addEventListener('DOMContentLoaded', async () => {
  startAutoRefresh();
  // Load initial config for settings
  const config = await window.verso.getConfig();
  loadConfig(config);
});
