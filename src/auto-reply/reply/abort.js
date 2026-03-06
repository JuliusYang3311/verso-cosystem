import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { abortEmbeddedPiRun } from "../../agents/pi-embedded.js";
import { loadSessionStore, resolveStorePath, updateSessionStore } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import { normalizeCommandBody } from "../commands-registry.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import { clearSessionQueues } from "./queue.js";
const ABORT_TRIGGERS = new Set(["stop", "esc", "abort", "wait", "exit", "interrupt"]);
const ABORT_MEMORY = new Map();
export function isAbortTrigger(text) {
  if (!text) {
    return false;
  }
  const normalized = text.trim().toLowerCase();
  return ABORT_TRIGGERS.has(normalized);
}
export function getAbortMemory(key) {
  return ABORT_MEMORY.get(key);
}
export function setAbortMemory(key, value) {
  ABORT_MEMORY.set(key, value);
}
export function formatAbortReplyText() {
  return "⚙️ Agent was aborted.";
}
function resolveSessionEntryForKey(store, sessionKey) {
  if (!store || !sessionKey) {
    return {};
  }
  const direct = store[sessionKey];
  if (direct) {
    return { entry: direct, key: sessionKey };
  }
  return {};
}
function resolveAbortTargetKey(ctx) {
  const target = ctx.CommandTargetSessionKey?.trim();
  if (target) {
    return target;
  }
  const sessionKey = ctx.SessionKey?.trim();
  return sessionKey || undefined;
}
export async function tryFastAbortFromMessage(params) {
  const { ctx, cfg } = params;
  const targetKey = resolveAbortTargetKey(ctx);
  const agentId = resolveSessionAgentId({
    sessionKey: targetKey ?? ctx.SessionKey ?? "",
    config: cfg,
  });
  // Use RawBody/CommandBody for abort detection (clean message without structural context).
  const raw = stripStructuralPrefixes(ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "");
  const isGroup = ctx.ChatType?.trim().toLowerCase() === "group";
  const stripped = isGroup ? stripMentions(raw, ctx, cfg, agentId) : raw;
  const normalized = normalizeCommandBody(stripped);
  const abortRequested = normalized === "/stop" || isAbortTrigger(stripped);
  if (!abortRequested) {
    return { handled: false, aborted: false };
  }
  const commandAuthorized = ctx.CommandAuthorized;
  const auth = resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized,
  });
  if (!auth.isAuthorizedSender) {
    return { handled: false, aborted: false };
  }
  const abortKey = targetKey ?? auth.from ?? auth.to;
  if (targetKey) {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    const { entry, key } = resolveSessionEntryForKey(store, targetKey);
    const sessionId = entry?.sessionId;
    const aborted = sessionId ? abortEmbeddedPiRun(sessionId) : false;
    const cleared = clearSessionQueues([key ?? targetKey, sessionId]);
    if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
      logVerbose(
        `abort: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
      );
    }
    if (entry && key) {
      entry.abortedLastRun = true;
      entry.updatedAt = Date.now();
      store[key] = entry;
      await updateSessionStore(storePath, (nextStore) => {
        const nextEntry = nextStore[key] ?? entry;
        if (!nextEntry) {
          return;
        }
        nextEntry.abortedLastRun = true;
        nextEntry.updatedAt = Date.now();
        nextStore[key] = nextEntry;
      });
    } else if (abortKey) {
      setAbortMemory(abortKey, true);
    }
    return { handled: true, aborted };
  }
  if (abortKey) {
    setAbortMemory(abortKey, true);
  }
  return { handled: true, aborted: false };
}
