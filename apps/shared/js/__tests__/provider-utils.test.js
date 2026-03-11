import { describe, it, expect } from 'vitest';
import { resolveApi, convertModel, toGatewayProvider, inferProviderType } from '../lib/provider-utils.js';

// ── resolveApi ──────────────────────────────────────────────────────

describe('resolveApi', () => {
  describe('UI apiType → gateway api mapping', () => {
    it('openai → openai-completions', () => {
      expect(resolveApi({ apiType: 'openai' })).toBe('openai-completions');
    });
    it('anthropic → anthropic-messages', () => {
      expect(resolveApi({ apiType: 'anthropic' })).toBe('anthropic-messages');
    });
    it('google → google-generative-ai', () => {
      expect(resolveApi({ apiType: 'google' })).toBe('google-generative-ai');
    });
    it('unknown apiType → openai-completions', () => {
      expect(resolveApi({ apiType: 'azure' })).toBe('openai-completions');
    });
  });

  describe('passthrough for valid gateway api values', () => {
    const validApis = [
      'openai-completions', 'openai-responses', 'anthropic-messages',
      'google-generative-ai', 'github-copilot', 'bedrock-converse-stream',
      'completions', 'openai-legacy-completions',
    ];
    validApis.forEach(api => {
      it(`passes through "${api}"`, () => {
        expect(resolveApi({ api })).toBe(api);
      });
    });
  });

  describe('precedence', () => {
    it('apiType takes precedence over api', () => {
      expect(resolveApi({ apiType: 'anthropic', api: 'openai-responses' })).toBe('anthropic-messages');
    });
    it('falls back to api when apiType absent', () => {
      expect(resolveApi({ api: 'anthropic-messages' })).toBe('anthropic-messages');
    });
    it('defaults to openai-completions when empty', () => {
      expect(resolveApi({})).toBe('openai-completions');
    });
  });

  describe('round-trip stability', () => {
    it('save → load → re-save preserves api', () => {
      const saved = resolveApi({ apiType: 'anthropic' });
      expect(saved).toBe('anthropic-messages');
      // After loading from config, only api exists
      const resaved = resolveApi({ api: saved });
      expect(resaved).toBe('anthropic-messages');
    });
  });
});

// ── convertModel ────────────────────────────────────────────────────

describe('convertModel', () => {
  it('converts string to {id, name}', () => {
    expect(convertModel('gpt-4')).toEqual({ id: 'gpt-4', name: 'gpt-4' });
  });

  it('preserves input types', () => {
    expect(convertModel({ id: 'c', name: 'C', input: ['text', 'image'] }).input).toEqual(['text', 'image']);
  });

  it('preserves reasoning=true', () => {
    expect(convertModel({ id: 'o', name: 'o', reasoning: true }).reasoning).toBe(true);
  });

  it('preserves reasoning=false (not stripped)', () => {
    expect(convertModel({ id: 'g', name: 'g', reasoning: false }).reasoning).toBe(false);
  });

  it('preserves contextWindow and maxTokens', () => {
    const r = convertModel({ id: 'x', name: 'x', contextWindow: 200000, maxTokens: 8192 });
    expect(r.contextWindow).toBe(200000);
    expect(r.maxTokens).toBe(8192);
  });

  it('preserves cost object', () => {
    const cost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
    expect(convertModel({ id: 'x', name: 'x', cost }).cost).toEqual(cost);
  });

  it('preserves model-level api override', () => {
    expect(convertModel({ id: 'x', name: 'x', api: 'anthropic-messages' }).api).toBe('anthropic-messages');
  });

  it('strips UI-only fields (_primary, _extra)', () => {
    const r = convertModel({ id: 'x', name: 'x', _primary: true, _extra: 'junk' });
    expect(r._primary).toBeUndefined();
    expect(r._extra).toBeUndefined();
  });

  it('uses id as name fallback', () => {
    expect(convertModel({ id: 'x' }).name).toBe('x');
  });
});

// ── toGatewayProvider ───────────────────────────────────────────────

