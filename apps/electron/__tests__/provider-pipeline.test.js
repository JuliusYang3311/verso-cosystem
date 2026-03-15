/**
 * Electron app — provider pipeline integration tests.
 *
 * Tests the full chain: UI config → toGatewayProvider → saveProviders → loadProviders → round-trip.
 * Uses shared lib functions (same code loaded via <script> in the renderer).
 */
import { describe, it, expect, vi } from 'vitest';
import { toGatewayProvider, inferProviderType } from '../../shared/js/lib/provider-utils.js';
import { deepMerge } from '../../shared/js/lib/deep-merge.js';

// ── Full pipeline: UI → gateway → config file → reload ──────────────

describe('provider pipeline: UI → gateway format', () => {
  it('anthropic custom provider saves correct api field', () => {
    const uiProvider = {
      baseUrl: 'http://47.253.7.24:3000/',
      apiType: 'anthropic',
      apiKey: 'sk-xxx',
      models: [{ id: 'claude-opus-4-6', name: 'claude-opus-4-6', input: ['text', 'image'] }],
      _providerType: 'custom',
      _authMethod: 'api-key',
    };

    const gateway = toGatewayProvider(uiProvider);
    expect(gateway.api).toBe('anthropic-messages');
    expect(gateway.baseUrl).toBe('http://47.253.7.24:3000/');
    expect(gateway.apiKey).toBe('sk-xxx');
    expect(gateway.models[0].input).toEqual(['text', 'image']);
    // UI-only fields stripped
    expect(gateway._providerType).toBeUndefined();
    expect(gateway._authMethod).toBeUndefined();
    expect(gateway.apiType).toBeUndefined();
  });

  it('google custom provider saves correct api field', () => {
    const gateway = toGatewayProvider({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiType: 'google',
      apiKey: 'AIza-xxx',
      models: [{ id: 'gemini-2.0-flash', name: 'Gemini Flash' }],
    });
    expect(gateway.api).toBe('google-generative-ai');
  });

  it('openai is the default when no apiType', () => {
    const gateway = toGatewayProvider({ baseUrl: 'http://localhost:8080', models: [] });
    expect(gateway.api).toBe('openai-responses');
  });

  it('preserves model input types through pipeline', () => {
    const gateway = toGatewayProvider({
      baseUrl: 'http://x',
      apiType: 'anthropic',
      models: [{ id: 'c', name: 'C', input: ['text', 'image'] }],
    });
    expect(gateway.models[0].input).toEqual(['text', 'image']);
  });

  it('preserves reasoning flag', () => {
    const gateway = toGatewayProvider({
      baseUrl: 'http://x',
      models: [{ id: 'o1', name: 'o1', reasoning: true }],
    });
    expect(gateway.models[0].reasoning).toBe(true);
  });

  it('preserves cost and context fields', () => {
    const cost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
    const gateway = toGatewayProvider({
      baseUrl: 'http://x',
      models: [{ id: 'x', name: 'x', cost, contextWindow: 200000, maxTokens: 8192 }],
    });
    expect(gateway.models[0].cost).toEqual(cost);
    expect(gateway.models[0].contextWindow).toBe(200000);
    expect(gateway.models[0].maxTokens).toBe(8192);
  });
});

// ── Save → load round-trip simulation ────────────────────────────────

