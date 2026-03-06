import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHomePrefix, resolveRequiredHomeDir } from "../infra/home-dir.js";
/**
 * Nix mode detection: When VERSO_NIX_MODE=1, the gateway is running under Nix.
 * In this mode:
 * - No auto-install flows should be attempted
 * - Missing dependencies should produce actionable Nix-specific error messages
 * - Config is managed externally (read-only from Nix perspective)
 */
export function resolveIsNixMode(env = process.env) {
  return env.VERSO_NIX_MODE === "1";
}
export const isNixMode = resolveIsNixMode();
const LEGACY_STATE_DIRNAMES = [".clawdbot", ".moltbot", ".moldbot"];
const NEW_STATE_DIRNAME = ".verso";
const CONFIG_FILENAME = "verso.json";
const LEGACY_CONFIG_FILENAMES = ["clawdbot.json", "moltbot.json", "moldbot.json"];
function resolveDefaultHomeDir() {
  return resolveRequiredHomeDir(process.env, os.homedir);
}
/** Build a homedir thunk that respects VERSO_HOME for the given env. */
function envHomedir(env) {
  return () => resolveRequiredHomeDir(env, os.homedir);
}
function legacyStateDirs(homedir = resolveDefaultHomeDir) {
  return LEGACY_STATE_DIRNAMES.map((dir) => path.join(homedir(), dir));
}
function newStateDir(homedir = resolveDefaultHomeDir) {
  return path.join(homedir(), NEW_STATE_DIRNAME);
}
export function resolveLegacyStateDir(homedir = resolveDefaultHomeDir) {
  return legacyStateDirs(homedir)[0] ?? newStateDir(homedir);
}
export function resolveLegacyStateDirs(homedir = resolveDefaultHomeDir) {
  return legacyStateDirs(homedir);
}
export function resolveNewStateDir(homedir = resolveDefaultHomeDir) {
  return newStateDir(homedir);
}
/**
 * State directory for mutable data (sessions, logs, caches).
 * Can be overridden via VERSO_STATE_DIR.
 * Default: ~/.verso
 */
export function resolveStateDir(env = process.env, homedir = envHomedir(env)) {
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  const override = env.VERSO_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env, effectiveHomedir);
  }
  const newDir = newStateDir(effectiveHomedir);
  const legacyDirs = legacyStateDirs(effectiveHomedir);
  const hasNew = fs.existsSync(newDir);
  if (hasNew) {
    return newDir;
  }
  const existingLegacy = legacyDirs.find((dir) => {
    try {
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  });
  if (existingLegacy) {
    return existingLegacy;
  }
  return newDir;
}
function resolveUserPath(input, env = process.env, homedir = envHomedir(env)) {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = expandHomePrefix(trimmed, {
      home: resolveRequiredHomeDir(env, homedir),
      env,
      homedir,
    });
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}
export const STATE_DIR = resolveStateDir();
/**
 * Config file path (JSON5).
 * Can be overridden via VERSO_CONFIG_PATH.
 * Default: ~/.verso/verso.json (or $VERSO_STATE_DIR/verso.json)
 */
export function resolveCanonicalConfigPath(
  env = process.env,
  stateDir = resolveStateDir(env, envHomedir(env)),
) {
  const override = env.VERSO_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env, envHomedir(env));
  }
  return path.join(stateDir, CONFIG_FILENAME);
}
/**
 * Resolve the active config path by preferring existing config candidates
 * before falling back to the canonical path.
 */
export function resolveConfigPathCandidate(env = process.env, homedir = envHomedir(env)) {
  const candidates = resolveDefaultConfigCandidates(env, homedir);
  const existing = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (existing) {
    return existing;
  }
  return resolveCanonicalConfigPath(env, resolveStateDir(env, homedir));
}
/**
 * Active config path (prefers existing config files).
 */
export function resolveConfigPath(
  env = process.env,
  stateDir = resolveStateDir(env, envHomedir(env)),
  homedir = envHomedir(env),
) {
  const override = env.VERSO_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env, homedir);
  }
  const stateOverride = env.VERSO_STATE_DIR?.trim();
  const candidates = [
    path.join(stateDir, CONFIG_FILENAME),
    ...LEGACY_CONFIG_FILENAMES.map((name) => path.join(stateDir, name)),
  ];
  const existing = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (existing) {
    return existing;
  }
  if (stateOverride) {
    return path.join(stateDir, CONFIG_FILENAME);
  }
  const defaultStateDir = resolveStateDir(env, homedir);
  if (path.resolve(stateDir) === path.resolve(defaultStateDir)) {
    return resolveConfigPathCandidate(env, homedir);
  }
  return path.join(stateDir, CONFIG_FILENAME);
}
export const CONFIG_PATH = resolveConfigPathCandidate();
/**
 * Resolve default config path candidates across default locations.
 * Order: explicit config path → state-dir-derived paths → new default.
 */
export function resolveDefaultConfigCandidates(env = process.env, homedir = envHomedir(env)) {
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  const explicit = env.VERSO_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
  if (explicit) {
    return [resolveUserPath(explicit, env, effectiveHomedir)];
  }
  const candidates = [];
  const versoStateDir = env.VERSO_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (versoStateDir) {
    const resolved = resolveUserPath(versoStateDir, env, effectiveHomedir);
    candidates.push(path.join(resolved, CONFIG_FILENAME));
    candidates.push(...LEGACY_CONFIG_FILENAMES.map((name) => path.join(resolved, name)));
  }
  const defaultDirs = [newStateDir(effectiveHomedir), ...legacyStateDirs(effectiveHomedir)];
  for (const dir of defaultDirs) {
    candidates.push(path.join(dir, CONFIG_FILENAME));
    candidates.push(...LEGACY_CONFIG_FILENAMES.map((name) => path.join(dir, name)));
  }
  return candidates;
}
export const DEFAULT_GATEWAY_PORT = 18789;
/**
 * Gateway lock directory (ephemeral).
 * Default: os.tmpdir()/verso-<uid> (uid suffix when available).
 */
export function resolveGatewayLockDir(tmpdir = os.tmpdir) {
  const base = tmpdir();
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const suffix = uid != null ? `verso-${uid}` : "verso";
  return path.join(base, suffix);
}
const OAUTH_FILENAME = "oauth.json";
/**
 * OAuth credentials storage directory.
 *
 * Precedence:
 * - `VERSO_OAUTH_DIR` (explicit override)
 * - `$*_STATE_DIR/credentials` (canonical server/default)
 */
export function resolveOAuthDir(
  env = process.env,
  stateDir = resolveStateDir(env, envHomedir(env)),
) {
  const override = env.VERSO_OAUTH_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env, envHomedir(env));
  }
  return path.join(stateDir, "credentials");
}
export function resolveOAuthPath(
  env = process.env,
  stateDir = resolveStateDir(env, envHomedir(env)),
) {
  return path.join(resolveOAuthDir(env, stateDir), OAUTH_FILENAME);
}
export function resolveGatewayPort(cfg, env = process.env) {
  const envRaw = env.VERSO_GATEWAY_PORT?.trim() || env.CLAWDBOT_GATEWAY_PORT?.trim();
  if (envRaw) {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const configPort = cfg?.gateway?.port;
  if (typeof configPort === "number" && Number.isFinite(configPort)) {
    if (configPort > 0) {
      return configPort;
    }
  }
  return DEFAULT_GATEWAY_PORT;
}