describe('toGatewayProvider', () => {
  it('maps custom provider with anthropic apiType', () => {
    const r = toGatewayProvider({
      baseUrl: 'http://47.253.7.24:3000/',
      apiType: 'anthropic',
      apiKey: 'sk-xxx',
      models: [{ id: 'claude-opus-4-6', name: 'claude-opus-4-6', input: ['text', 'image'] }],
      _providerType: 'custom',
      _authMethod: 'api-key',
    });
    expect(r.api).toBe('anthropic-messages');
    expect(r.baseUrl).toBe('http://47.253.7.24:3000/');
    expect(r.apiKey).toBe('sk-xxx');
    expect(r.models[0].input).toEqual(['text', 'image']);
    expect(r._providerType).toBeUndefined();
    expect(r._authMethod).toBeUndefined();
    expect(r.apiType).toBeUndefined();
  });

  it('maps openai apiType', () => {
    expect(toGatewayProvider({ baseUrl: 'http://x', apiType: 'openai', models: [] }).api).toBe('openai-completions');
  });

  it('preserves gateway api on round-trip', () => {
    expect(toGatewayProvider({ baseUrl: 'http://x', api: 'anthropic-messages', models: [] }).api).toBe('anthropic-messages');
  });

  it('handles missing models', () => {
    const r = toGatewayProvider({ baseUrl: 'http://x', apiType: 'google' });
    expect(r.api).toBe('google-generative-ai');
    expect(r.models).toEqual([]);
  });

  it('converts string models', () => {
    const r = toGatewayProvider({ baseUrl: '', models: ['gpt-4', 'gpt-3.5'] });
    expect(r.models).toEqual([{ id: 'gpt-4', name: 'gpt-4' }, { id: 'gpt-3.5', name: 'gpt-3.5' }]);
  });

  it('preserves auth and headers', () => {
    const r = toGatewayProvider({
      baseUrl: 'http://x',
      auth: 'bearer',
      headers: { 'X-Custom': 'val' },
      authHeader: true,
      models: [],
    });
    expect(r.auth).toBe('bearer');
    expect(r.headers).toEqual({ 'X-Custom': 'val' });
    expect(r.authHeader).toBe(true);
  });

  it('defaults baseUrl to empty string', () => {
    expect(toGatewayProvider({ models: [] }).baseUrl).toBe('');
  });
});

// ── inferProviderType ───────────────────────────────────────────────

describe('inferProviderType', () => {
  describe('from api field', () => {
    it('anthropic-messages → anthropic', () => {
      expect(inferProviderType('x', { api: 'anthropic-messages' })).toBe('anthropic');
    });
    it('google-generative-ai → google', () => {
      expect(inferProviderType('x', { api: 'google-generative-ai' })).toBe('google');
    });
  });

  describe('from baseUrl', () => {
    it('anthropic.com → anthropic', () => {
      expect(inferProviderType('x', { baseUrl: 'https://api.anthropic.com/v1' })).toBe('anthropic');
    });
    it('openai.com → openai', () => {
      expect(inferProviderType('x', { baseUrl: 'https://api.openai.com/v1' })).toBe('openai');
    });
    it('googleapis.com → google', () => {
      expect(inferProviderType('x', { baseUrl: 'https://generativelanguage.googleapis.com' })).toBe('google');
    });
    it('minimax → minimax', () => {
      expect(inferProviderType('x', { baseUrl: 'https://api.minimax.chat' })).toBe('minimax');
    });
  });

  describe('from provider name', () => {
    it('my-anthropic → anthropic', () => {
      expect(inferProviderType('my-anthropic', {})).toBe('anthropic');
    });
    it('openai-proxy → openai', () => {
      expect(inferProviderType('openai-proxy', {})).toBe('openai');
    });
    it('gemini-flash → google', () => {
      expect(inferProviderType('gemini-flash', {})).toBe('google');
    });
  });

  it('returns custom for unknown providers', () => {
    expect(inferProviderType('newapi', { baseUrl: 'http://47.253.7.24:3000/' })).toBe('custom');
  });
});
