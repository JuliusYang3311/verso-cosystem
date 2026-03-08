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
  if (process.env.GEP_ASSETS_DIR) {
    return process.env.GEP_ASSETS_DIR;
  }

  // Prefer workspace copy (writable, persists across updates)
  const workspaceDir = path.join(getWorkspaceRoot(), "evolver", "assets", "gep");

  // If workspace copy doesn't exist, seed it from bundled dist
  if (!fs.existsSync(path.join(workspaceDir, "context_params.json"))) {
    const evolverRoot = getEvolverRoot();
    const candidates = [
      path.join(evolverRoot, "assets", "gep"),
      path.join(evolverRoot, "evolver", "assets", "gep"),
      path.join(evolverRoot, "..", "evolver", "assets", "gep"),
      path.join(evolverRoot, "..", "..", "evolver", "assets", "gep"),
      path.join(evolverRoot, "..", "assets", "gep"),
      path.join(import.meta.dirname, "assets", "gep"),
      path.join(import.meta.dirname, "..", "assets", "gep"),
    ];
    for (const src of candidates) {
      if (fs.existsSync(path.join(src, "context_params.json"))) {
        fs.mkdirSync(workspaceDir, { recursive: true });
        for (const file of fs.readdirSync(src)) {
          const srcFile = path.join(src, file);
          const dstFile = path.join(workspaceDir, file);
          if (fs.statSync(srcFile).isFile() && !fs.existsSync(dstFile)) {
            fs.copyFileSync(srcFile, dstFile);
          }
        }
        break;
      }
    }
  }

  return workspaceDir;
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
