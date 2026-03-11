import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

// Test the gateway launch configuration for Windows.
// These tests verify that the bundled node.exe approach works correctly
// and that ESM-incompatible ELECTRON_RUN_AS_NODE is not used in production.

describe('Windows gateway launch configuration', () => {
  const windowsDir = path.resolve(import.meta.dirname, '..');
  const mainJsPath = path.join(windowsDir, 'main.js');
  const mainJs = fs.readFileSync(mainJsPath, 'utf8');

  it('uses bundled node.exe in packaged mode (not process.execPath)', () => {
    // Ensure we use the standalone Node binary, not Electron's runtime
    expect(mainJs).toContain("path.join(resolvedGatewayRoot, 'node.exe')");
    expect(mainJs).not.toMatch(/nodeBin\s*=\s*.*process\.execPath/);
  });

  it('does not set ELECTRON_RUN_AS_NODE for gateway process', () => {
    // ELECTRON_RUN_AS_NODE causes ESM resolution issues; bundled node.exe doesn't need it
    // Check within the launchGateway function specifically (env setup for child process)
    const launchFn = mainJs.slice(mainJs.indexOf('function launchGateway'));
    expect(launchFn).not.toContain("ELECTRON_RUN_AS_NODE = '1'");
    expect(launchFn).not.toContain('ELECTRON_RUN_AS_NODE = "1"');
  });

  it('package.json includes node.exe in extraResources', () => {
    const pkgPath = path.join(windowsDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const resources = pkg.build?.extraResources || [];
    const nodeEntry = resources.find(r =>
      typeof r === 'object' && r.from?.includes('node.exe') && r.to === 'gateway/node.exe'
    );
    expect(nodeEntry).toBeDefined();
  });

  it('prepare-build.sh downloads node.exe for Windows', () => {
    const scriptPath = path.join(windowsDir, 'scripts', 'prepare-build.sh');
    const script = fs.readFileSync(scriptPath, 'utf8');
    expect(script).toContain('win-');
    expect(script).toContain('node.exe');
    expect(script).toMatch(/nodejs\.org.*win.*node\.exe/);
  });

  it('gateway entry point uses ESM dynamic import', () => {
    const entryPath = path.join(windowsDir, 'gateway', 'index.js');
    const entry = fs.readFileSync(entryPath, 'utf8');
    // Must use dynamic import for ESM dist/index.js
    expect(entry).toContain('await import(');
    expect(entry).toContain('pathToFileURL');
  });

  it('gateway launch matches macOS pattern (bundled node binary)', () => {
    const electronDir = path.resolve(windowsDir, '..', 'electron');
    const electronMain = fs.readFileSync(path.join(electronDir, 'main.js'), 'utf8');
    // Both platforms should use path.join(resolvedGatewayRoot, 'node...')
    expect(electronMain).toContain("path.join(resolvedGatewayRoot, 'node')");
    expect(mainJs).toContain("path.join(resolvedGatewayRoot, 'node.exe')");
  });
});
