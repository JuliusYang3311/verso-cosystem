/**
 * Session-bound Python virtual environment management.
 *
 * Each session gets its own venv (created lazily on first Python skill use).
 * Venvs are destroyed when the session is removed or when they exceed the
 * stale timeout (1 hour default). Uses `uv` for fast creation and install.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
const log = createSubsystemLogger("session-venv");
const ACTIVE_VENVS = new Map();
const MAX_VENVS = 20;
const VENV_STALE_MS = 60 * 60 * 1000; // 1 hour
const REAP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const reapTimer = setInterval(() => {
  reapStaleVenvs();
}, REAP_INTERVAL_MS);
reapTimer.unref?.();
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Ensure a Python venv exists for the given session.
 * Creates and installs dependencies if the venv doesn't exist yet.
 * Returns the venv path, or null if creation fails.
 */
export async function ensureSessionVenv(params) {
  const existing = ACTIVE_VENVS.get(params.sessionKey);
  if (existing && existsSync(path.join(existing.path, "bin", "python"))) {
    return existing.path;
  }
  const slug = slugifySessionKey(params.sessionKey);
  const venvDir = path.join(params.workspaceDir, ".verso-venvs", slug);
  // If already on disk (e.g. from a previous process), register and return.
  if (existsSync(path.join(venvDir, "bin", "python"))) {
    registerVenv(params.sessionKey, venvDir);
    return venvDir;
  }
  try {
    await fs.mkdir(path.dirname(venvDir), { recursive: true });
    const useUv = hasCommand("uv");
    if (useUv) {
      execFileSync("uv", ["venv", venvDir], {
        timeout: 30_000,
        stdio: "pipe",
      });
    } else {
      execFileSync("python3", ["-m", "venv", venvDir], {
        timeout: 60_000,
        stdio: "pipe",
      });
    }
    // Install requirements
    const reqFile = params.requirementsFile ?? resolveDefaultRequirements(params.workspaceDir);
    if (reqFile && existsSync(reqFile)) {
      const pythonBin = path.join(venvDir, "bin", "python");
      if (useUv) {
        execFileSync("uv", ["pip", "install", "-r", reqFile, "--python", pythonBin], {
          timeout: 300_000, // 5 minutes for package install
          stdio: "pipe",
        });
      } else {
        execFileSync(pythonBin, ["-m", "pip", "install", "-r", reqFile, "--quiet"], {
          timeout: 300_000,
          stdio: "pipe",
        });
      }
      log.info(`session-venv: created and installed deps for ${params.sessionKey} at ${venvDir}`);
    } else {
      log.info(`session-venv: created (no requirements) for ${params.sessionKey} at ${venvDir}`);
    }
    registerVenv(params.sessionKey, venvDir);
    return venvDir;
  } catch (err) {
    log.warn(
      `session-venv: failed to create venv for ${params.sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Clean up partial venv
    try {
      rmSync(venvDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    return null;
  }
}
/** Get the venv path for a session, or null if none exists. */
export function getSessionVenvPath(sessionKey) {
  const entry = ACTIVE_VENVS.get(sessionKey);
  return entry?.path ?? null;
}
/** Destroy the venv for a session and clean up disk + registry. */
export async function destroySessionVenv(sessionKey) {
  const entry = ACTIVE_VENVS.get(sessionKey);
  if (!entry) {
    return;
  }
  ACTIVE_VENVS.delete(sessionKey);
  try {
    await fs.rm(entry.path, { recursive: true, force: true });
    log.info(`session-venv: destroyed for ${sessionKey}`);
  } catch (err) {
    log.warn(
      `session-venv: cleanup failed for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
/** Evict stale venvs that exceed the age limit. */
export function reapStaleVenvs() {
  const now = Date.now();
  for (const [key, entry] of ACTIVE_VENVS) {
    if (now - entry.createdAt > VENV_STALE_MS) {
      log.info(`session-venv: reaping stale venv for ${key}`);
      ACTIVE_VENVS.delete(key);
      try {
        rmSync(entry.path, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}
// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------
function registerVenv(sessionKey, venvPath) {
  // Enforce MAX_VENVS: evict oldest if at limit.
  if (ACTIVE_VENVS.size >= MAX_VENVS) {
    let oldestKey;
    let oldestTime = Infinity;
    for (const [k, v] of ACTIVE_VENVS) {
      if (v.createdAt < oldestTime) {
        oldestTime = v.createdAt;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      const evicted = ACTIVE_VENVS.get(oldestKey);
      ACTIVE_VENVS.delete(oldestKey);
      if (evicted) {
        log.warn(`session-venv: evicting oldest venv for ${oldestKey}`);
        try {
          rmSync(evicted.path, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }
  ACTIVE_VENVS.set(sessionKey, { path: venvPath, createdAt: Date.now() });
}
function slugifySessionKey(key) {
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 8);
  const slug = key
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return `${slug}-${hash}`;
}
function hasCommand(cmd) {
  try {
    execFileSync("which", [cmd], { timeout: 5_000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
function resolveDefaultRequirements(workspaceDir) {
  // Walk up from workspace looking for requirements.txt
  let dir = workspaceDir;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "requirements.txt");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}