describe('provider save/load round-trip', () => {
  let configStore;
  let metaStore;

  // Simulate the verso IPC layer
  function createMockVerso() {
    configStore = { models: { providers: {} }, agents: { defaults: { model: {} } } };
    metaStore = {};
    return {
      getConfig: vi.fn(async () => JSON.parse(JSON.stringify(configStore))),
      saveConfig: vi.fn(async (patch) => {
        if (patch._replaceKeys) {
          configStore = deepMerge(configStore, patch, patch._replaceKeys);
          delete configStore._replaceKeys;
        } else {
          configStore = deepMerge(configStore, patch);
        }
      }),
      loadProviderMeta: vi.fn(async () => JSON.parse(JSON.stringify(metaStore))),
      saveProviderMeta: vi.fn(async (meta) => { metaStore = meta; }),
    };
  }

  // Simulate saveProviders() from providers.js
  async function saveProviders(providers, verso) {
    const config = await verso.getConfig();
    if (!config.models) config.models = {};
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
    await verso.saveConfig(config);
    await verso.saveProviderMeta(providerMeta);
  }

  // Simulate loadProviders() from providers.js
  async function loadProviders(verso) {
    const config = await verso.getConfig();
    const raw = config.models?.providers || {};
    const meta = await verso.loadProviderMeta();
    for (const [name, prov] of Object.entries(raw)) {
      const m = meta[name] || {};
      prov._providerType = m.providerType || inferProviderType(name, prov);
      prov._authMethod = m.authMethod || '';
    }
    return raw;
  }

  it('anthropic provider survives save → load round-trip', async () => {
    const verso = createMockVerso();
    const uiProviders = {
      'newapi': {
        baseUrl: 'http://47.253.7.24:3000/',
        apiType: 'anthropic',
        apiKey: 'sk-xxx',
        models: [{ id: 'claude-opus-4-6', name: 'claude-opus-4-6', input: ['text', 'image'] }],
        _providerType: 'custom',
        _authMethod: 'api-key',
      },
    };

    await saveProviders(uiProviders, verso);
    const loaded = await loadProviders(verso);

    expect(loaded.newapi.api).toBe('anthropic-messages');
    expect(loaded.newapi.baseUrl).toBe('http://47.253.7.24:3000/');
    expect(loaded.newapi.apiKey).toBe('sk-xxx');
    expect(loaded.newapi.models[0].input).toEqual(['text', 'image']);
    expect(loaded.newapi._providerType).toBe('custom');
    expect(loaded.newapi._authMethod).toBe('api-key');
  });

  it('multiple providers saved and loaded independently', async () => {
    const verso = createMockVerso();
    const uiProviders = {
      'anthropic-proxy': {
        baseUrl: 'https://api.anthropic.com/v1',
        apiType: 'anthropic',
        apiKey: 'sk-ant-xxx',
        models: [{ id: 'claude-3.5-sonnet', name: 'Sonnet' }],
        _providerType: 'anthropic',
        _authMethod: 'api-key',
      },
      'openai-main': {
        baseUrl: 'https://api.openai.com/v1',
        apiType: 'openai',
        apiKey: 'sk-oai-xxx',
        models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
        _providerType: 'openai',
        _authMethod: 'api-key',
      },
    };

    await saveProviders(uiProviders, verso);
    const loaded = await loadProviders(verso);

    expect(loaded['anthropic-proxy'].api).toBe('anthropic-messages');
    expect(loaded['openai-main'].api).toBe('openai-responses');
    expect(Object.keys(loaded)).toHaveLength(2);
  });

  it('re-saving does not corrupt other config sections', async () => {
    const verso = createMockVerso();
    // Pre-populate some unrelated config
    configStore.someOtherKey = 'should-persist';
    configStore.agents = { defaults: { model: { primary: 'x/y' } }, behavior: 'keep-me' };

    await saveProviders({
      'test': { baseUrl: 'http://x', models: [], _providerType: 'custom', _authMethod: '' },
    }, verso);

    expect(configStore.someOtherKey).toBe('should-persist');
    expect(configStore.agents.behavior).toBe('keep-me');
  });

  it('api field round-trips correctly (no apiType after save)', async () => {
    const verso = createMockVerso();
    await saveProviders({
      'my-provider': {
        baseUrl: 'http://x',
        apiType: 'anthropic',
        models: [{ id: 'm', name: 'm' }],
        _providerType: 'custom',
        _authMethod: '',
      },
    }, verso);

    // After save, config has api (not apiType)
    const raw = configStore.models.providers['my-provider'];
    expect(raw.api).toBe('anthropic-messages');
    expect(raw.apiType).toBeUndefined();

    // Re-saving from loaded state preserves api
    const loaded = await loadProviders(verso);
    await saveProviders(loaded, verso);
    const raw2 = configStore.models.providers['my-provider'];
    expect(raw2.api).toBe('anthropic-messages');
  });

  // ── E2E: custom model → save → set primary → save → load ──────────

  it('custom model with reasoning+input survives add → save → setPrimary → save → load', async () => {
    const verso = createMockVerso();

    // Step 1: Simulate confirmCustomModel — build model exactly like providers.js does
    let providers = {
      'newapi': {
        baseUrl: 'https://code.z-daha.cc/',
        apiType: 'anthropic',
        apiKey: 'sk-xxx',
        models: [],
        _providerType: 'custom',
        _authMethod: 'api-key',
      },
    };

    // This mirrors confirmCustomModel() logic exactly
    const modelId = 'claude-sonnet-4-6';
    const ctxVal = 200000;
    const maxVal = 8192;
    const reasoning = true;  // checkbox checked
    const inputTypes = ['text', 'image'];  // image checkbox checked
    const thinkingLevel = 'high';  // select = high

    const model = { id: modelId, name: modelId };
    if (ctxVal > 0) model.contextWindow = ctxVal;
    if (maxVal > 0) model.maxTokens = maxVal;
    if (reasoning) {
      model.reasoning = true;
      if (thinkingLevel !== 'low') model.thinkingLevel = thinkingLevel;
    }
    model.input = inputTypes;

    providers['newapi'].models.push(model);

    // Step 2: Save (first time — after adding model)
    await saveProviders(providers, verso);

    // Step 3: Load back
    providers = await loadProviders(verso);

    // Verify model fields survived save → load
    const loaded1 = providers['newapi'].models[0];
    expect(loaded1.id).toBe('claude-sonnet-4-6');
    expect(loaded1.reasoning).toBe(true);
    expect(loaded1.input).toEqual(['text', 'image']);
    expect(loaded1.contextWindow).toBe(200000);
    expect(loaded1.maxTokens).toBe(8192);
    expect(loaded1.thinkingLevel).toBe('high');

    // Step 4: Simulate setPrimaryModel — exactly as providers.js does
    for (const [, prov] of Object.entries(providers)) {
      if (!prov.models) continue;
      prov.models = prov.models.map(m => {
        if (typeof m === 'string') m = { id: m, name: m };
        const { _primary, ...rest } = m;
        return rest;
      });
    }
    providers['newapi'].models = providers['newapi'].models.map(m => {
      if (typeof m === 'string') m = { id: m, name: m };
      const { _primary, ...rest } = m;
      return rest.id === modelId ? { ...rest, _primary: true } : rest;
    });

    // Step 5: Save (second time — after setPrimary)
    await saveProviders(providers, verso);

    // Step 6: Load back and verify ALL fields survived
    const final = await loadProviders(verso);
    const finalModel = final['newapi'].models[0];

    expect(finalModel.id).toBe('claude-sonnet-4-6');
    expect(finalModel.reasoning).toBe(true);
    expect(finalModel.input).toEqual(['text', 'image']);
    expect(finalModel.contextWindow).toBe(200000);
    expect(finalModel.maxTokens).toBe(8192);
    expect(finalModel.thinkingLevel).toBe('high');

    // Also verify the raw config store (what the gateway sees)
    const rawModel = configStore.models.providers['newapi'].models[0];
    expect(rawModel.reasoning).toBe(true);
    expect(rawModel.input).toEqual(['text', 'image']);
    expect(rawModel.thinkingLevel).toBe('high');
  });
});

