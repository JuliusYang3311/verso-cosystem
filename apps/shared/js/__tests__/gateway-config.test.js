import { describe, it, expect } from 'vitest';
import { resolveGatewayToken, ensureGatewayFields, loadLicenseText } from '../lib/gateway-config.js';

// ── resolveGatewayToken ─────────────────────────────────────────────

describe('resolveGatewayToken', () => {
  const mockCrypto = { randomBytes: () => ({ toString: () => 'abcd'.repeat(16) }) };

  it('prefers config token', () => {
    const r = resolveGatewayToken({
      configToken: 'config-token-long-enough',
      envToken: 'env-token-long-enough-xx',
      crypto: mockCrypto,
    });
    expect(r.token).toBe('config-token-long-enough');
    expect(r.source).toBe('config');
  });

  it('falls back to env when config token too short', () => {
    const r = resolveGatewayToken({
      configToken: 'short',
      envToken: 'env-token-long-enough-xx',
      crypto: mockCrypto,
    });
    expect(r.token).toBe('env-token-long-enough-xx');
    expect(r.source).toBe('env');
  });

  it('ignores env token "undefined"', () => {
    const r = resolveGatewayToken({
      envToken: 'undefined',
      crypto: mockCrypto,
    });
    expect(r.source).toBe('generated');
  });

  it('generates token when nothing available', () => {
    const r = resolveGatewayToken({ crypto: mockCrypto });
    expect(r.source).toBe('generated');
    expect(r.token).toBe('abcd'.repeat(16));
  });

  it('reads macOS launchd plist when checkLaunchd=true', () => {
    const plistContent = `<?xml version="1.0"?>
<dict>
  <key>VERSO_GATEWAY_TOKEN</key>
  <string>plist-token-value-long</string>
</dict>`;
    const mockFs = {
      existsSync: () => true,
      readFileSync: () => plistContent,
    };
    const mockOs = { homedir: () => '/Users/test' };
    const mockPath = { join: (...parts) => parts.join('/') };

    const r = resolveGatewayToken({
      checkLaunchd: true,
      fs: mockFs,
      os: mockOs,
      path: mockPath,
      crypto: mockCrypto,
    });
    expect(r.token).toBe('plist-token-value-long');
    expect(r.source).toBe('launchd');
  });

  it('skips launchd when plist not found', () => {
    const mockFs = { existsSync: () => false };
    const mockOs = { homedir: () => '/Users/test' };
    const mockPath = { join: (...parts) => parts.join('/') };

    const r = resolveGatewayToken({
      checkLaunchd: true,
      fs: mockFs,
      os: mockOs,
      path: mockPath,
      crypto: mockCrypto,
    });
    expect(r.source).toBe('generated');
  });
});

// ── ensureGatewayFields ─────────────────────────────────────────────

describe('ensureGatewayFields', () => {
  it('initializes empty config', () => {
    const config = {};
    ensureGatewayFields(config, 'my-token');
    expect(config.gateway.mode).toBe('local');
    expect(config.gateway.auth.token).toBe('my-token');
    expect(config.gateway.controlUi.allowInsecureAuth).toBe(true);
  });

  it('preserves existing gateway mode', () => {
    const config = { gateway: { mode: 'remote' } };
    ensureGatewayFields(config, 'tok');
    expect(config.gateway.mode).toBe('remote');
  });

  it('preserves existing gateway fields', () => {
    const config = { gateway: { custom: 'field', auth: { existing: true } } };
    ensureGatewayFields(config, 'tok');
    expect(config.gateway.custom).toBe('field');
    expect(config.gateway.auth.existing).toBe(true);
    expect(config.gateway.auth.token).toBe('tok');
  });
});

// ── loadLicenseText ─────────────────────────────────────────────────

describe('loadLicenseText', () => {
  it('returns content from first existing path', () => {
    const mockFs = {
      existsSync: (p) => p === '/b/LICENSE.txt',
      readFileSync: () => 'MIT License',
    };
    const result = loadLicenseText(mockFs, ['/a/LICENSE.txt', '/b/LICENSE.txt', '/c/LICENSE.txt']);
    expect(result).toBe('MIT License');
  });

  it('returns null when no path exists', () => {
    const mockFs = { existsSync: () => false };
    expect(loadLicenseText(mockFs, ['/a', '/b'])).toBeNull();
  });

  it('returns null on empty candidates', () => {
    const mockFs = { existsSync: () => false };
    expect(loadLicenseText(mockFs, [])).toBeNull();
  });

  it('skips paths that throw', () => {
    const mockFs = {
      existsSync: (_p) => true,
      readFileSync: (p) => { if (p === '/a') throw new Error('perm'); return 'ok'; },
    };
    expect(loadLicenseText(mockFs, ['/a', '/b'])).toBe('ok');
  });
});
