// Providers management logic
let providers = {};
window.providers = providers; // expose for unified save
let currentProviderForModels = null;

// Load providers on startup
window.addEventListener('DOMContentLoaded', async () => {
  await loadProviders();
  renderProviders();
});

async function loadProviderMeta() {
  try { return await window.verso.loadProviderMeta(); } catch { return {}; }
}

async function saveProviderMeta(meta) {
  try { await window.verso.saveProviderMeta(meta); } catch {}
}

async function loadProviders() {
  const config = await window.verso.getConfig();
  const raw = config.models?.providers || {};
  const meta = await loadProviderMeta();

  // Resolve current primary model from config
  const primaryRef = config.agents?.defaults?.model?.primary || '';

  for (const [name, prov] of Object.entries(raw)) {
    const m = meta[name] || {};
    prov._providerType = m.providerType || inferProviderType(name, prov);
    prov._authMethod = m.authMethod || '';

    // Mark _primary on the model that matches agents.defaults.model.primary
    if (prov.models && primaryRef) {
      prov.models = prov.models.map(model => {
        const mid = typeof model === 'string' ? model : model.id;
        const ref = `${name}/${mid}`;
        if (typeof model === 'string') {
          return ref === primaryRef ? { id: model, name: model, _primary: true } : { id: model, name: model };
        }
        if (ref === primaryRef) model._primary = true;
        else delete model._primary;
        return model;
      });
    }
  }
  providers = raw;
  window.providers = providers;
}

