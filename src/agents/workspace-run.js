import { redactIdentifier } from "../logging/redact-identifier.js";
import {
  classifySessionKeyShape,
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope.js";
function resolveRunAgentId(params) {
  const rawSessionKey = params.sessionKey?.trim() ?? "";
  const shape = classifySessionKeyShape(rawSessionKey);
  if (shape === "malformed_agent") {
    throw new Error("Malformed agent session key; refusing workspace resolution.");
  }
  const explicit =
    typeof params.agentId === "string" && params.agentId.trim()
      ? normalizeAgentId(params.agentId)
      : undefined;
  if (explicit) {
    return { agentId: explicit, agentIdSource: "explicit" };
  }
  const defaultAgentId = resolveDefaultAgentId(params.config ?? {});
  if (shape === "missing" || shape === "legacy_or_alias") {
    return {
      agentId: defaultAgentId || DEFAULT_AGENT_ID,
      agentIdSource: "default",
    };
  }
  const parsed = parseAgentSessionKey(rawSessionKey);
  if (parsed?.agentId) {
    return {
      agentId: normalizeAgentId(parsed.agentId),
      agentIdSource: "session_key",
    };
  }
  // Defensive fallback, should be unreachable for non-malformed shapes.
  return {
    agentId: defaultAgentId || DEFAULT_AGENT_ID,
    agentIdSource: "default",
  };
}
export function redactRunIdentifier(value) {
  return redactIdentifier(value, { len: 12 });
}
export function resolveRunWorkspaceDir(params) {
  const requested = params.workspaceDir;
  const { agentId, agentIdSource } = resolveRunAgentId({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  if (typeof requested === "string") {
    const trimmed = requested.trim();
    if (trimmed) {
      return {
        workspaceDir: resolveUserPath(trimmed),
        usedFallback: false,
        agentId,
        agentIdSource,
      };
    }
  }
  const fallbackReason =
    requested == null ? "missing" : typeof requested === "string" ? "blank" : "invalid_type";
  const fallbackWorkspace = resolveAgentWorkspaceDir(params.config ?? {}, agentId);
  return {
    workspaceDir: resolveUserPath(fallbackWorkspace),
    usedFallback: true,
    fallbackReason,
    agentId,
    agentIdSource,
  };
}
