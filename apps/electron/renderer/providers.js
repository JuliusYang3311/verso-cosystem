// Providers management logic
let providers = {};
window.providers = providers; // expose for unified save
let currentProviderForModels = null;

// Load providers on startup
window.addEventListener('DOMContentLoaded', async () => {
  await loadProviders();
  renderProviders();
});

async function loadProviders() {
  const config = await window.verso.getConfig();
  const raw = config.models?.providers || {};

  // Enrich loaded providers with inferred _providerType if missing
  for (const [name, prov] of Object.entries(raw)) {
    if (!prov._providerType) {
      prov._providerType = inferProviderType(name, prov);
    }
  }
  providers = raw;
  window.providers = providers;
}

function inferProviderType(name, provider) {
  const api = provider.api || '';
  const url = (provider.baseUrl || '').toLowerCase();
  const n = name.toLowerCase();

  if (api.startsWith('anthropic') || url.includes('anthropic.com')) return 'anthropic';
  if (url.includes('minimax')) return 'minimax';
  if (api.startsWith('google') || url.includes('googleapis.com') || url.includes('generativelanguage')) return 'google';
  if (url.includes('openai.com')) return 'openai';
  if (n.includes('anthropic')) return 'anthropic';
  if (n.includes('openai')) return 'openai';
  if (n.includes('google') || n.includes('gemini')) return 'google';
  if (n.includes('minimax')) return 'minimax';
  return 'custom';
}

// Provider Selection Modal
function showProviderSelectionModal() {
  const modal = document.getElementById('provider-modal');
  const modalContent = modal.querySelector('.modal-content');

  // Reset modal content to provider selection
  modalContent.innerHTML = `
    <div class="modal-header">
      <div class="modal-title">Select Provider Type</div>
      <button class="modal-close" onclick="closeProviderModal()">×</button>
    </div>
    <div id="provider-options"></div>
  `;

  const optionsContainer = document.getElementById('provider-options');
  optionsContainer.innerHTML = '';

  Object.entries(window.AUTH_GROUPS).forEach(([key, group]) => {
    const option = document.createElement('div');
    option.className = 'provider-option';
    option.onclick = () => selectProviderType(key, group);

    option.innerHTML = `
      <div class="provider-option-label">${group.label}</div>
      <div class="provider-option-hint">${group.hint}</div>
    `;

    optionsContainer.appendChild(option);
  });

  modal.classList.add('active');
}

function closeProviderModal() {
  document.getElementById('provider-modal').classList.remove('active');
}

// Store the selected provider type temporarily
let pendingProviderType = null;

function selectProviderType(key, group) {
  closeProviderModal();

  // Check if this provider has multiple auth methods
  if (group.methods && group.methods.length > 0) {
    // Show auth method selection
    showAuthMethodSelection(key, group);
  } else if (key.includes('custom')) {
    // For custom providers without methods, ask for a name
    pendingProviderType = { key, group, authMethod: null };
    showProviderNameInput(group.label);
  } else {
    // For providers without auth methods, create directly
    createProvider(key, group, null, key);
  }
}

function showAuthMethodSelection(providerKey, group) {
  const modal = document.getElementById('provider-modal');
  const modalContent = modal.querySelector('.modal-content');

  let methodsHtml = '';
  group.methods.forEach(method => {
    methodsHtml += `
      <div class="provider-option" onclick="selectAuthMethod('${providerKey}', '${method.value}', ${JSON.stringify(group).replace(/"/g, '&quot;')})">
        <div class="provider-option-label">${method.label}</div>
        ${method.hint ? `<div class="provider-option-hint">${method.hint}</div>` : ''}
      </div>
    `;
  });

  modalContent.innerHTML = `
    <div class="modal-header">
      <div class="modal-title">Select ${group.label} Auth Method</div>
      <button class="modal-close" onclick="closeProviderModal()">×</button>
    </div>
    <div id="auth-method-options">
      ${methodsHtml}
    </div>
  `;

  modal.classList.add('active');
}

function selectAuthMethod(providerKey, authMethod, group) {
  closeProviderModal();

  // For custom providers, ask for a name
  if (providerKey.includes('custom')) {
    pendingProviderType = { key: providerKey, group, authMethod };
    showProviderNameInput(group.label);
  } else {
    // For official providers, derive a clean name without double prefix
    // e.g. providerKey="openai", authMethod="openai-api-key" → "openai-api-key" (not "openai-openai-api-key")
    const suffix = authMethod.startsWith(providerKey + '-') ? authMethod : `${providerKey}-${authMethod}`;
    createProvider(providerKey, group, authMethod, suffix);
  }
}

