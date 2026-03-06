import type { VersoConfig } from "verso/plugin-sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WecomInboundMessage, ResolvedWecomAccount, WecomConfig } from "./types.js";
import { WecomCrypto } from "./crypto.js";
import {
  generateAgentId,
  getDynamicAgentConfig,
  shouldUseDynamicAgent,
  shouldTriggerGroupResponse,
  extractGroupMessageContent,
} from "./dynamic-agent.js";
import { logger } from "./logger.js";
import { getWecomRuntime } from "./runtime.js";
import { streamManager } from "./stream-manager.js";
import {
  THINKING_PLACEHOLDER,
  DEFAULT_COMMAND_ALLOWLIST,
  DEFAULT_COMMAND_BLOCK_MESSAGE,
} from "./types.js";

const MEDIA_CACHE_DIR = join(process.env.HOME || "/tmp", ".verso", "media", "wecom");

// --- Stream context (AsyncLocalStorage) ---
export const streamContext = new AsyncLocalStorage<{ streamId: string; streamKey: string }>();

// --- Active stream tracking ---
const activeStreams = new Map<string, string>();
const activeStreamHistory = new Map<string, string[]>();
const streamMeta = new Map<string, { mainResponseDone: boolean; doneAt: number }>();

// --- Response URL fallback store ---
export const responseUrls = new Map<string, { url: string; expiresAt: number; used: boolean }>();

// --- Per-user dispatch serialization ---
const dispatchLocks = new Map<string, Promise<void>>();

// --- Message debounce ---
const DEBOUNCE_MS = 2000;
const messageBuffers = new Map<
  string,
  {
    messages: WecomInboundMessage[];
    streamIds: string[];
    target: { account: ResolvedWecomAccount; config: VersoConfig };
    timestamp: string;
    nonce: string;
    timer: ReturnType<typeof setTimeout>;
  }
>();

// --- Dynamic agent config write queue ---
const ensuredDynamicAgentIds = new Set<string>();
let ensureDynamicAgentWriteQueue = Promise.resolve();

// --- Periodic cleanup ---
setInterval(() => {
  const now = Date.now();
  for (const streamId of streamMeta.keys()) {
    if (!streamManager.hasStream(streamId)) streamMeta.delete(streamId);
  }
  for (const [key, entry] of responseUrls) {
    if (now > entry.expiresAt) responseUrls.delete(key);
  }
}, 60_000).unref();

// --- Helpers ---

export function registerActiveStream(streamKey: string, streamId: string): void {
  if (!streamKey || !streamId) return;
  const history = activeStreamHistory.get(streamKey) ?? [];
  activeStreamHistory.set(streamKey, [...history.filter((id) => id !== streamId), streamId]);
  activeStreams.set(streamKey, streamId);
}

function unregisterActiveStream(streamKey: string, streamId: string): void {
  if (!streamKey || !streamId) return;
  const history = activeStreamHistory.get(streamKey);
  if (!history?.length) {
    if (activeStreams.get(streamKey) === streamId) activeStreams.delete(streamKey);
    return;
  }
  const remaining = history.filter((id) => id !== streamId);
  if (remaining.length === 0) {
    activeStreamHistory.delete(streamKey);
    activeStreams.delete(streamKey);
  } else {
    activeStreamHistory.set(streamKey, remaining);
    activeStreams.set(streamKey, remaining[remaining.length - 1]);
  }
}

export function resolveActiveStream(streamKey: string): string | null {
  if (!streamKey) return null;
  const history = activeStreamHistory.get(streamKey);
  if (!history?.length) {
    activeStreams.delete(streamKey);
    return null;
  }
  const remaining = history.filter((id) => streamManager.hasStream(id));
  if (remaining.length === 0) {
    activeStreamHistory.delete(streamKey);
    activeStreams.delete(streamKey);
    return null;
  }
  activeStreamHistory.set(streamKey, remaining);
  const latest = remaining[remaining.length - 1];
  activeStreams.set(streamKey, latest);
  return latest;
}

export function getStreamMeta(streamId: string) {
  return streamMeta.get(streamId);
}

export function clearMessageBuffers(): void {
  for (const [, buf] of messageBuffers) clearTimeout(buf.timer);
  messageBuffers.clear();
}

function getMessageStreamKey(message: WecomInboundMessage): string {
  if (message.chatType === "group" && message.chatId) return message.chatId;
  return message.fromUser || "";
}