// ── Config merge (deepMerge with replaceKeys) ────────────────────────

describe('config merge with replaceKeys', () => {
  it('replaceKeys prevents deep-merging providers (atomic replace)', () => {
    const base = {
      models: {
        providers: {
          'old-provider': { baseUrl: 'http://old', api: 'openai-completions', models: [] },
        },
      },
      agents: { defaults: { model: { primary: 'old-provider/gpt-4' } } },
    };
    const patch = {
      models: {
        providers: {
          'new-provider': { baseUrl: 'http://new', api: 'anthropic-messages', models: [] },
        },
      },
    };
    const result = deepMerge(base, patch, ['models.providers']);
    // Old provider gone, new provider present
    expect(result.models.providers['old-provider']).toBeUndefined();
    expect(result.models.providers['new-provider'].api).toBe('anthropic-messages');
    // Other config preserved
    expect(result.agents.defaults.model.primary).toBe('old-provider/gpt-4');
  });

  it('without replaceKeys, providers deep-merge (old + new)', () => {
    const base = {
      models: { providers: { old: { baseUrl: 'http://old', models: [] } } },
    };
    const patch = {
      models: { providers: { new: { baseUrl: 'http://new', models: [] } } },
    };
    const result = deepMerge(base, patch);
    expect(result.models.providers.old).toBeDefined();
    expect(result.models.providers.new).toBeDefined();
  });
});

// ── inferProviderType from loaded config ─────────────────────────────

describe('inferProviderType from gateway config', () => {
  it('infers anthropic from api field after save', () => {
    const saved = toGatewayProvider({ baseUrl: 'http://x', apiType: 'anthropic', models: [] });
    expect(inferProviderType('newapi', saved)).toBe('anthropic');
  });

  it('infers google from api field after save', () => {
    const saved = toGatewayProvider({ baseUrl: 'http://x', apiType: 'google', models: [] });
    expect(inferProviderType('myg', saved)).toBe('google');
  });

  it('infers custom for unknown providers', () => {
    const saved = toGatewayProvider({ baseUrl: 'http://47.253.7.24:3000/', models: [] });
    expect(inferProviderType('newapi', saved)).toBe('custom');
  });

  it('meta providerType takes priority (simulated loadProviders)', () => {
    // When meta has providerType, loadProviders uses it
    const meta = { providerType: 'custom', authMethod: 'api-key' };
    const providerType = meta.providerType || inferProviderType('newapi', { api: 'anthropic-messages' });
    expect(providerType).toBe('custom');
  });
});

