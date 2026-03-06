import { getChannelPlugin } from "../../channels/plugins/index.js";
import { recordSessionMetaFromInbound, resolveStorePath } from "../../config/sessions.js";
import { parseDiscordTarget } from "../../discord/targets.js";
import { buildAgentSessionKey } from "../../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../../routing/session-key.js";
import { resolveSlackAccount } from "../../slack/accounts.js";
import { createSlackWebClient } from "../../slack/client.js";
import { normalizeAllowListLower } from "../../slack/monitor/allow-list.js";
import { parseSlackTarget } from "../../slack/targets.js";
import { buildTelegramGroupPeerId } from "../../telegram/bot/helpers.js";
import { resolveTelegramTargetChatType } from "../../telegram/inline-buttons.js";
import { parseTelegramTarget } from "../../telegram/targets.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "../../whatsapp/normalize.js";
// Cache Slack channel type lookups to avoid repeated API calls.
const SLACK_CHANNEL_TYPE_CACHE = new Map();
function normalizeThreadId(value) {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return undefined;
    }
    return String(Math.trunc(value));
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
function stripProviderPrefix(raw, channel) {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  const prefix = `${channel.toLowerCase()}:`;
  if (lower.startsWith(prefix)) {
    return trimmed.slice(prefix.length).trim();
  }
  return trimmed;
}
function stripKindPrefix(raw) {
  return raw.replace(/^(user|channel|group|conversation|room|dm):/i, "").trim();
}
function inferPeerKind(params) {
  const resolvedKind = params.resolvedTarget?.kind;
  if (resolvedKind === "user") {
    return "direct";
  }
  if (resolvedKind === "channel") {
    return "channel";
  }
  if (resolvedKind === "group") {
    const plugin = getChannelPlugin(params.channel);
    const chatTypes = plugin?.capabilities?.chatTypes ?? [];
    const supportsChannel = chatTypes.includes("channel");
    const supportsGroup = chatTypes.includes("group");
    if (supportsChannel && !supportsGroup) {
      return "channel";
    }
    return "group";
  }
  return "direct";
}
function buildBaseSessionKey(params) {
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
    dmScope: params.cfg.session?.dmScope ?? "main",
    identityLinks: params.cfg.session?.identityLinks,
  });
}
// Best-effort mpim detection: allowlist/config, then Slack API (if token available).
async function resolveSlackChannelType(params) {
  const channelId = params.channelId.trim();
  if (!channelId) {
    return "unknown";
  }
  const cached = SLACK_CHANNEL_TYPE_CACHE.get(`${params.accountId ?? "default"}:${channelId}`);
  if (cached) {
    return cached;
  }
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  const groupChannels = normalizeAllowListLower(account.dm?.groupChannels);
  const channelIdLower = channelId.toLowerCase();
  if (
    groupChannels.includes(channelIdLower) ||
    groupChannels.includes(`slack:${channelIdLower}`) ||
    groupChannels.includes(`channel:${channelIdLower}`) ||
    groupChannels.includes(`group:${channelIdLower}`) ||
    groupChannels.includes(`mpim:${channelIdLower}`)
  ) {
    SLACK_CHANNEL_TYPE_CACHE.set(`${account.accountId}:${channelId}`, "group");
    return "group";
  }
  const channelKeys = Object.keys(account.channels ?? {});
  if (
    channelKeys.some((key) => {
      const normalized = key.trim().toLowerCase();
      return (
        normalized === channelIdLower ||
        normalized === `channel:${channelIdLower}` ||
        normalized.replace(/^#/, "") === channelIdLower
      );
    })
  ) {
    SLACK_CHANNEL_TYPE_CACHE.set(`${account.accountId}:${channelId}`, "channel");
    return "channel";
  }
  const token =
    account.botToken?.trim() ||
    (typeof account.config.userToken === "string" ? account.config.userToken.trim() : "");
  if (!token) {
    SLACK_CHANNEL_TYPE_CACHE.set(`${account.accountId}:${channelId}`, "unknown");
    return "unknown";
  }
  try {
    const client = createSlackWebClient(token);
    const info = await client.conversations.info({ channel: channelId });
    const channel = info.channel;
    const type = channel?.is_im ? "dm" : channel?.is_mpim ? "group" : "channel";
    SLACK_CHANNEL_TYPE_CACHE.set(`${account.accountId}:${channelId}`, type);
    return type;
  } catch {
    SLACK_CHANNEL_TYPE_CACHE.set(`${account.accountId}:${channelId}`, "unknown");
    return "unknown";
  }
}
async function resolveSlackSession(params) {
  const parsed = parseSlackTarget(params.target, { defaultKind: "channel" });
  if (!parsed) {
    return null;
  }
  const isDm = parsed.kind === "user";
  let peerKind = isDm ? "direct" : "channel";
  if (!isDm && /^G/i.test(parsed.id)) {
    // Slack mpim/group DMs share the G-prefix; detect to align session keys with inbound.
    const channelType = await resolveSlackChannelType({
      cfg: params.cfg,
      accountId: params.accountId,
      channelId: parsed.id,
    });
    if (channelType === "group") {
      peerKind = "group";
    }
    if (channelType === "dm") {
      peerKind = "direct";
    }
  }
  const peer = {
    kind: peerKind,
    id: parsed.id,
  };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "slack",
    accountId: params.accountId,
    peer,
  });
  const threadId = normalizeThreadId(params.threadId ?? params.replyToId);
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId,
  });
  return {
    sessionKey: threadKeys.sessionKey,
    baseSessionKey,
    peer,
    chatType: peerKind === "direct" ? "direct" : "channel",
    from:
      peerKind === "direct"
        ? `slack:${parsed.id}`
        : peerKind === "group"
          ? `slack:group:${parsed.id}`
          : `slack:channel:${parsed.id}`,
    to: peerKind === "direct" ? `user:${parsed.id}` : `channel:${parsed.id}`,
    threadId,
  };
}
function resolveDiscordSession(params) {
  const parsed = parseDiscordTarget(params.target, { defaultKind: "channel" });
  if (!parsed) {
    return null;
  }
  const isDm = parsed.kind === "user";
  const peer = {
    kind: isDm ? "direct" : "channel",
    id: parsed.id,
  };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "discord",
    accountId: params.accountId,
    peer,
  });
  const explicitThreadId = normalizeThreadId(params.threadId);
  const threadCandidate = explicitThreadId ?? normalizeThreadId(params.replyToId);
  // Discord threads use their own channel id; avoid adding a :thread suffix.
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId: threadCandidate,
    useSuffix: false,
  });
  return {
    sessionKey: threadKeys.sessionKey,
    baseSessionKey,
    peer,
    chatType: isDm ? "direct" : "channel",
    from: isDm ? `discord:${parsed.id}` : `discord:channel:${parsed.id}`,
    to: isDm ? `user:${parsed.id}` : `channel:${parsed.id}`,
    threadId: explicitThreadId ?? undefined,
  };
}
function resolveTelegramSession(params) {
  const parsed = parseTelegramTarget(params.target);
  const chatId = parsed.chatId.trim();
  if (!chatId) {
    return null;
  }
  const parsedThreadId = parsed.messageThreadId;
  const fallbackThreadId = normalizeThreadId(params.threadId);
  const resolvedThreadId =
    parsedThreadId ?? (fallbackThreadId ? Number.parseInt(fallbackThreadId, 10) : undefined);
  // Telegram topics are encoded in the peer id (chatId:topic:<id>).
  const chatType = resolveTelegramTargetChatType(params.target);
  // If the target is a username and we lack a resolvedTarget, default to DM to avoid group keys.
  const isGroup =
    chatType === "group" ||
    (chatType === "unknown" &&
      params.resolvedTarget?.kind &&
      params.resolvedTarget.kind !== "user");
  const peerId = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : chatId;
  const peer = {
    kind: isGroup ? "group" : "direct",
    id: peerId,
  };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "telegram",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `telegram:group:${peerId}` : `telegram:${chatId}`,
    to: `telegram:${chatId}`,
    threadId: resolvedThreadId,
  };
}
function resolveWhatsAppSession(params) {
  const normalized = normalizeWhatsAppTarget(params.target);
  if (!normalized) {
    return null;
  }
  const isGroup = isWhatsAppGroupJid(normalized);
  const peer = {
    kind: isGroup ? "group" : "direct",
    id: normalized,
  };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "whatsapp",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isGroup ? "group" : "direct",
    from: normalized,
    to: normalized,
  };
}
/**
 * Feishu ID formats:
 * - oc_xxx: chat_id (group chat)
 * - ou_xxx: user open_id (DM)
 * - on_xxx: user union_id (DM)
 * - cli_xxx: app_id (not a valid send target)
 */