function getCommandConfig(config: VersoConfig) {
  const wecom = (config?.channels?.wecom || {}) as WecomConfig;
  const commands = wecom.commands || {};
  return {
    allowlist: commands.allowlist || DEFAULT_COMMAND_ALLOWLIST,
    blockMessage: commands.blockMessage || DEFAULT_COMMAND_BLOCK_MESSAGE,
    enabled: commands.enabled !== false,
  };
}

function checkCommandAllowlist(message: string, config: VersoConfig) {
  const trimmed = message.trim();
  if (!trimmed.startsWith("/"))
    return { isCommand: false, allowed: true, command: null as string | null };
  const command = trimmed.split(/\s+/)[0].toLowerCase();
  const cmdConfig = getCommandConfig(config);
  if (!cmdConfig.enabled) return { isCommand: true, allowed: true, command };
  const allowed = cmdConfig.allowlist.some((cmd) => cmd.toLowerCase() === command);
  return { isCommand: true, allowed, command };
}

function isWecomAdmin(userId: string, config: VersoConfig): boolean {
  const raw = (config?.channels?.wecom as WecomConfig)?.adminUsers;
  if (!Array.isArray(raw)) return false;
  const admins = raw
    .map((u) =>
      String(u ?? "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
  return admins.length > 0 && admins.includes(String(userId).trim().toLowerCase());
}

async function handleStreamError(
  streamId: string,
  streamKey: string,
  errorMessage: string,
): Promise<void> {
  if (!streamId) return;
  logger.error("Stream error", { streamId, streamKey, errorMessage });
  const stream = streamManager.getStream(streamId);
  if (stream && !stream.finished) {
    if (stream.content.trim() === THINKING_PLACEHOLDER.trim()) {
      streamManager.replaceIfPlaceholder(streamId, errorMessage, THINKING_PLACEHOLDER);
    }
    await streamManager.finishStream(streamId);
  }
  unregisterActiveStream(streamKey, streamId);
}

function guessMimeType(fileName: string): string {
  const ext = (fileName || "").split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    csv: "text/csv",
    zip: "application/zip",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
  };
  return map[ext] || "application/octet-stream";
}

async function downloadAndDecryptImage(
  imageUrl: string,
  encodingAesKey: string,
  token: string,
): Promise<{ localPath: string; mimeType: string }> {
  if (!existsSync(MEDIA_CACHE_DIR)) mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);
  const encrypted = Buffer.from(await response.arrayBuffer());
  const decrypted = new WecomCrypto(token, encodingAesKey).decryptMedia(encrypted);
  logger.debug("Image decrypted", { size: decrypted.length });

  let ext = "jpg";
  if (decrypted[0] === 0x89 && decrypted[1] === 0x50) ext = "png";
  else if (decrypted[0] === 0x47 && decrypted[1] === 0x49) ext = "gif";

  const filename = `wecom_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
  const localPath = join(MEDIA_CACHE_DIR, filename);
  writeFileSync(localPath, decrypted);
  return {
    localPath,
    mimeType: ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg",
  };
}

async function downloadWecomFile(
  fileUrl: string,
  fileName: string,
  encodingAesKey: string,
  token: string,
): Promise<{ localPath: string; effectiveFileName: string }> {
  if (!existsSync(MEDIA_CACHE_DIR)) mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error(`Failed to download file: ${response.status}`);
  const encrypted = Buffer.from(await response.arrayBuffer());

  let effectiveFileName = fileName;
  if (!effectiveFileName) {
    const cd = response.headers.get("content-disposition");
    const match = cd?.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)["']?/i);
    if (match?.[1]) effectiveFileName = decodeURIComponent(match[1]);
  }

  const decrypted = new WecomCrypto(token, encodingAesKey).decryptMedia(encrypted);
  const safeName = (effectiveFileName || `file_${Date.now()}`).replace(/[/\\:*?"<>|]/g, "_");
  const localPath = join(MEDIA_CACHE_DIR, `${Date.now()}_${safeName}`);
  writeFileSync(localPath, decrypted);
  return { localPath, effectiveFileName: effectiveFileName || fileName };
}

function upsertAgentIdOnlyEntry(cfg: VersoConfig, agentId: string): boolean {
  const normalizedId = String(agentId || "")
    .trim()
    .toLowerCase();
  if (!normalizedId) return false;
  const agents = (cfg as any).agents ?? ((cfg as any).agents = {});
  const currentList: Array<{ id: string }> = Array.isArray(agents.list) ? agents.list : [];
  const existingIds = new Set(currentList.map((e) => e.id?.trim().toLowerCase()).filter(Boolean));
  let changed = false;
  const nextList = [...currentList];
  if (nextList.length === 0) {
    nextList.push({ id: "main" });
    existingIds.add("main");
    changed = true;
  }
  if (!existingIds.has(normalizedId)) {
    nextList.push({ id: normalizedId });
    changed = true;
  }
  if (changed) agents.list = nextList;
  return changed;
}

async function ensureDynamicAgentListed(agentId: string): Promise<void> {
  const normalizedId = String(agentId || "")
    .trim()
    .toLowerCase();
  if (!normalizedId || ensuredDynamicAgentIds.has(normalizedId)) return;

  const runtime = getWecomRuntime();
  const configRuntime = (runtime as any).config;
  if (!configRuntime?.loadConfig || !configRuntime?.writeConfigFile) return;

  ensureDynamicAgentWriteQueue = ensureDynamicAgentWriteQueue
    .then(async () => {
      if (ensuredDynamicAgentIds.has(normalizedId)) return;
      const latestConfig = configRuntime.loadConfig();
      if (!latestConfig) return;
      const changed = upsertAgentIdOnlyEntry(latestConfig, normalizedId);
      if (changed) {
        await configRuntime.writeConfigFile(latestConfig);
        logger.info("Dynamic agent added to agents.list", { agentId: normalizedId });
      }
      // Keep runtime in-memory config aligned to avoid stale reads
      const liveConfig = (runtime as any).config?.cfg;
      if (liveConfig && typeof liveConfig === "object") {
        upsertAgentIdOnlyEntry(liveConfig, normalizedId);
      }
      ensuredDynamicAgentIds.add(normalizedId);
    })
    .catch((err: unknown) => {
      logger.warn("Failed to sync dynamic agent into agents.list", {
        agentId: normalizedId,
        error: (err as Error)?.message || String(err),
      });
    });
  await ensureDynamicAgentWriteQueue;
}

// --- Deliver reply to stream ---

function appendToStream(targetStreamId: string, content: string): boolean {
  const stream = streamManager.getStream(targetStreamId);
  if (!stream) return false;
  if (stream.content.trim() === THINKING_PLACEHOLDER.trim()) {
    streamManager.replaceIfPlaceholder(targetStreamId, content, THINKING_PLACEHOLDER);
    return true;
  }
  if (stream.content.includes(content.trim())) return true; // duplicate suppression
  const separator = stream.content.length > 0 ? "\n\n" : "";
  streamManager.appendStream(targetStreamId, separator + content);
  return true;
}

async function deliverWecomReply(params: {
  payload: { text?: string };
  senderId: string;
  streamId: string;
}): Promise<void> {
  const { payload, senderId, streamId } = params;
  let text = payload.text || "";

  // Handle absolute-path MEDIA lines
  const mediaRegex = /^MEDIA:\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  const mediaMatches: Array<{ fullMatch: string; path: string }> = [];
  while ((match = mediaRegex.exec(text)) !== null) {
    const mediaPath = match[1].trim();
    if (mediaPath.startsWith("/")) mediaMatches.push({ fullMatch: match[0], path: mediaPath });
  }
  if (mediaMatches.length > 0 && streamId) {
    for (const media of mediaMatches) {
      if (streamManager.queueImage(streamId, media.path)) {
        text = text.replace(media.fullMatch, "").trim();
      }
    }
  }

  if (!text.trim()) return;

  if (!streamId) {
    const ctx = streamContext.getStore();
    const activeStreamId = ctx?.streamId ?? resolveActiveStream(senderId);
    if (activeStreamId && streamManager.hasStream(activeStreamId)) {
      appendToStream(activeStreamId, text);
    }
    return;
  }

  if (!streamManager.hasStream(streamId)) {
    // Layer 2: response_url fallback
    const saved = responseUrls.get(senderId);
    if (saved && !saved.used && Date.now() < saved.expiresAt) {
      saved.used = true;
      try {
        await fetch(saved.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ msgtype: "text", text: { content: text } }),
        });
      } catch {
        // Layer 3: lost
      }
    }
    return;
  }

  appendToStream(streamId, text);
}

// --- Debounce flush ---

function flushMessageBuffer(
  streamKey: string,
  target: { account: ResolvedWecomAccount; config: VersoConfig },
): void {
  const buffer = messageBuffers.get(streamKey);
  if (!buffer) return;
  messageBuffers.delete(streamKey);

  const { messages, streamIds } = buffer;
  const primaryStreamId = streamIds[0];
  const primaryMsg = messages[0];

  if (messages.length > 1) {
    primaryMsg.content = messages
      .map((m) => m.content || "")
      .filter(Boolean)
      .join("\n");
    const allImageUrls = messages.flatMap((m) => m.imageUrls || []);
    if (allImageUrls.length > 0) primaryMsg.imageUrls = allImageUrls;
    const singleImages = messages.map((m) => m.imageUrl).filter(Boolean) as string[];
    if (singleImages.length > 0 && !primaryMsg.imageUrl) {
      primaryMsg.imageUrl = singleImages[0];
      if (singleImages.length > 1)
        primaryMsg.imageUrls = [...(primaryMsg.imageUrls || []), ...singleImages.slice(1)];
    }
    for (let i = 1; i < streamIds.length; i++) {
      const extraId = streamIds[i];
      streamManager.replaceIfPlaceholder(
        extraId,
        "消息已合并到第一条回复中。",
        THINKING_PLACEHOLDER,
      );
      void streamManager
        .finishStream(extraId)
        .then(() => unregisterActiveStream(streamKey, extraId));
    }
  }

  processInboundMessage({
    message: primaryMsg,
    streamId: primaryStreamId,
    timestamp: buffer.timestamp,
    nonce: buffer.nonce,
    account: target.account,
    config: target.config,
  }).catch(async (err) => {
    logger.error("Flush dispatch failed", {
      streamKey,
      error: (err as Error)?.message || String(err),
    });
    await handleStreamError(primaryStreamId, streamKey, "处理消息时出错，请稍后再试。");
  });
}

// --- Public API ---

export function bufferOrDispatch(params: {
  message: WecomInboundMessage;
  streamId: string;
  timestamp: string;
  nonce: string;
  account: ResolvedWecomAccount;
  config: VersoConfig;
}): void {
  const { message, streamId, timestamp, nonce, account, config } = params;
  const streamKey = getMessageStreamKey(message);
  const isCommand = (message.content || "").trim().startsWith("/");

  // Commands bypass debounce
  if (isCommand) {
    processInboundMessage({ message, streamId, timestamp, nonce, account, config }).catch(
      async () => {
        await handleStreamError(streamId, streamKey, "处理消息时出错，请稍后再试。");
      },
    );
    return;
  }

  const existing = messageBuffers.get(streamKey);
  if (existing) {
    existing.messages.push(message);
    existing.streamIds.push(streamId);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(
      () => flushMessageBuffer(streamKey, { account, config }),
      DEBOUNCE_MS,
    );
  } else {
    messageBuffers.set(streamKey, {
      messages: [message],
      streamIds: [streamId],
      target: { account, config },
      timestamp,
      nonce,
      timer: setTimeout(() => flushMessageBuffer(streamKey, { account, config }), DEBOUNCE_MS),
    });
  }
}

// --- Core inbound processing ---

async function processInboundMessage(params: {
  message: WecomInboundMessage;
  streamId: string;
  timestamp: string;
  nonce: string;
  account: ResolvedWecomAccount;
  config: VersoConfig;
}): Promise<void> {
  const { message, streamId, account, config } = params;
  const runtime = getWecomRuntime();
  const core = runtime.channel;

  const senderId = message.fromUser;
  const rawContent = message.content || "";
  const imageUrl = message.imageUrl || "";
  const imageUrls = message.imageUrls || [];
  const fileUrl = message.fileUrl || "";
  const fileName = message.fileName || "";
  const chatType = message.chatType || "single";
  const chatId = message.chatId || "";
  const isGroupChat = chatType === "group" && !!chatId;

  const peerId = isGroupChat ? chatId : senderId;
  const peerKind = isGroupChat ? "group" : "dm";
  const conversationId = isGroupChat ? `wecom:group:${chatId}` : `wecom:${senderId}`;

  const streamKey = isGroupChat ? chatId : senderId;
  if (streamId) registerActiveStream(streamKey, streamId);

  logger.info("Processing inbound message", {
    msgId: message.msgId,
    from: senderId,
    chatType,
    chatId: chatId || undefined,
    msgType: message.msgType,
  });

  // Save response_url for fallback
  if (message.responseUrl?.trim()) {
    responseUrls.set(streamKey, {
      url: message.responseUrl,
      expiresAt: Date.now() + 60 * 60 * 1000,
      used: false,
    });
  }

  // Group mention gating
  let rawBody = rawContent;
  if (isGroupChat) {
    if (!shouldTriggerGroupResponse(rawContent, config as unknown as Record<string, unknown>)) {
      if (streamId) {
        streamManager.replaceIfPlaceholder(streamId, "请@提及我以获取回复。", THINKING_PLACEHOLDER);
        await streamManager.finishStream(streamId);
        unregisterActiveStream(streamKey, streamId);
      }
      return;
    }
    rawBody = extractGroupMessageContent(rawContent, config as unknown as Record<string, unknown>);
  }

  const commandAuthorized = resolveWecomCommandAuthorized(config, account.accountId, senderId);

  // Skip empty messages (unless media attached)
  if (!rawBody.trim() && !imageUrl && imageUrls.length === 0 && !fileUrl) {
    if (streamId) {
      await streamManager.finishStream(streamId);
      unregisterActiveStream(streamKey, streamId);
    }
    return;
  }

  // Command allowlist
  const senderIsAdmin = isWecomAdmin(senderId, config);
  const commandCheck = checkCommandAllowlist(rawBody, config);
  if (commandCheck.isCommand && !commandCheck.allowed && !senderIsAdmin) {
    const cmdConfig = getCommandConfig(config);
    if (streamId) {
      streamManager.replaceIfPlaceholder(streamId, cmdConfig.blockMessage, THINKING_PLACEHOLDER);
      await streamManager.finishStream(streamId);
      unregisterActiveStream(streamKey, streamId);
    }
    return;
  }

  // Dynamic agent routing
  const dynamicConfig = getDynamicAgentConfig(
    config as unknown as { channels?: { wecom?: WecomConfig } },
  );
  const targetAgentId =
    !senderIsAdmin &&
    dynamicConfig.enabled &&
    shouldUseDynamicAgent({
      chatType: peerKind,
      config: config as unknown as Record<string, unknown>,
    })
      ? generateAgentId(peerKind, peerId)
      : null;
  if (targetAgentId) await ensureDynamicAgentListed(targetAgentId);

  // Resolve route
  const route = core.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
    peer: { kind: peerKind as "group" | "direct", id: peerId },
  });
  if (targetAgentId) {
    route.agentId = targetAgentId;
    route.sessionKey = `agent:${targetAgentId}:${peerKind}:${peerId}`;
  }

  // Read previous timestamp for envelope
  const storePath = core.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = core.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // Build envelope
  const envelopeOptions = core.reply.resolveEnvelopeFormatOptions(config);
  const senderLabel = isGroupChat ? `[${senderId}]` : senderId;
  const body = core.reply.formatAgentEnvelope({
    channel: isGroupChat ? "Enterprise WeChat Group" : "Enterprise WeChat",
    from: senderLabel,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  // Build context payload
  const ctxBase: Record<string, unknown> = {
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `wecom:${senderId}`,
    To: conversationId,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroupChat ? "group" : "direct",
    ConversationLabel: isGroupChat ? `Group ${chatId}` : senderId,
    SenderName: senderId,
    SenderId: senderId,
    GroupId: isGroupChat ? chatId : undefined,
    Provider: "wecom",
    Surface: "wecom",
    OriginatingChannel: "wecom",
    OriginatingTo: conversationId,
    CommandAuthorized: commandAuthorized,
  };

  // Download + decrypt media
  const allImageUrls = imageUrl ? [imageUrl] : imageUrls;
  if (allImageUrls.length > 0) {
    const mediaPaths: string[] = [];
    const mediaTypes: string[] = [];
    const fallbackUrls: string[] = [];
    for (const url of allImageUrls) {
      try {
        const result = await downloadAndDecryptImage(url, account.encodingAesKey, account.token);
        mediaPaths.push(result.localPath);
        mediaTypes.push(result.mimeType);
      } catch {
        fallbackUrls.push(url);
        mediaTypes.push("image/jpeg");
      }
    }
    if (mediaPaths.length > 0) ctxBase.MediaPaths = mediaPaths;
    if (fallbackUrls.length > 0) ctxBase.MediaUrls = fallbackUrls;
    ctxBase.MediaTypes = mediaTypes;
    if (!rawBody.trim()) {
      const count = allImageUrls.length;
      ctxBase.Body = count > 1 ? `[用户发送了${count}张图片]` : "[用户发送了一张图片]";
      ctxBase.RawBody = "[图片]";
      ctxBase.CommandBody = "";
    }
  }

  // Handle file attachment
  if (fileUrl) {
    try {
      const { localPath, effectiveFileName } = await downloadWecomFile(
        fileUrl,
        fileName,
        account.encodingAesKey,
        account.token,
      );
      ctxBase.MediaPaths = [...((ctxBase.MediaPaths as string[]) || []), localPath];
      ctxBase.MediaTypes = [
        ...((ctxBase.MediaTypes as string[]) || []),
        guessMimeType(effectiveFileName),
      ];
      logger.info("File attachment prepared", { path: localPath, name: effectiveFileName });
    } catch (e: unknown) {
      logger.warn("File download failed", { error: (e as Error)?.message || String(e) });
      const label = fileName ? `[文件: ${fileName}]` : "[文件]";
      if (!rawBody.trim()) {
        ctxBase.Body = `[用户发送了文件] ${label}`;
        ctxBase.RawBody = label;
        ctxBase.CommandBody = "";
      }
    }
    // Fallback: download succeeded but no text body was provided
    if (!rawBody.trim() && !ctxBase.Body) {
      const label = fileName ? `[文件: ${fileName}]` : "[文件]";
      ctxBase.Body = `[用户发送了文件] ${label}`;
      ctxBase.RawBody = label;
      ctxBase.CommandBody = "";
    }
  }

  const ctxPayload = core.reply.finalizeInboundContext(ctxBase);

  // Record session meta (fire-and-forget)
  void core.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err: unknown) => {
      logger.error("Failed updating session meta", {
        error: (err as Error)?.message || String(err),
      });
    });

  // Dispatch with serialization
  const prevLock = dispatchLocks.get(streamKey) ?? Promise.resolve();
  const currentDispatch = prevLock
    .then(async () => {
      await streamContext.run({ streamId, streamKey }, async () => {
        await core.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg: config,
          dispatcherOptions: {
            deliver: async (payload: { text?: string }, info: { kind: string }) => {
              await deliverWecomReply({ payload, senderId: streamKey, streamId });
              if (streamId && info.kind === "final") {
                streamMeta.set(streamId, { mainResponseDone: true, doneAt: Date.now() });
                await streamManager.finishStream(streamId);
              }
            },
            onError: async () => {
              await handleStreamError(streamId, streamKey, "处理消息时出错，请稍后再试。");
            },
          },
        });
      });

      // Safety net for stream cleanup
      if (streamId) {
        const stream = streamManager.getStream(streamId);
        if (!stream || stream.finished) {
          unregisterActiveStream(streamKey, streamId);
        } else {
          setTimeout(async () => {
            const check = streamManager.getStream(streamId);
            if (check && !check.finished && Date.now() - check.updatedAt > 30000) {
              await streamManager.finishStream(streamId);
              unregisterActiveStream(streamKey, streamId);
            }
          }, 35000);
        }
      }
    })
    .catch(async () => {
      await handleStreamError(streamId, streamKey, "处理消息时出错，请稍后再试。");
    });

  dispatchLocks.set(streamKey, currentDispatch);
  await currentDispatch;
  if (dispatchLocks.get(streamKey) === currentDispatch) dispatchLocks.delete(streamKey);
}

function resolveWecomCommandAuthorized(
  cfg: VersoConfig,
  accountId: string,
  senderId: string,
): boolean {
  const sender = String(senderId ?? "")
    .trim()
    .toLowerCase();
  if (!sender) return false;
  const wecom = cfg?.channels?.wecom as WecomConfig | undefined;
  if (!wecom) return true;

  // Multi-path resolution: accounts[accountId] → wecom root
  const normalizedAccountId = String(accountId || "default")
    .trim()
    .toLowerCase();
  const accounts = wecom.accounts;
  const account =
    accounts && typeof accounts === "object"
      ? (accounts[accountId] ??
        accounts[
          Object.keys(accounts).find((key) => key.toLowerCase() === normalizedAccountId) ?? ""
        ])
      : undefined;

  const allowFromRaw =
    account?.dm?.allowFrom ??
    (account as any)?.allowFrom ??
    wecom.dm?.allowFrom ??
    (wecom as any)?.allowFrom ??
    [];

  if (!Array.isArray(allowFromRaw) || allowFromRaw.length === 0) return true;
  const normalized = allowFromRaw
    .map((r) =>
      String(r ?? "")
        .trim()
        .replace(/^(wecom|wework):/i, "")
        .replace(/^user:/i, "")
        .toLowerCase(),
    )
    .filter(Boolean);
  if (normalized.includes("*")) return true;
  return normalized.includes(sender);
}