// ── Catalog model selection with metadata ────────────────────────────

describe('catalog model selection carries metadata', () => {
  // Simulate confirmModelSelection() logic
  function addCatalogModels(provider, selectedIds, catalog) {
    if (!provider.models) provider.models = [];
    selectedIds.forEach(modelId => {
      if (!provider.models.some(m => (typeof m === 'string' ? m : m.id) === modelId)) {
        const entry = catalog.find(c => c.id === modelId);
        const model = { id: modelId, name: entry ? entry.name : modelId };
        if (entry) {
          if (entry.reasoning) model.reasoning = true;
          if (entry.ctx) {
            const m = entry.ctx.match(/^(\d+(?:\.\d+)?)\s*([KMkm])?$/);
            if (m) {
              const n = parseFloat(m[1]);
              const unit = (m[2] || '').toUpperCase();
              model.contextWindow = unit === 'M' ? n * 1000000 : unit === 'K' ? n * 1000 : n;
            }
          }
          if (entry.input) model.input = entry.input;
        }
        provider.models.push(model);
      }
    });
  }

  it('anthropic catalog model gets input, reasoning, contextWindow', () => {
    const catalog = [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: false, ctx: '1M', input: ['text', 'image'] },
      { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', reasoning: true, ctx: '1M', input: ['text', 'image'] },
    ];
    const provider = { models: [] };
    addCatalogModels(provider, ['claude-opus-4-6', 'claude-opus-4-6-thinking'], catalog);

    expect(provider.models).toHaveLength(2);

    const opus = provider.models[0];
    expect(opus.name).toBe('Claude Opus 4.6');
    expect(opus.input).toEqual(['text', 'image']);
    expect(opus.contextWindow).toBe(1000000);
    expect(opus.reasoning).toBeUndefined();

    const thinking = provider.models[1];
    expect(thinking.reasoning).toBe(true);
    expect(thinking.input).toEqual(['text', 'image']);
  });

  it('google catalog model carries video input type', () => {
    const catalog = [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: false, ctx: '2M', input: ['text', 'image', 'audio', 'video'] },
    ];
    const provider = { models: [] };
    addCatalogModels(provider, ['gemini-2.5-pro'], catalog);

    const model = provider.models[0];
    expect(model.input).toEqual(['text', 'image', 'audio', 'video']);
    expect(model.contextWindow).toBe(2000000);
  });

  it('catalog model survives gateway round-trip', () => {
    const catalog = [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: false, ctx: '1M', input: ['text', 'image'] },
    ];
    const provider = { baseUrl: 'http://x', apiType: 'anthropic', models: [] };
    addCatalogModels(provider, ['claude-opus-4-6'], catalog);

    const gateway = toGatewayProvider(provider);
    expect(gateway.models[0].input).toEqual(['text', 'image']);
    expect(gateway.models[0].contextWindow).toBe(1000000);
    expect(gateway.models[0].name).toBe('Claude Opus 4.6');
  });

  it('does not duplicate models already in provider', () => {
    const catalog = [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: false, ctx: '1M', input: ['text', 'image'] },
    ];
    const provider = { models: [{ id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }] };
    addCatalogModels(provider, ['claude-opus-4-6'], catalog);
    expect(provider.models).toHaveLength(1);
  });
});

// ── thinkingLevel pipeline ────────────────────────────────────────────