function createProvider(providerKey, group, authMethod, name) {
  if (providers[name]) {
    alert(`${group.label} provider already exists`);
    return;
  }

  // Determine apiType based on provider key
  let apiType = 'openai';
  if (providerKey.includes('anthropic')) {
    apiType = 'anthropic';
  } else if (providerKey.includes('google') || providerKey === 'google') {
    apiType = 'google';
  }

  // Set default baseUrl for known providers
  const defaultBaseUrls = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com',
    google: 'https://generativelanguage.googleapis.com',
    minimax: 'https://api.minimax.io/anthropic',
  };

  const providerData = {
    baseUrl: defaultBaseUrls[providerKey] || '',
    apiType: apiType,
    apiKey: '',
    models: [],
    // UI-only metadata (stripped before saving to gateway config)
    _providerType: providerKey,
    _authMethod: authMethod
  };

  // Set auth type for OAuth-based methods
  if (authMethod === 'openai-codex') {
    providerData.auth = 'oauth';
    providerData.baseUrl = 'https://api.openai.com/v1';
  } else if (authMethod === 'minimax-portal') {
    providerData.auth = 'oauth';
    providerData.baseUrl = 'https://api.minimax.io/anthropic';
  } else if (authMethod === 'token') {
    providerData.auth = 'token';
  }

  providers[name] = providerData;

  saveProviders().then(() => loadProviders()).then(() => renderProviders()).catch(err => {
    alert('Failed to save provider: ' + err.message);
  });
}

function showProviderNameInput(providerLabel) {
  const modal = document.getElementById('provider-modal');
  const modalContent = modal.querySelector('.modal-content');

  modalContent.innerHTML = `
    <div class="modal-header">
      <div class="modal-title">Name Your Provider</div>
      <button class="modal-close" onclick="cancelProviderNameInput()">×</button>
    </div>
    <div style="margin-bottom: 20px;">
      <label style="display: block; margin-bottom: 8px; color: #e0e0e0;">Provider Name</label>
      <input type="text" id="provider-name-input" placeholder="e.g., My ${providerLabel}" style="width: 100%; padding: 10px; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; color: #e0e0e0; font-size: 14px;">
    </div>
    <div style="display: flex; justify-content: flex-end; gap: 12px;">
      <button class="btn btn-secondary" onclick="cancelProviderNameInput()">Cancel</button>
      <button class="btn" onclick="confirmProviderName()">Create Provider</button>
    </div>
  `;

  modal.classList.add('active');

  // Focus the input and handle Enter key
  setTimeout(() => {
    const input = document.getElementById('provider-name-input');
    input.focus();
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        confirmProviderName();
      }
    });
  }, 100);
}

function cancelProviderNameInput() {
  pendingProviderType = null;
  closeProviderModal();
}

function confirmProviderName() {
  const input = document.getElementById('provider-name-input');
  const name = input.value.trim();

  if (!name) {
    alert('Please enter a provider name');
    return;
  }

  if (providers[name]) {
    alert('Provider already exists');
    return;
  }

  const { key, group, authMethod } = pendingProviderType;

  // Determine apiType based on provider key
  let apiType = 'openai';
  if (key.includes('anthropic')) {
    apiType = 'anthropic';
  } else if (key.includes('google') || key === 'google') {
    apiType = 'google';
  }

  providers[name] = {
    baseUrl: '',
    apiType: apiType,
    apiKey: '',
    models: [],
    _providerType: key,
    _authMethod: authMethod
  };

  closeProviderModal();
  pendingProviderType = null;

  saveProviders().then(() => loadProviders()).then(() => renderProviders()).catch(err => {
    alert('Failed to save provider: ' + err.message);
  });
}

// Model Selection Modal
function showModelSelectionModal(providerName) {
  currentProviderForModels = providerName;
  const modal = document.getElementById('model-modal');
  const optionsContainer = document.getElementById('model-options');

  optionsContainer.innerHTML = '';

  const provider = providers[providerName];
  const providerType = provider._providerType || providerName;

  // Map provider type to MODEL_CATALOG key
  let catalogKey = providerType;
  if (providerType === 'custom-anthropic') {
    catalogKey = 'anthropic';
  } else if (providerType === 'custom-openai') {
    catalogKey = 'openai';
  }

  const models = window.MODEL_CATALOG[catalogKey] || [];

  if (models.length === 0) {
    optionsContainer.innerHTML = '<p style="color: #999;">No models available for this provider type. You can add custom model IDs manually.</p>';
  } else {
    models.forEach(model => {
      const item = document.createElement('div');
      item.className = 'model-checkbox-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `model-${model.id}`;
      checkbox.value = model.id;

      const label = document.createElement('label');
      label.className = 'model-checkbox-label';
      label.htmlFor = `model-${model.id}`;
      label.textContent = model.name;

      const info = document.createElement('span');
      info.className = 'model-checkbox-info';
      info.textContent = `${model.ctx}${model.reasoning ? ' • Reasoning' : ''}`;

      item.appendChild(checkbox);
      item.appendChild(label);
      item.appendChild(info);

      optionsContainer.appendChild(item);
    });
  }

  modal.classList.add('active');
}

