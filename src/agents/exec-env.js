/**
 * Environment variable validation and PATH manipulation helpers for exec tool.
 *
 * Extracted from bash-tools.exec.ts to reduce module size.
 */
import path from "node:path";
import { loadConfig } from "../config/config.js";
// Security: Blocklist of environment variables that could alter execution flow
// or inject code when running on non-sandboxed hosts (Gateway/Node).
const DANGEROUS_HOST_ENV_VARS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "RUBYLIB",
  "PERL5LIB",
  "BASH_ENV",
  "ENV",
  "GCONV_PATH",
  "IFS",
  "SSLKEYLOGFILE",
]);
const DANGEROUS_HOST_ENV_PREFIXES = ["DYLD_", "LD_"];
// Centralized sanitization helper.
// Throws an error if dangerous variables or PATH modifications are detected on the host.
export function validateHostEnv(env) {
  for (const key of Object.keys(env)) {
    const upperKey = key.toUpperCase();
    // 1. Block known dangerous variables (Fail Closed)
    if (DANGEROUS_HOST_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix))) {
      throw new Error(
        `Security Violation: Environment variable '${key}' is forbidden during host execution.`,
      );
    }
    if (DANGEROUS_HOST_ENV_VARS.has(upperKey)) {
      throw new Error(
        `Security Violation: Environment variable '${key}' is forbidden during host execution.`,
      );
    }
    // 2. Strictly block PATH modification on host
    // Allowing custom PATH on the gateway/node can lead to binary hijacking.
    if (upperKey === "PATH") {
      throw new Error(
        "Security Violation: Custom 'PATH' variable is forbidden during host execution.",
      );
    }
  }
}
export function resolveSkillConfigEnv() {
  const cfg = loadConfig();
  const entries = cfg?.skills?.entries;
  if (!entries || typeof entries !== "object") {
    return {};
  }
  const env = {};
  for (const entry of Object.values(entries)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const value = entry.env;
    if (!value || typeof value !== "object") {
      continue;
    }
    for (const [key, raw] of Object.entries(value)) {
      if (typeof raw !== "string" || !raw) {
        continue;
      }
      env[key] = raw;
    }
  }
  return env;
}
export function normalizePathPrepend(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  const seen = new Set();
  const normalized = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}
export function mergePathPrepend(existing, prepend) {
  if (prepend.length === 0) {
    return existing;
  }
  const partsExisting = (existing ?? "")
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
  const merged = [];
  const seen = new Set();
  for (const part of [...prepend, ...partsExisting]) {
    if (seen.has(part)) {
      continue;
    }
    seen.add(part);
    merged.push(part);
  }
  return merged.join(path.delimiter);
}
export function applyPathPrepend(env, prepend, options) {
  if (prepend.length === 0) {
    return;
  }
  if (options?.requireExisting && !env.PATH) {
    return;
  }
  const merged = mergePathPrepend(env.PATH, prepend);
  if (merged) {
    env.PATH = merged;
  }
}
export function applyShellPath(env, shellPath) {
  if (!shellPath) {
    return;
  }
  const entries = shellPath
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return;
  }
  const merged = mergePathPrepend(env.PATH, entries);
  if (merged) {
    env.PATH = merged;
  }
}