function resolveFeishuSession(params) {
  let trimmed = stripProviderPrefix(params.target, "feishu");
  trimmed = stripProviderPrefix(trimmed, "lark").trim();
  if (!trimmed) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  let isGroup = false;
  if (lower.startsWith("group:") || lower.startsWith("chat:")) {
    trimmed = trimmed.replace(/^(group|chat):/i, "").trim();
    isGroup = true;
  } else if (lower.startsWith("user:") || lower.startsWith("dm:")) {
    trimmed = trimmed.replace(/^(user|dm):/i, "").trim();
    isGroup = false;
  }
  const idLower = trimmed.toLowerCase();
  if (idLower.startsWith("oc_")) {
    isGroup = true;
  } else if (idLower.startsWith("ou_") || idLower.startsWith("on_")) {
    isGroup = false;
  }
  const peer = {
    kind: isGroup ? "group" : "direct",
    id: trimmed,
  };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "feishu",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `feishu:group:${trimmed}` : `feishu:${trimmed}`,
    to: trimmed,
  };
}
function resolveFallbackSession(params) {
  const trimmed = stripProviderPrefix(params.target, params.channel).trim();
  if (!trimmed) {
    return null;
  }
  const peerKind = inferPeerKind({
    channel: params.channel,
    resolvedTarget: params.resolvedTarget,
  });
  const peerId = stripKindPrefix(trimmed);
  if (!peerId) {
    return null;
  }
  const peer = { kind: peerKind, id: peerId };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    peer,
  });
  const chatType = peerKind === "direct" ? "direct" : peerKind === "channel" ? "channel" : "group";
  const from =
    peerKind === "direct"
      ? `${params.channel}:${peerId}`
      : `${params.channel}:${peerKind}:${peerId}`;
  const toPrefix = peerKind === "direct" ? "user" : "channel";
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType,
    from,
    to: `${toPrefix}:${peerId}`,
  };
}
export async function resolveOutboundSessionRoute(params) {
  const target = params.target.trim();
  if (!target) {
    return null;
  }
  switch (params.channel) {
    case "slack":
      return await resolveSlackSession({ ...params, target });
    case "discord":
      return resolveDiscordSession({ ...params, target });
    case "telegram":
      return resolveTelegramSession({ ...params, target });
    case "whatsapp":
      return resolveWhatsAppSession({ ...params, target });
    case "feishu":
      return resolveFeishuSession({ ...params, target });
    default:
      return resolveFallbackSession({ ...params, target });
  }
}
export async function ensureOutboundSessionEntry(params) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const ctx = {
    From: params.route.from,
    To: params.route.to,
    SessionKey: params.route.sessionKey,
    AccountId: params.accountId ?? undefined,
    ChatType: params.route.chatType,
    Provider: params.channel,
    Surface: params.channel,
    MessageThreadId: params.route.threadId,
    OriginatingChannel: params.channel,
    OriginatingTo: params.route.to,
  };
  try {
    await recordSessionMetaFromInbound({
      storePath,
      sessionKey: params.route.sessionKey,
      ctx,
    });
  } catch {
    // Do not block outbound sends on session meta writes.
  }
}
