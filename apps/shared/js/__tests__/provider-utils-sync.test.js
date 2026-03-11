/**
 * Verifies that the browser IIFE and CJS wrappers export the same
 * function signatures as the ESM source of truth.
 */
import { describe, it, expect } from 'vitest';
import * as esm from '../lib/provider-utils.js';

// Simulate browser IIFE by evaluating in a fake window context
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadIIFE() {
  const code = readFileSync(join(__dirname, '..', 'lib', 'provider-utils.iife.js'), 'utf8');
  const fakeWindow = {};
  // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
  new Function('window', code)(fakeWindow);
  return fakeWindow.ProviderUtils;
}

describe('provider-utils sync check', () => {
  const iife = loadIIFE();
  const esmKeys = Object.keys(esm).sort();
  const iifeKeys = Object.keys(iife).sort();

  it('IIFE exports the same keys as ESM', () => {
    expect(iifeKeys).toEqual(esmKeys);
  });

  it('resolveApi produces identical results', () => {
    const cases = [
      { apiType: 'openai' },
      { apiType: 'anthropic' },
      { api: 'anthropic-messages' },
      {},
    ];
    for (const c of cases) {
      expect(iife.resolveApi(c)).toBe(esm.resolveApi(c));
    }
  });

  it('toGatewayProvider produces identical results', () => {
    const provider = {
      baseUrl: 'http://x.com',
      apiType: 'anthropic',
      apiKey: 'sk-xxx',
      models: [{ id: 'm1', name: 'm1', input: ['text', 'image'] }],
    };
    expect(iife.toGatewayProvider(provider)).toEqual(esm.toGatewayProvider(provider));
  });

  it('inferProviderType produces identical results', () => {
    const cases = [
      ['x', { api: 'anthropic-messages' }],
      ['openai-proxy', {}],
      ['newapi', { baseUrl: 'http://x.com' }],
    ];
    for (const [name, prov] of cases) {
      expect(iife.inferProviderType(name, prov)).toBe(esm.inferProviderType(name, prov));
    }
  });
});