// inferProviderType provided by shared lib (provider-utils.iife.js → window.ProviderUtils)
const inferProviderType = window.ProviderUtils.inferProviderType;


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

  const { key, authMethod } = pendingProviderType;

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
      const inputLabel = (model.input || ['text']).join('+');
      info.textContent = `${model.ctx} • ${inputLabel}${model.reasoning ? ' • Reasoning' : ''}`;

      item.appendChild(checkbox);
      item.appendChild(label);
      item.appendChild(info);

      optionsContainer.appendChild(item);
    });
  }

  // Add action buttons
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  actions.innerHTML = `
    <button class="btn btn-secondary" onclick="closeModelModal()">Cancel</button>
    <button class="btn" onclick="confirmModelSelection()">Add Selected Models</button>
  `;
  optionsContainer.appendChild(actions);

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

  // Look up catalog for metadata
  const providerType = provider._providerType || currentProviderForModels;
  let catalogKey = providerType;
  if (providerType === 'custom-anthropic') catalogKey = 'anthropic';
  else if (providerType === 'custom-openai') catalogKey = 'openai';
  const catalog = window.MODEL_CATALOG[catalogKey] || [];

  // Add selected models with full metadata from catalog
  selectedModels.forEach(modelId => {
    if (!provider.models.some(m => (typeof m === 'string' ? m : m.id) === modelId)) {
      const entry = catalog.find(c => c.id === modelId);
      const model = { id: modelId, name: entry ? entry.name : modelId };
      if (entry) {
        if (entry.reasoning) model.reasoning = true;
        if (entry.ctx) model.contextWindow = window.parseCtx(entry.ctx);
        if (entry.input) model.input = entry.input;
      }
      provider.models.push(model);
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
    const ctx = typeof model === 'object' && model.contextWindow ? model.contextWindow : 0;
    const maxTok = typeof model === 'object' && model.maxTokens ? model.maxTokens : 0;
    const inputTypes = typeof model === 'object' && model.input ? model.input : [];
    const reasoning = typeof model === 'object' && model.reasoning;
    const formatCtx = (n) => n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'K' : n;
    const badges = [];
    if (ctx) badges.push(`${formatCtx(ctx)} ctx`);
    if (maxTok) badges.push(`${formatCtx(maxTok)} out`);
    if (reasoning) badges.push('reasoning');
    if (inputTypes.length > 0 && !(inputTypes.length === 1 && inputTypes[0] === 'text')) badges.push(inputTypes.join('+'));
    const badgesHtml = badges.length > 0 ? `<span style="color: #888; font-size: 12px; margin-left: 8px;">${badges.join(' · ')}</span>` : '';
    return `
    <div class="model-item">
      <span>${modelId}${isPrimary ? ' <span style="color: #4caf50; font-weight: 600;">(Primary)</span>' : ''}${badgesHtml}</span>
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
      <button class="btn btn-secondary" onclick="showCustomModelModal('${name}')" style="margin-top: 8px;">Add Custom Model</button>
    </div>
  `;

  return card;
}

async function updateProvider(name) {
  const baseUrlEl = document.getElementById(`baseUrl-${name}`);
  const apiTypeEl = document.getElementById(`apiType-${name}`);
  const apiKeyEl = document.getElementById(`apiKey-${name}`);

  const existing = providers[name] || {};
  if (baseUrlEl && baseUrlEl.value.trim()) existing.baseUrl = baseUrlEl.value.trim();
  else delete existing.baseUrl;
  if (apiTypeEl && apiTypeEl.value.trim()) existing.apiType = apiTypeEl.value.trim();
  else delete existing.apiType;
  if (apiKeyEl && apiKeyEl.value.trim()) existing.apiKey = apiKeyEl.value.trim();
  else delete existing.apiKey;

  providers[name] = existing;

  await saveProviders();
}

function showCustomModelModal(providerName) {
  const modal = document.getElementById('model-modal');
  const optionsContainer = document.getElementById('model-options');

  optionsContainer.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 16px;">
      <div class="form-group">
        <label>Model ID *</label>
        <input type="text" id="custom-model-id" placeholder="e.g., claude-opus-4-6" style="width: 100%; padding: 10px; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; color: #e0e0e0;">
      </div>
      <div style="display: flex; gap: 12px;">
        <div class="form-group" style="flex: 1;">
          <label>Context Window (tokens)</label>
          <input type="number" id="custom-model-ctx" placeholder="200000" value="200000" style="width: 100%; padding: 10px; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; color: #e0e0e0;">
        </div>
        <div class="form-group" style="flex: 1;">
          <label>Max Output Tokens</label>
          <input type="number" id="custom-model-max" placeholder="8192" value="8192" style="width: 100%; padding: 10px; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; color: #e0e0e0;">
        </div>
      </div>
      <div class="form-group">
        <label>Input Types</label>
        <div style="display: flex; gap: 16px; flex-wrap: wrap;">
          <label style="display: flex; align-items: center; gap: 6px; color: #999;">
            <input type="checkbox" checked disabled> Text (always included)
          </label>
          <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; color: #e0e0e0;">
            <input type="checkbox" id="custom-model-input-image"> Image
          </label>
          <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; color: #e0e0e0;">
            <input type="checkbox" id="custom-model-input-video"> Video
          </label>
        </div>
      </div>
      <div class="form-group">
        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; color: #e0e0e0;">
          <input type="checkbox" id="custom-model-reasoning" onchange="document.getElementById('thinking-level-group').style.display = this.checked ? 'block' : 'none'"> Supports Reasoning / Thinking
        </label>
        <div id="thinking-level-group" style="display: none; margin-top: 8px; margin-left: 24px;">
          <label style="color: #999; font-size: 12px;">Default Thinking Level</label>
          <select id="custom-model-thinking-level" style="width: 100%; padding: 8px; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; color: #e0e0e0; margin-top: 4px;">
            <option value="low">Low (default)</option>
            <option value="minimal">Minimal</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 8px;">
        <button class="btn btn-secondary" onclick="closeModelModal()">Cancel</button>
        <button class="btn" onclick="confirmCustomModel('${providerName}')">Add Model</button>
      </div>
    </div>
  `;

  // Update modal title
  const modalTitle = modal.querySelector('.modal-title');
  if (modalTitle) modalTitle.textContent = 'Add Custom Model';

  modal.classList.add('active');

  setTimeout(() => {
    const idInput = document.getElementById('custom-model-id');
    if (idInput) idInput.focus();
  }, 100);
}

async function confirmCustomModel(providerName) {
  const modelId = (document.getElementById('custom-model-id')?.value || '').trim();
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

  const ctxVal = parseInt(document.getElementById('custom-model-ctx')?.value || '0', 10);
  const maxVal = parseInt(document.getElementById('custom-model-max')?.value || '0', 10);
  const reasoning = document.getElementById('custom-model-reasoning')?.checked || false;

  // "text" is always included; user selects additional modalities
  const inputTypes = ['text'];
  if (document.getElementById('custom-model-input-image')?.checked) inputTypes.push('image');
  if (document.getElementById('custom-model-input-video')?.checked) inputTypes.push('video');

  const model = { id: modelId, name: modelId };
  if (ctxVal > 0) model.contextWindow = ctxVal;
  if (maxVal > 0) model.maxTokens = maxVal;
  if (reasoning) {
    model.reasoning = true;
    const thinkingLevel = document.getElementById('custom-model-thinking-level')?.value || 'low';
    if (thinkingLevel !== 'low') model.thinkingLevel = thinkingLevel;
  }
  model.input = inputTypes;

  providers[providerName].models.push(model);

  await saveProviders();
  renderProviders();
  closeModelModal();
}


async function removeModel(providerName, modelId) {
  if (!confirm(`Remove model ${modelId}?`)) {
    return;
  }

  providers[providerName].models = providers[providerName].models.filter(m => {
    const id = typeof m === 'string' ? m : m.id;
    return id !== modelId;
  });

  // Note: if the primary model was removed, user must explicitly set a new primary

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
  // Clear _primary from ALL models across ALL providers
  for (const [, prov] of Object.entries(providers)) {
    if (!prov.models) continue;
    prov.models = prov.models.map(m => {
      if (typeof m === 'string') return { id: m, name: m };
      const { _primary, ...rest } = m;
      return rest;
    });
  }

  // Set the new primary (preserve all model metadata)
  providers[providerName].models = providers[providerName].models.map(m => {
    if (typeof m === 'string') m = { id: m, name: m };
    const { _primary, ...rest } = m;
    return rest.id === modelId ? { ...rest, _primary: true } : rest;
  });

  // Build primary + fallbacks from all providers
  const modelRef = `${providerName}/${modelId}`;
  const fallbacks = [];
  for (const [pName, prov] of Object.entries(providers)) {
    for (const m of (prov.models || [])) {
      const mid = typeof m === 'string' ? m : m.id;
      const ref = `${pName}/${mid}`;
      if (ref !== modelRef) fallbacks.push(ref);
    }
  }

  // Save providers + update agents.defaults.model in one go
  await saveProviders();

  await window.verso.saveConfig({
    agents: { defaults: { model: { primary: modelRef, fallbacks } } }
  });

  // Apply via gateway RPC (non-blocking)
  const latestConfig = await window.verso.getConfig();
  if (typeof window.applyConfigToGateway === 'function') {
    void window.applyConfigToGateway(latestConfig);
  }

  showNotification('Primary model set to ' + modelRef);
  renderProviders();
  if (window.loadModelSection) window.loadModelSection();
}

// toGatewayProvider provided by shared lib (provider-utils.iife.js → window.ProviderUtils)
const toGatewayProvider = window.ProviderUtils.toGatewayProvider;
window.toGatewayProvider = toGatewayProvider;

async function saveProviders() {
  const config = await window.verso.getConfig();
  if (!config.models) config.models = {};

  // Save gateway-compatible format (without UI-only fields)
  const gatewayProviders = {};
  const providerMeta = {};
  for (const [name, provider] of Object.entries(providers)) {
    gatewayProviders[name] = toGatewayProvider(provider);
    providerMeta[name] = {
      providerType: provider._providerType || '',
      authMethod: provider._authMethod || '',
    };
  }
  config.models.providers = gatewayProviders;
  config._replaceKeys = ['models.providers'];
  await window.verso.saveConfig(config);
  delete config._replaceKeys; // clean before sending to gateway RPC
  void saveProviderMeta(providerMeta);

  // Non-blocking gateway update (don't hang UI if gateway is down)
  if (typeof window.applyConfigToGateway === 'function') {
    void window.applyConfigToGateway(config);
  } else {
    // Fallback with inline timeout
    Promise.race([
      window.gatewayClient.setGatewayConfig({ raw: JSON.stringify(config, null, 2) }),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 3000))
    ]).catch(() => {});
  }
}

// Expose functions used from HTML onclick attributes
window.showProviderSelectionModal = showProviderSelectionModal;
window.selectAuthMethod = selectAuthMethod;
window.cancelProviderNameInput = cancelProviderNameInput;
window.showModelSelectionModal = showModelSelectionModal;
window.confirmModelSelection = confirmModelSelection;
window.updateProvider = updateProvider;
window.addCustomModel = addCustomModel;
window.showCustomModelModal = showCustomModelModal;
window.confirmCustomModel = confirmCustomModel;
window.removeModel = removeModel;
window.removeProvider = removeProvider;
window.addNewProvider = addNewProvider;
window.setPrimaryModel = setPrimaryModel;
window.saveProviders = saveProviders;

// OAuth login placeholder
