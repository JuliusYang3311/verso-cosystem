/**
 * Windows build integrity tests.
 *
 * Covers the class of bugs where pnpm hoisting collisions cause runtime crashes
 * in the packaged app. Root cause: rsync -aL dereferences top-level symlinks
 * (node_modules/X → .pnpm/<X>@<ver>/node_modules/X) to plain directories, but
 * those directories have no node_modules/ of their own. Sibling deps that pnpm
 * isolated at a different version become unreachable, and Node.js falls back to
 * the wrong hoisted version.
 *
 * Canonical crash: proper-lockfile calls `const onExit = require('signal-exit')`
 * then `onExit(() => {...})` at module top-level. signal-exit@3 exports a function;
 * signal-exit@4 exports an object. When proper-lockfile resolves to v4 instead of
 * v3, the packaged gateway throws: TypeError: onExit is not a function.
 *
 * Fix location: apps/windows/scripts/prepare-build.sh → fix_pnpm_dep_isolation()
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

const windowsDir = path.resolve(import.meta.dirname, '..');
const versoRoot = path.resolve(windowsDir, '../..');
const staging = path.join(versoRoot, 'build-node-modules-win');
const script = fs.readFileSync(
  path.join(windowsDir, 'scripts', 'prepare-build.sh'),
  'utf8',
);

// ── Script-level checks (always run — no built staging dir required) ─────────

describe('prepare-build.sh: pnpm dep isolation', () => {
  it('defines fix_pnpm_dep_isolation function', () => {
    expect(script).toContain('fix_pnpm_dep_isolation()');
  });

  it('calls fix_pnpm_dep_isolation with $STAGING', () => {
    expect(script).toMatch(/fix_pnpm_dep_isolation\s+['"]\$STAGING['"]/);
  });

  it('includes proper-lockfile → signal-exit@3 fix entry', () => {
    // proper-lockfile calls onExit() at module top-level; needs signal-exit@3 (function).
    // signal-exit@4 (object) causes: TypeError: onExit is not a function at module load.
    expect(script).toMatch(/proper-lockfile\s*:\s*signal-exit\s*@\s*3\.\d+\.\d+/);
  });

  it('calls fix outside the rsync guard (idempotent on existing staging dir)', () => {
    // The fix must run even when build-node-modules-win already exists, so that
    // a pre-built staging dir is corrected without requiring a full rebuild.
    const fiIdx = script.lastIndexOf('\nfi\n');
    const callIdx = script.indexOf('fix_pnpm_dep_isolation "$STAGING"');
    expect(fiIdx).toBeGreaterThan(0);
    expect(callIdx).toBeGreaterThan(fiIdx);
  });

  it('rsync uses -aL flag to dereference symlinks', () => {
    // -aL is required so Windows NSIS extraction gets real files, not symlinks.
    expect(script).toMatch(/rsync\s+-aL\b/);
  });

  it('excludes macOS-only packages that would crash on Windows', () => {
    expect(script).toContain("--exclude='.pnpm/fsevents@*'");
    expect(script).toContain("--exclude='fsevents'");
    expect(script).toContain("--exclude='.pnpm/iconv-corefoundation@*'");
  });
});

// ── Staging dir checks (skipped if build-node-modules-win not yet built) ─────

const stagingExists = fs.existsSync(staging);

describe('build-node-modules-win: signal-exit isolation for proper-lockfile', () => {
  it.skipIf(!stagingExists)('proper-lockfile has its own node_modules/signal-exit', () => {
    // After fix_pnpm_dep_isolation runs, proper-lockfile must have a local signal-exit
    // so it doesn't fall through to the top-level v4.
    const injected = path.join(staging, 'proper-lockfile', 'node_modules', 'signal-exit');
    expect(
      fs.existsSync(injected),
      `Missing: ${injected}\nRun prepare-build.sh to apply the isolation fix.`,
    ).toBe(true);
  });

  it.skipIf(!stagingExists)('proper-lockfile/node_modules/signal-exit is v3.x', () => {
    const pkgPath = path.join(
      staging, 'proper-lockfile', 'node_modules', 'signal-exit', 'package.json',
    );
    const { version } = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    expect(version, `Expected signal-exit@3.x, got @${version}`).toMatch(/^3\./);
  });

  it.skipIf(!stagingExists)('proper-lockfile/node_modules/signal-exit exports a function (not object)', () => {
    // signal-exit@3 CJS: module.exports = function(cb, opts) { ... }
    // signal-exit@4 CJS: exports.onExit = ...; exports.load = ...; (no default function)
    // proper-lockfile does: const onExit = require('signal-exit'); onExit(() => {...})
    // So the required module must be a function, not an object.
    const indexPath = path.join(
      staging, 'proper-lockfile', 'node_modules', 'signal-exit', 'index.js',
    );
    const src = fs.readFileSync(indexPath, 'utf8');
    expect(src).toMatch(/module\.exports\s*=/);   // v3 default function export
    expect(src).not.toMatch(/exports\.onExit\s*=/); // v4 named export pattern
  });

  it.skipIf(!stagingExists)('top-level signal-exit remains v4 (other packages depend on it)', () => {
    const pkgPath = path.join(staging, 'signal-exit', 'package.json');
    const { version } = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    expect(version).toMatch(/^4\./);
  });
});

describe('build-node-modules-win: .pnpm structure for proper-lockfile', () => {
  it.skipIf(!stagingExists)('.pnpm/proper-lockfile@4.1.2 exists', () => {
    const pnpmPkg = path.join(staging, '.pnpm', 'proper-lockfile@4.1.2', 'node_modules', 'proper-lockfile');
    expect(fs.existsSync(pnpmPkg)).toBe(true);
  });

  it.skipIf(!stagingExists)('.pnpm/proper-lockfile@4.1.2 has sibling signal-exit@3', () => {
    // This is the pnpm-isolated copy. The sibling here is correct (v3) but is only
    // reachable when the module is loaded from .pnpm (not from the hoisted top-level copy).
    const pnpmNm = path.join(staging, '.pnpm', 'proper-lockfile@4.1.2', 'node_modules');
    const sigPkg = path.join(pnpmNm, 'signal-exit', 'package.json');
    expect(fs.existsSync(sigPkg)).toBe(true);
    const { version } = JSON.parse(fs.readFileSync(sigPkg, 'utf8'));
    expect(version).toMatch(/^3\./);
  });

  it.skipIf(!stagingExists)('both signal-exit@3 and signal-exit@4 are present in .pnpm', () => {
    // Both versions must be retained: v3 for proper-lockfile, v4 for other packages.
    expect(fs.existsSync(path.join(staging, '.pnpm', 'signal-exit@3.0.7'))).toBe(true);
    expect(fs.existsSync(path.join(staging, '.pnpm', 'signal-exit@4.1.0'))).toBe(true);
  });
});

describe('build-node-modules-win: gateway can load proper-lockfile without crashing', () => {
  it.skipIf(!stagingExists)('proper-lockfile top-level copy exists and has no stray node_modules deps', () => {
    // Sanity: the top-level proper-lockfile/ directory must exist (it's the one
    // that Node.js resolves to from dist/index.js require('proper-lockfile')).
    const pkgDir = path.join(staging, 'proper-lockfile');
    expect(fs.existsSync(pkgDir)).toBe(true);
    // Its lockfile.js must call onExit at top-level (so we know it's the risky version)
    const lockfileSrc = fs.readFileSync(path.join(pkgDir, 'lib', 'lockfile.js'), 'utf8');
    expect(lockfileSrc).toMatch(/^const onExit = require\('signal-exit'\)/m);
    expect(lockfileSrc).toMatch(/^onExit\(/m);
  });
});
