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

export function getGepAssetsDir(): string {
  const evolverRoot = getEvolverRoot();
  return process.env.GEP_ASSETS_DIR || path.join(evolverRoot, "assets", "gep");
}

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
