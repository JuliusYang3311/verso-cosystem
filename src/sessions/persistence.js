import fs from "node:fs";
import {
  removeSessionFromStore,
  resolveSessionFilePath,
  resolveStorePath,
  loadSessionStore,
  updateSessionStore,
} from "../config/sessions.js";
import { isSubagentSessionKey } from "./session-key-utils.js";
export const STALE_THRESHOLD_MS = 30 * 60 * 1000;
export function resolvePersistenceMode(params) {
  const { cfg, agentId, sessionKey, sessionEntry } = params;
  // Check for explicit session-level override first.
  if (sessionEntry?.persistence) {
    return sessionEntry.persistence;
  }
  // If the session was spawned by another session, it should be transient by default.
  if (sessionEntry?.spawnedBy) {
    return "transient";
  }
  const agentConfig = cfg.agents?.list?.find((a) => a.id === agentId);
  const isSubagent = isSubagentSessionKey(sessionKey);
  const isCron = sessionKey?.startsWith("cron:") ?? false;
  // unless the agent policy is explicitly 'persistent'.
  const globalDefault = cfg.agents?.defaults?.persistence ?? "persistent";
  let persistence =
    agentConfig?.persistence ?? (isSubagent || isCron ? "transient" : globalDefault);
  if ((isSubagent || isCron) && persistence === "singleton") {
    persistence = "transient";
  }
  return persistence;
}
export async function handleSingletonCleanup(params) {
  const { cfg, agentId, sessionKey, entry } = params;
  if (!entry?.sessionId) {
    return;
  }
  const prevSessionFile = resolveSessionFilePath(entry.sessionId, entry, { agentId });
  if (prevSessionFile && fs.existsSync(prevSessionFile)) {
    try {
      fs.unlinkSync(prevSessionFile);
    } catch {
      // Best-effort
    }
  }
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  if (storePath) {
    await removeSessionFromStore({ storePath, sessionKey });
  }
}
export async function handleTransientCleanup(params) {
  const { cfg, agentId, sessionKey, sessionFile } = params;
  if (sessionFile && fs.existsSync(sessionFile)) {
    try {
      fs.unlinkSync(sessionFile);
    } catch {
      // Best-effort
    }
  }
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  if (storePath) {
    await removeSessionFromStore({ storePath, sessionKey });
  }
}
export function isSessionStale(params) {
  const { cfg, agentId, sessionKey, entry } = params;
  const now = params.now ?? Date.now();
  const persistence = resolvePersistenceMode({ cfg, agentId, sessionKey, sessionEntry: entry });
  if (persistence !== "transient") {
    return false;
  }
  // Stale threshold: 5 minutes
  const updatedAt = entry.updatedAt ?? 0;
  if (now - updatedAt < STALE_THRESHOLD_MS) {
    return false;
  }
  // Check if it's "empty" (never really started)
  // 0 tokens is a strong signal.
  // Also check if session file exists.
  if ((entry.totalTokens ?? 0) > 0) {
    return false;
  }
  // Ideally check file existence too, but that's expensive for a sync check.
  // We'll rely on token count = 0 as primary signal for "transient stub".
  return true;
}
export async function pruneStaleSessions(params) {
  const { cfg, agentId } = params;
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  if (!storePath || !fs.existsSync(storePath)) {
    return;
  }
  await updateSessionStore(storePath, (store) => {
    const now = Date.now();
    for (const [key, entry] of Object.entries(store)) {
      if (!entry) {
        continue;
      }
      if (
        isSessionStale({
          cfg,
          agentId,
          sessionKey: key,
          entry,
          now,
        })
      ) {
        // It's stale. Delete it.
        const sessionFile = resolveSessionFilePath(entry.sessionId, entry, { agentId });
        if (sessionFile && fs.existsSync(sessionFile)) {
          try {
            fs.unlinkSync(sessionFile);
          } catch {
            // Ignore
          }
        }
        delete store[key];
      }
    }
  });
}
export async function pruneExpiredTransientSession(params) {
  const { cfg, agentId, sessionKey } = params;
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  if (!storePath || !fs.existsSync(storePath)) {
    return;
  }
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) {
    return;
  }
  // Re-check staleness/expiry logic
  // Only delete if it's ACTUALLY stale based on the threshold.
  // This handles the case where a setTimeout from a previous turn fires,
  // but the session has since been updated by a subsequent turn.
  const now = Date.now();
  const updatedAt = entry.updatedAt ?? 0;
  // Use a slight buffer on top of STALE_THRESHOLD_MS to be safe, or just reuse it.
  // If it was updated RECENTLY (within the threshold), do NOT delete.
  if (now - updatedAt < STALE_THRESHOLD_MS) {
    return;
  }
  // It's expired. Proceed with deletion.
  const sessionFile = resolveSessionFilePath(entry.sessionId, entry, { agentId });
  await handleTransientCleanup({
    cfg,
    agentId,
    sessionKey,
    sessionFile,
  });
  // Also remove from store to keep it clean (handleTransientCleanup does this, but let's be sure about the flow)
  // handleTransientCleanup calls removeSessionFromStore internally if storePath is resolved.
}