describe('thinkingLevel through provider pipeline', () => {
  it('convertModel preserves thinkingLevel', () => {
    const { convertModel } = require('../../shared/js/lib/provider-utils.js');
    const model = convertModel({ id: 'x', name: 'X', reasoning: true, thinkingLevel: 'high' });
    expect(model.thinkingLevel).toBe('high');
    expect(model.reasoning).toBe(true);
  });

  it('convertModel omits thinkingLevel when not set', () => {
    const { convertModel } = require('../../shared/js/lib/provider-utils.js');
    const model = convertModel({ id: 'x', name: 'X', reasoning: true });
    expect(model.thinkingLevel).toBeUndefined();
  });

  it('thinkingLevel survives gateway round-trip', () => {
    const gateway = toGatewayProvider({
      baseUrl: 'http://x',
      apiType: 'anthropic',
      models: [{ id: 'c', name: 'C', reasoning: true, thinkingLevel: 'medium' }],
    });
    expect(gateway.models[0].thinkingLevel).toBe('medium');
    expect(gateway.models[0].reasoning).toBe(true);
  });

  it('custom model with default thinkingLevel (low) omits field', () => {
    // Simulates confirmCustomModel: thinkingLevel=low → not saved
    const model = { id: 'custom', name: 'custom', reasoning: true };
    const thinkingLevel = 'low';
    if (thinkingLevel !== 'low') model.thinkingLevel = thinkingLevel;

    const gateway = toGatewayProvider({
      baseUrl: 'http://x',
      models: [model],
    });
    expect(gateway.models[0].reasoning).toBe(true);
    expect(gateway.models[0].thinkingLevel).toBeUndefined();
  });

  it('custom model with non-default thinkingLevel saves it', () => {
    const model = { id: 'custom', name: 'custom', reasoning: true };
    const thinkingLevel = 'high';
    if (thinkingLevel !== 'low') model.thinkingLevel = thinkingLevel;

    const gateway = toGatewayProvider({
      baseUrl: 'http://x',
      models: [model],
    });
    expect(gateway.models[0].thinkingLevel).toBe('high');
  });
});

// ── Primary model selection ──────────────────────────────────────────

describe('primary model selection', () => {
  it('builds correct modelRef', () => {
    const providerName = 'newapi';
    const modelId = 'claude-opus-4-6';
    const modelRef = `${providerName}/${modelId}`;
    expect(modelRef).toBe('newapi/claude-opus-4-6');
  });

  it('builds fallbacks from all other models', () => {
    const providers = {
      'p1': { models: [{ id: 'a' }, { id: 'b' }] },
      'p2': { models: [{ id: 'c' }] },
    };
    const primary = 'p1/a';
    const fallbacks = [];
    for (const [pName, prov] of Object.entries(providers)) {
      for (const m of prov.models) {
        const ref = `${pName}/${m.id}`;
        if (ref !== primary) fallbacks.push(ref);
      }
    }
    expect(fallbacks).toEqual(['p1/b', 'p2/c']);
  });

  // Simulate setPrimaryModel's model mapping (must preserve metadata)
  function setPrimaryModelMap(models, targetId) {
    return models.map(m => {
      if (typeof m === 'string') m = { id: m, name: m };
      const { _primary, ...rest } = m;
      return rest.id === targetId ? { ...rest, _primary: true } : rest;
    });
  }

  it('setPrimaryModel preserves reasoning, input, contextWindow, thinkingLevel', () => {
    const models = [
      { id: 'model-a', name: 'Model A', reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 8192, thinkingLevel: 'high' },
      { id: 'model-b', name: 'Model B', reasoning: false, input: ['text'] },
    ];

    const result = setPrimaryModelMap(models, 'model-a');

    expect(result[0]._primary).toBe(true);
    expect(result[0].reasoning).toBe(true);
    expect(result[0].input).toEqual(['text', 'image']);
    expect(result[0].contextWindow).toBe(200000);
    expect(result[0].maxTokens).toBe(8192);
    expect(result[0].thinkingLevel).toBe('high');

    // Non-primary model also preserves metadata
    expect(result[1]._primary).toBeUndefined();
    expect(result[1].reasoning).toBe(false);
    expect(result[1].input).toEqual(['text']);
  });

  it('setPrimaryModel handles string models', () => {
    const models = ['simple-model', { id: 'rich', name: 'Rich', reasoning: true }];
    const result = setPrimaryModelMap(models, 'simple-model');

    expect(result[0]).toEqual({ id: 'simple-model', name: 'simple-model', _primary: true });
    expect(result[1].reasoning).toBe(true);
    expect(result[1]._primary).toBeUndefined();
  });

  it('setPrimaryModel clears previous _primary without losing metadata', () => {
    const models = [
      { id: 'a', name: 'A', _primary: true, reasoning: true, input: ['text', 'image'] },
      { id: 'b', name: 'B', reasoning: true, contextWindow: 100000 },
    ];
    const result = setPrimaryModelMap(models, 'b');

    expect(result[0]._primary).toBeUndefined();
    expect(result[0].reasoning).toBe(true);
    expect(result[0].input).toEqual(['text', 'image']);

    expect(result[1]._primary).toBe(true);
    expect(result[1].reasoning).toBe(true);
    expect(result[1].contextWindow).toBe(100000);
  });
});