function closeModelModal() {
  document.getElementById('model-modal').classList.remove('active');
  currentProviderForModels = null;
}

async function confirmModelSelection() {
  if (!currentProviderForModels) return;

  const checkboxes = document.querySelectorAll('#model-options input[type="checkbox"]:checked');
  const selectedModels = Array.from(checkboxes).map(cb => cb.value);

  if (selectedModels.length === 0) {
    alert('Please select at least one model');
    return;
  }

  const provider = providers[currentProviderForModels];
  if (!provider.models) {
    provider.models = [];
  }

  // Add selected models
  selectedModels.forEach(modelId => {
    if (!provider.models.some(m => (typeof m === 'string' ? m : m.id) === modelId)) {
      provider.models.push({
        id: modelId,
        name: modelId
      });
    }
  });

  await saveProviders();
  renderProviders();
  closeModelModal();
}

function renderProviders() {
  const container = document.getElementById('providers-container');

  if (!container) {
    console.error('providers-container element not found!');
    return;
  }

  container.innerHTML = '';

  if (Object.keys(providers).length === 0) {
    container.innerHTML = '<p style="color: #999;">No providers configured yet. Click "+ Add Provider" to get started.</p>';
    return;
  }

  Object.entries(providers).forEach(([name, provider]) => {
    const card = createProviderCard(name, provider);
    container.appendChild(card);
  });
}

