/**
 * Browser IIFE entry — sets window.ProviderUtils.
 * Source of truth: provider-utils.js (ESM, tested via vitest).
 * Keep in sync — run `pnpm test:shared` to verify.
 */
/* eslint-disable no-var */
window.ProviderUtils = (function () {
  var API_TYPE_MAP = {
    'openai': 'openai-completions',
    'anthropic': 'anthropic-messages',
    'google': 'google-generative-ai',
  };

  var VALID_APIS = [
    'openai-completions', 'openai-responses', 'anthropic-messages',
    'google-generative-ai', 'github-copilot', 'bedrock-converse-stream',
    'completions', 'openai-legacy-completions',
  ];

  function resolveApi(provider) {
    var apiType = provider.apiType || provider.api || 'openai';
    if (VALID_APIS.indexOf(apiType) !== -1) return apiType;
    return API_TYPE_MAP[apiType] || 'openai-completions';
  }

  function convertModel(m) {
    if (typeof m === 'string') return { id: m, name: m };
    var model = { id: m.id, name: m.name || m.id };
    if (m.api) model.api = m.api;
    if (m.reasoning !== undefined) model.reasoning = m.reasoning;
    if (m.input) model.input = m.input;
    if (m.cost) model.cost = m.cost;
    if (m.contextWindow) model.contextWindow = m.contextWindow;
    if (m.maxTokens) model.maxTokens = m.maxTokens;
    if (m.headers) model.headers = m.headers;
    if (m.compat) model.compat = m.compat;
    return model;
  }

  function toGatewayProvider(provider) {
    var out = {};
    out.baseUrl = provider.baseUrl || '';
    if (provider.apiKey) out.apiKey = provider.apiKey;
    if (provider.auth) out.auth = provider.auth;
    if (provider.headers) out.headers = provider.headers;
    if (provider.authHeader !== undefined) out.authHeader = provider.authHeader;
    out.api = resolveApi(provider);
    out.models = (provider.models || []).map(convertModel);
    return out;
  }

  function inferProviderType(name, provider) {
    var api = provider.api || '';
    var url = (provider.baseUrl || '').toLowerCase();
    var n = name.toLowerCase();
    if (api.indexOf('anthropic') === 0 || url.indexOf('anthropic.com') !== -1) return 'anthropic';
    if (url.indexOf('minimax') !== -1) return 'minimax';
    if (api.indexOf('google') === 0 || url.indexOf('googleapis.com') !== -1 || url.indexOf('generativelanguage') !== -1) return 'google';
    if (url.indexOf('openai.com') !== -1) return 'openai';
    if (n.indexOf('anthropic') !== -1) return 'anthropic';
    if (n.indexOf('openai') !== -1) return 'openai';
    if (n.indexOf('google') !== -1 || n.indexOf('gemini') !== -1) return 'google';
    if (n.indexOf('minimax') !== -1) return 'minimax';
    return 'custom';
  }

  return {
    API_TYPE_MAP: API_TYPE_MAP,
    VALID_APIS: VALID_APIS,
    resolveApi: resolveApi,
    convertModel: convertModel,
    toGatewayProvider: toGatewayProvider,
    inferProviderType: inferProviderType,
  };
})();
