import { describe, it, expect } from 'vitest';
import { deepMerge } from '../lib/deep-merge.js';

describe('deepMerge', () => {
  it('merges flat objects', () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it('source overrides target scalars', () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it('deep-merges nested objects', () => {
    const target = { models: { providers: { p1: 'a' } } };
    const source = { models: { other: 'b' } };
    expect(deepMerge(target, source)).toEqual({
      models: { providers: { p1: 'a' }, other: 'b' },
    });
  });

  it('preserves target keys absent from source', () => {
    const target = { models: { providers: { p1: 'a' }, keep: true } };
    const source = { models: {} };
    const result = deepMerge(target, source);
    expect(result.models.providers).toEqual({ p1: 'a' });
    expect(result.models.keep).toBe(true);
  });

  it('replaceKeys does atomic replace', () => {
    const target = { models: { providers: { old: 1 } } };
    const source = { models: { providers: { new: 2 } } };
    const result = deepMerge(target, source, ['models.providers']);
    expect(result.models.providers).toEqual({ new: 2 });
  });

  it('replaceKeys allows undefined replacement', () => {
    const target = { models: { providers: { p1: 'a' } } };
    const source = { models: { providers: undefined } };
    const result = deepMerge(target, source, ['models.providers']);
    expect(result.models.providers).toBeUndefined();
  });

  it('does not deep-merge arrays', () => {
    expect(deepMerge({ items: [1, 2] }, { items: [3] })).toEqual({ items: [3] });
  });

  it('handles empty source', () => {
    const target = { a: 1, b: { c: 2 } };
    expect(deepMerge(target, {})).toEqual({ a: 1, b: { c: 2 } });
  });

  it('handles empty target', () => {
    expect(deepMerge({}, { a: 1 })).toEqual({ a: 1 });
  });

  it('does not mutate target', () => {
    const target = { a: { b: 1 } };
    const source = { a: { c: 2 } };
    const result = deepMerge(target, source);
    expect(target.a.c).toBeUndefined();
    expect(result.a).toEqual({ b: 1, c: 2 });
  });

  // Regression: saveAllSettings bug — empty source.models must not wipe target.models.providers
  it('empty nested source preserves all target nested keys', () => {
    const target = {
      models: {
        providers: {
          newapi: { api: 'anthropic-messages', baseUrl: 'http://example.com', models: [] },
        },
      },
    };
    const source = { models: {} };
    const result = deepMerge(target, source);
    expect(result.models.providers.newapi.api).toBe('anthropic-messages');
  });

  // Regression: simulates saveProviders + saveAllSettings sequence
  it('full save sequence preserves providers', () => {
    const existing = { models: {}, agents: {} };

    // Step 1: saveProviders writes with replaceKeys
    const providerUpdate = {
      models: {
        providers: {
          newapi: { api: 'anthropic-messages', baseUrl: 'http://x.com', models: [{ id: 'm1', name: 'm1' }] },
        },
      },
    };
    const afterProviderSave = deepMerge(existing, providerUpdate, ['models.providers']);
    expect(afterProviderSave.models.providers.newapi.api).toBe('anthropic-messages');

    // Step 2: saveAllSettings writes without replaceKeys, providers deleted from source
    const settingsUpdate = {
      models: {},
      agents: { defaults: { workspace: '/tmp' } },
    };
    const afterSettingsSave = deepMerge(afterProviderSave, settingsUpdate);
    expect(afterSettingsSave.models.providers.newapi.api).toBe('anthropic-messages');
    expect(afterSettingsSave.agents.defaults.workspace).toBe('/tmp');
  });

  it('deeply nested replaceKeys', () => {
    const target = { a: { b: { c: { keep: true, replace: 'old' } } } };
    const source = { a: { b: { c: { replace: 'new' } } } };
    const result = deepMerge(target, source, ['a.b.c']);
    expect(result.a.b.c).toEqual({ replace: 'new' });
    expect(result.a.b.c.keep).toBeUndefined();
  });
});