function createProviderCard(name, provider) {
  const card = document.createElement('div');
  card.className = 'provider-card';
  card.id = `provider-${name}`;

  const models = provider.models || [];
  const modelsHtml = models.map(model => {
    const modelId = typeof model === 'string' ? model : model.id;
    const isPrimary = typeof model === 'object' && model._primary;
    return `
    <div class="model-item">
      <span>${modelId}${isPrimary ? ' <span style="color: #4caf50; font-weight: 600;">(Primary)</span>' : ''}</span>
      <div>
        ${!isPrimary ? `<button class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px; margin-right: 8px;" onclick="setPrimaryModel('${name}', '${modelId}')">Set Primary</button>` : ''}
        <button class="btn btn-danger" style="padding: 6px 12px; font-size: 12px;" onclick="removeModel('${name}', '${modelId}')">Remove</button>
      </div>
    </div>
  `;
  }).join('');

  // Determine auth fields based on authMethod
  const authMethod = provider._authMethod || '';
  let authFieldsHtml = '';

  if (authMethod === 'openai-codex') {
    // OAuth-based auth - show login button
    authFieldsHtml = `
      <div class="form-group">
        <label>Authentication</label>
        <button class="btn" onclick="loginOAuth('${name}', 'openai-codex')">Login with ChatGPT OAuth</button>
        <p style="color: #999; font-size: 12px; margin-top: 8px;">Status: ${provider.oauthToken ? 'Logged in' : 'Not logged in'}</p>
      </div>
    `;
  } else if (authMethod === 'token' && provider._providerType === 'anthropic') {
    // Anthropic setup-token
    authFieldsHtml = `
      <div class="form-group">
        <label>Setup Token</label>
        <input type="password" id="apiKey-${name}" value="${provider.apiKey || ''}" placeholder="Paste token from 'claude setup-token'" onchange="updateProvider('${name}')">
        <p style="color: #999; font-size: 12px; margin-top: 4px;">Run 'claude setup-token' elsewhere, then paste the token here</p>
      </div>
    `;
  } else if (authMethod.includes('oauth') || authMethod.includes('portal')) {
    // Generic OAuth methods
    authFieldsHtml = `
      <div class="form-group">
        <label>Authentication</label>
        <button class="btn" onclick="loginOAuth('${name}', '${authMethod}')">Login with OAuth</button>
        <p style="color: #999; font-size: 12px; margin-top: 8px;">Status: ${provider.oauthToken ? 'Logged in' : 'Not logged in'}</p>
      </div>
    `;
  } else {
    // Default: API Key
    authFieldsHtml = `
      <div class="form-group">
        <label>API Key</label>
        <input type="password" id="apiKey-${name}" value="${provider.apiKey || ''}" onchange="updateProvider('${name}')">
      </div>
    `;
  }

  // Detect current api type for display
  const currentApi = provider.api || provider.apiType || 'openai';
  const apiTypeForSelect = currentApi.startsWith('openai') ? 'openai'
    : currentApi.startsWith('anthropic') ? 'anthropic'
    : currentApi.startsWith('google') ? 'google'
    : provider.apiType || 'openai';

  // Always show Base URL
  const baseUrlHtml = `
    <div class="form-group">
      <label>Base URL</label>
      <input type="text" id="baseUrl-${name}" value="${provider.baseUrl || ''}" placeholder="e.g., https://api.example.com/v1" onchange="updateProvider('${name}')">
    </div>
  `;

  // Only custom providers can change API protocol; others have it fixed
  const isCustomProvider = provider._providerType === 'custom' || provider._providerType?.includes('custom');
  const apiTypeHtml = isCustomProvider ? `
    <div class="form-group">
      <label>API Protocol</label>
      <select id="apiType-${name}" onchange="updateProvider('${name}')">
        <option value="openai" ${apiTypeForSelect === 'openai' ? 'selected' : ''}>OpenAI Compatible</option>
        <option value="anthropic" ${apiTypeForSelect === 'anthropic' ? 'selected' : ''}>Anthropic Compatible</option>
        <option value="google" ${apiTypeForSelect === 'google' ? 'selected' : ''}>Google Compatible</option>
      </select>
    </div>
  ` : '';

  card.innerHTML = `
    <div class="provider-header">
      <div class="provider-name">${name}</div>
      <button class="btn btn-danger" onclick="removeProvider('${name}')">Delete Provider</button>
    </div>

    <div class="form-group">
      <label>Provider Type</label>
      <input type="text" value="${provider._providerType || 'unknown'}" disabled style="background: #1a1a1a; color: #999;">
    </div>

    <div class="form-group">
      <label>Auth Method</label>
      <input type="text" value="${authMethod || 'api-key'}" disabled style="background: #1a1a1a; color: #999;">
    </div>

    ${baseUrlHtml}
    ${apiTypeHtml}

    ${authFieldsHtml}

    <div class="form-group">
      <label>Models</label>
      <div class="models-list">
        ${modelsHtml}
      </div>
      <button class="btn" onclick="showModelSelectionModal('${name}')" style="margin-top: 8px;">Add Models from Catalog</button>
      <input type="text" id="newModel-${name}" placeholder="Or enter custom model ID" style="margin-top: 8px;">
      <button class="btn btn-secondary" onclick="addCustomModel('${name}')" style="margin-top: 8px;">Add Custom Model</button>
    </div>
  `;

  return card;
}

async function updateProvider(name) {
  const baseUrlEl = document.getElementById(`baseUrl-${name}`);
  const apiTypeEl = document.getElementById(`apiType-${name}`);
  const apiKeyEl = document.getElementById(`apiKey-${name}`);

  const updates = {};
  if (baseUrlEl) updates.baseUrl = baseUrlEl.value;
  if (apiTypeEl) updates.apiType = apiTypeEl.value;
  if (apiKeyEl) updates.apiKey = apiKeyEl.value;

  providers[name] = {
    ...providers[name],
    ...updates
  };

  await saveProviders();
}

async function addCustomModel(providerName) {
  const input = document.getElementById(`newModel-${providerName}`);
  const modelId = input.value.trim();

  if (!modelId) {
    alert('Please enter a model ID');
    return;
  }

  if (!providers[providerName].models) {
    providers[providerName].models = [];
  }

  if (providers[providerName].models.some(m => (typeof m === 'string' ? m : m.id) === modelId)) {
    alert('Model already exists');
    return;
  }

  providers[providerName].models.push({
    id: modelId,
    name: modelId
  });
  input.value = '';

  await saveProviders();
  renderProviders();
}

async function removeModel(providerName, modelId) {
  if (!confirm(`Remove model ${modelId}?`)) {
    return;
  }

  providers[providerName].models = providers[providerName].models.filter(m => {
    const id = typeof m === 'string' ? m : m.id;
    return id !== modelId;
  });

  // If we removed the primary model, set the first remaining model as primary (UI-only)
  if (providers[providerName].models.length > 0) {
    const hasPrimary = providers[providerName].models.some(m => typeof m === 'object' && m._primary);
    if (!hasPrimary) {
      if (typeof providers[providerName].models[0] === 'string') {
        providers[providerName].models[0] = { id: providers[providerName].models[0], name: providers[providerName].models[0], _primary: true };
      } else {
        providers[providerName].models[0]._primary = true;
      }
    }
  }

  await saveProviders();
  renderProviders();
}

async function removeProvider(name) {
  if (!confirm(`Delete provider ${name}?`)) {
    return;
  }

  delete providers[name];

  await saveProviders();
  renderProviders();
}

function addNewProvider() {
  const name = prompt('Enter provider name:');
  if (!name || !name.trim()) {
    return;
  }

  const providerName = name.trim();

  if (providers[providerName]) {
    alert('Provider already exists');
    return;
  }

  providers[providerName] = {
    baseUrl: '',
    apiType: 'openai',
    apiKey: '',
    models: [],
    _providerType: 'custom',
    _authMethod: 'api-key'
  };

  renderProviders();
}

async function setPrimaryModel(providerName, modelId) {
  // Mark primary in local UI state (for display only)
  providers[providerName].models = providers[providerName].models.map(m => {
    const id = typeof m === 'string' ? m : m.id;
    return { id, name: (typeof m === 'object' ? m.name : null) || id, _primary: (id === modelId) };
  });

  // Update agents.defaults.model.primary in config
  const modelRef = `${providerName}/${modelId}`;
  await window.verso.saveConfig({
    agents: { defaults: { model: { primary: modelRef } } }
  });

  // Save providers in gateway-compatible format
  await saveProviders();

  // Apply via gateway RPC (non-blocking)
  const latestConfig = await window.verso.getConfig();
  if (typeof window.applyConfigToGateway === 'function') {
    window.applyConfigToGateway(latestConfig);
  }

  showNotification('Primary model set to ' + modelRef);
  renderProviders();
  if (window.loadModelSection) window.loadModelSection();
}

// Convert UI provider format to gateway-compatible format
// Gateway uses strict schemas — only recognized fields are allowed.
// Provider: baseUrl (required), apiKey, auth, api, headers, authHeader, models (required)
// Model: id (required), name (required), api, reasoning, input, cost, contextWindow, maxTokens, headers, compat
window.toGatewayProvider = toGatewayProvider;
function toGatewayProvider(provider) {
  const out = {};

  // baseUrl is required by ModelProviderSchema
  out.baseUrl = provider.baseUrl || '';
  if (provider.apiKey) out.apiKey = provider.apiKey;
  if (provider.auth) out.auth = provider.auth;
  if (provider.headers) out.headers = provider.headers;
  if (provider.authHeader !== undefined) out.authHeader = provider.authHeader;

  // Map UI apiType to gateway's 'api' field
  const apiTypeMap = {
    'openai': 'openai-completions',
    'anthropic': 'anthropic-messages',
    'google': 'google-generative-ai',
  };
  const apiType = provider.apiType || provider.api || 'openai';
  // If already a valid gateway api value, use as-is; otherwise map from UI type
  const validApis = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'github-copilot', 'bedrock-converse-stream', 'completions', 'openai-legacy-completions'];
  out.api = validApis.includes(apiType) ? apiType : (apiTypeMap[apiType] || 'openai-completions');

  // Convert models: only include fields recognized by ModelDefinitionSchema (strict)
  out.models = (provider.models || []).map(m => {
    if (typeof m === 'string') return { id: m, name: m };
    const model = { id: m.id, name: m.name || m.id };
    if (m.api) model.api = m.api;
    if (m.reasoning !== undefined) model.reasoning = m.reasoning;
    if (m.input) model.input = m.input;
    if (m.cost) model.cost = m.cost;
    if (m.contextWindow) model.contextWindow = m.contextWindow;
    if (m.maxTokens) model.maxTokens = m.maxTokens;
    if (m.headers) model.headers = m.headers;
    if (m.compat) model.compat = m.compat;
    return model;
  });

  return out;
}

async function saveProviders() {
  const config = await window.verso.getConfig();
  if (!config.models) config.models = {};

  // Save gateway-compatible format (without UI-only fields like providerType, authMethod, primary)
  const gatewayProviders = {};
  for (const [name, provider] of Object.entries(providers)) {
    gatewayProviders[name] = toGatewayProvider(provider);
  }
  config.models.providers = gatewayProviders;
  await window.verso.saveConfig(config);

  // Non-blocking gateway update (don't hang UI if gateway is down)
  if (typeof window.applyConfigToGateway === 'function') {
    window.applyConfigToGateway(config);
  } else {
    // Fallback with inline timeout
    Promise.race([
      window.gatewayClient.setGatewayConfig({ raw: JSON.stringify(config, null, 2) }),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 3000))
    ]).catch(() => {});
  }
}

// OAuth login placeholder
