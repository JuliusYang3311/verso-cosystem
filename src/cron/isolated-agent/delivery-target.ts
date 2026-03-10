import type { ChannelId } from "../../channels/plugins/types.js";
import type { VersoConfig } from "../../config/config.js";
import type { OutboundChannel } from "../../infra/outbound/targets.js";
import { DEFAULT_CHAT_CHANNEL } from "../../channels/registry.js";
import {
  loadSessionStore,
  resolveAgentMainSessionKey,
  resolveStorePath,
} from "../../config/sessions.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import {
  resolveOutboundTarget,
  resolveSessionDeliveryTarget,
} from "../../infra/outbound/targets.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";

export async function resolveDeliveryTarget(
  cfg: VersoConfig,
  agentId: string,
  jobPayload: {
    channel?: "last" | ChannelId;
    to?: string;
  },
): Promise<{
  channel: Exclude<OutboundChannel, "none">;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  mode: "explicit" | "implicit";
  error?: Error;
}> {
  const requestedChannel = typeof jobPayload.channel === "string" ? jobPayload.channel : "last";
  const explicitTo = typeof jobPayload.to === "string" ? jobPayload.to : undefined;
  const allowMismatchedLastTo = requestedChannel === "last";

  const sessionCfg = cfg.session;
  const mainSessionKey = resolveAgentMainSessionKey({ cfg, agentId });
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const store = loadSessionStore(storePath);
  const main = store[mainSessionKey];

  const preliminary = resolveSessionDeliveryTarget({
    entry: main,
    requestedChannel,
    explicitTo,
    allowMismatchedLastTo,
  });

  let fallbackChannel: Exclude<OutboundChannel, "none"> | undefined;
  if (!preliminary.channel) {
    try {
      const selection = await resolveMessageChannelSelection({ cfg });
      fallbackChannel = selection.channel;
    } catch {
      fallbackChannel = preliminary.lastChannel ?? DEFAULT_CHAT_CHANNEL;
    }
  }

  const resolved = fallbackChannel
    ? resolveSessionDeliveryTarget({
        entry: main,
        requestedChannel,
        explicitTo,
        fallbackChannel,
        allowMismatchedLastTo,
        mode: preliminary.mode,
      })
    : preliminary;

  const channel = resolved.channel ?? fallbackChannel ?? DEFAULT_CHAT_CHANNEL;
  const mode = resolved.mode as "explicit" | "implicit";
  const toCandidate = resolved.to;

  // Only carry threadId when delivering to the same recipient as the session's
  // last conversation. This prevents stale thread IDs (e.g. from a Telegram
  // supergroup topic) from being sent to a different target (e.g. a private
  // chat) where they would cause API errors.
  const threadId =
    resolved.threadId && resolved.to && resolved.to === resolved.lastTo
      ? resolved.threadId
      : undefined;

  if (!toCandidate) {
    return {
      channel,
      to: undefined,
      accountId: resolved.accountId,
      threadId,
      mode,
    };
  }

  const docked = resolveOutboundTarget({
    channel,
    to: toCandidate,
    cfg,
    accountId: resolved.accountId,
    mode,
  });
  return {
    channel,
    to: docked.ok ? docked.to : undefined,
    accountId: resolved.accountId,
    threadId,
    mode,
    error: docked.ok ? undefined : docked.error,
  };
}

// ---------------------------------------------------------------------------
// Unified auto-detect: session store → session key parse → null
// ---------------------------------------------------------------------------

function stripThreadSuffix(sessionKey: string): string {
  const idx = sessionKey.toLowerCase().lastIndexOf(":thread:");
  if (idx <= 0) return sessionKey;
  const parent = sessionKey.slice(0, idx).trim();
  return parent || sessionKey;
}

function inferFromSessionKey(agentSessionKey: string): { channel?: string; to: string } | null {
  const parsed = parseAgentSessionKey(stripThreadSuffix(agentSessionKey));
  if (!parsed?.rest) return null;

  const parts = parsed.rest.split(":").filter(Boolean);
  if (parts.length === 0) return null;

  const head = parts[0]?.trim().toLowerCase();
  if (!head || head === "main" || head === "subagent" || head === "acp") return null;

  const markerIndex = parts.findIndex(
    (p) => p === "direct" || p === "dm" || p === "group" || p === "channel",
  );
  if (markerIndex === -1) return null;

  const peerId = parts
    .slice(markerIndex + 1)
    .join(":")
    .trim();
  if (!peerId) return null;

  const channel = markerIndex >= 1 ? parts[0]?.trim().toLowerCase() : undefined;
  return { channel, to: peerId };
}

/**
 * Unified delivery auto-detection.
 *
 * 1. Try `resolveDeliveryTarget` (session store lookup) — robust, handles account IDs
 * 2. Fall back to session key parsing — works when session store hasn't recorded a route yet
 * 3. Returns null if neither yields a usable target
 */
export async function autoDetectDelivery(
  cfg: VersoConfig | undefined,
  agentId: string,
  agentSessionKey?: string,
): Promise<{ channel: string; to: string } | null> {
  // Primary: session store lookup
  if (cfg) {
    try {
      const target = await resolveDeliveryTarget(cfg, agentId, { channel: "last" });
      if (target.channel && target.to) {
        return { channel: target.channel, to: target.to };
      }
    } catch {
      // Fall through to session key parsing
    }
  }

  // Fallback: parse the session key (e.g. agent:main:telegram:direct:12345)
  if (agentSessionKey) {
    const inferred = inferFromSessionKey(agentSessionKey);
    if (inferred?.to) {
      return { channel: inferred.channel ?? DEFAULT_CHAT_CHANNEL, to: inferred.to };
    }
  }

  return null;
}
