import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function getEvolverRoot(): string {
  return path.resolve(import.meta.dirname, "..");
}

export function getWorkspaceRoot(): string {
  const fromEnv = process.env.VERSO_WORKSPACE || process.env.OPENCLAW_WORKSPACE;
  if (fromEnv) {
    return fromEnv;
  }
  // Fallback to default workspace dir (~/.verso/workspace) instead of
  // import.meta.dirname which won't exist for packaged (DMG) installs.
  return path.join(os.homedir(), ".verso", "workspace");
}

export function getRepoRoot(): string {
  return getEvolverRoot();
}

export function getMemoryDir(): string {
  const workspace = getWorkspaceRoot();
  return process.env.MEMORY_DIR || path.join(workspace, "memory");
}

export function getEvolutionDir(): string {
  return process.env.EVOLUTION_DIR || path.join(getMemoryDir(), "evolution");
}

// ---------------------------------------------------------------------------
// Bundled-to-workspace seed helper
// ---------------------------------------------------------------------------

/**
 * Find the bundled evolver assets directory containing `sentinel` file.
 * Returns the path or undefined if not found.
 */
function findBundledAssetsDir(sentinel: string, subdir?: string): string | undefined {
  const evolverRoot = getEvolverRoot();
  const suffix = subdir ? path.join(subdir) : "";
  const candidates = [
    path.join(evolverRoot, "assets", suffix),
    path.join(evolverRoot, "evolver", "assets", suffix),
    path.join(evolverRoot, "..", "evolver", "assets", suffix),
    path.join(evolverRoot, "..", "..", "evolver", "assets", suffix),
    path.join(evolverRoot, "..", "assets", suffix),
    path.join(import.meta.dirname, "..", "assets", suffix),
    path.join(import.meta.dirname, "..", "..", "assets", suffix),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, sentinel))) {
      return dir;
    }
  }
  return undefined;
}

/** Copy missing files from `srcDir` into `destDir`. Existing files are not overwritten. */
function seedMissing(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of fs.readdirSync(srcDir)) {
    const srcFile = path.join(srcDir, file);
    const dstFile = path.join(destDir, file);
    if (fs.statSync(srcFile).isFile() && !fs.existsSync(dstFile)) {
      fs.copyFileSync(srcFile, dstFile);
    }
  }
}

// ---------------------------------------------------------------------------
// Evolver shared assets — context_params.json, factor-space.json
// ---------------------------------------------------------------------------

let _evolverAssetsDirCache: string | undefined;

/**
 * Evolver assets dir: workspace/evolver/assets/
 * Contains context_params.json and factor-space.json (shared tunable params).
 * Seeds missing files from bundled dist on first access.
 */
export function getEvolverAssetsDir(): string {
  if (process.env.EVOLVER_ASSETS_DIR) {
    return process.env.EVOLVER_ASSETS_DIR;
  }
  if (_evolverAssetsDirCache) return _evolverAssetsDirCache;

  const workspaceDir = path.join(getWorkspaceRoot(), "evolver", "assets");
  const bundled = findBundledAssetsDir("context_params.json");
  if (bundled) seedMissing(bundled, workspaceDir);

  _evolverAssetsDirCache = workspaceDir;
  return workspaceDir;
}

// ---------------------------------------------------------------------------
// GEP-specific assets — capsules.json, genes.json, etc.
// ---------------------------------------------------------------------------

let _gepAssetsDirCache: string | undefined;

/**
 * GEP-specific assets dir: workspace/evolver/assets/gep/
 * Contains capsules.json, genes.json, candidates.jsonl, events.jsonl, feedback.jsonl.
 * Seeds missing files from bundled dist on first access.
 */
export function getGepAssetsDir(): string {
  if (process.env.GEP_ASSETS_DIR) {
    return process.env.GEP_ASSETS_DIR;
  }
  if (_gepAssetsDirCache) return _gepAssetsDirCache;

  const workspaceDir = path.join(getWorkspaceRoot(), "evolver", "assets", "gep");
  const bundled = findBundledAssetsDir("capsules.json", "gep");
  if (bundled) seedMissing(bundled, workspaceDir);

  _gepAssetsDirCache = workspaceDir;
  return workspaceDir;
}

// ---------------------------------------------------------------------------
// Convenience accessors — single-file paths with lazy seed
// ---------------------------------------------------------------------------

/**
 * Path to context_params.json in workspace.
 * Triggers seed from bundled assets on first call if missing.
 */
export function getContextParamsPath(): string {
  return path.join(getEvolverAssetsDir(), "context_params.json");
}

/**
 * Path to factor-space.json in workspace.
 * Triggers seed from bundled assets on first call if missing.
 */
export function getFactorSpacePath(): string {
  return path.join(getEvolverAssetsDir(), "factor-space.json");
}

// ---------------------------------------------------------------------------
// Other workspace dirs
// ---------------------------------------------------------------------------

export function getSkillsDir(): string {
  return path.join(getWorkspaceRoot(), "skills");
}

export function getLogsDir(): string {
  const dir = path.join(getWorkspaceRoot(), "logs");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}
