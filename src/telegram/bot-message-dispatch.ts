import type { Bot } from "grammy";
import type { VersoConfig, ReplyToMode, TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { TelegramBotOptions } from "./bot.js";
import type { TelegramStreamMode } from "./bot/types.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { EmbeddedBlockChunker } from "../agents/pi-embedded-block-chunker.js";
import { resolveChunkMode } from "../auto-reply/chunk.js";
import { clearHistoryEntriesIfEnabled } from "../auto-reply/reply/history.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { removeAckReactionAfterReply } from "../channels/ack-reactions.js";
import { logAckFailure, logTypingFailure } from "../channels/logging.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import { createTypingCallbacks } from "../channels/typing.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { danger, logVerbose } from "../globals.js";
import { deliverReplies } from "./bot/delivery.js";
import { resolveTelegramDraftStreamingChunking } from "./draft-chunking.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

async function resolveStickerVisionSupport(cfg: VersoConfig, agentId: string) {
  try {
    const catalog = await loadModelCatalog({ config: cfg });
    const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    if (!entry) {
      return false;
    }
    return modelSupportsVision(entry);
  } catch {
    return false;
  }
}

type DispatchTelegramMessageParams = {
  context: TelegramMessageContext;
  bot: Bot;
  cfg: VersoConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  telegramCfg: TelegramAccountConfig;
  opts: Pick<TelegramBotOptions, "token">;
};

export const dispatchTelegramMessage = async ({
  context,
  bot,
  cfg,
  runtime,
  replyToMode,
  streamMode,
  textLimit,
  telegramCfg,
  opts,
}: DispatchTelegramMessageParams) => {
  const {
    ctxPayload,
    msg,
    chatId,
    isGroup,
    threadSpec,
    historyKey,
    historyLimit,
    groupHistories,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
  } = context;

  const isPrivateChat = msg.chat.type === "private";
  const draftMaxChars = Math.min(textLimit, 4096);

  // Enable draft streaming for private chats when streamMode is configured
  const canStreamDraft = streamMode !== "off" && isPrivateChat;
  const draftStream = canStreamDraft
    ? createTelegramDraftStream({
        api: bot.api,
        chatId,
        draftId: msg.message_id || Date.now(),
        maxChars: draftMaxChars,
        thread: threadSpec,
        log: logVerbose,
        warn: logVerbose,
      })
    : undefined;
  const draftChunking =
    draftStream && streamMode === "block"
      ? resolveTelegramDraftStreamingChunking(cfg, route.accountId)
      : undefined;
  const draftChunker = draftChunking ? new EmbeddedBlockChunker(draftChunking) : undefined;
  let lastPartialText = "";
  let draftText = "";
  const updateDraftFromPartial = (text?: string) => {
    if (!draftStream || !text) {
      return;
    }
    if (text === lastPartialText) {
      return;
    }
    if (streamMode === "partial") {
      lastPartialText = text;
      draftStream.update(text);
      return;
    }
    let delta = text;
    if (text.startsWith(lastPartialText)) {
      delta = text.slice(lastPartialText.length);
    } else {
      // Streaming buffer reset (or non-monotonic stream). Start fresh.
      draftChunker?.reset();
      draftText = "";
    }
    lastPartialText = text;
    if (!delta) {
      return;
    }
    if (!draftChunker) {
      draftText = text;
      draftStream.update(draftText);
      return;
    }
    draftChunker.append(delta);
    draftChunker.drain({
      force: false,
      emit: (chunk) => {
        draftText += chunk;
        draftStream.update(draftText);
      },
    });
  };
  const flushDraft = async () => {
    if (!draftStream) {
      return;
    }
    if (draftChunker?.hasBuffered()) {
      draftChunker.drain({
        force: true,
        emit: (chunk) => {
          draftText += chunk;
        },
      });
      draftChunker.reset();
      if (draftText) {
        draftStream.update(draftText);
      }
    }
    await draftStream.flush();
  };

  const disableBlockStreaming =
    Boolean(draftStream) ||
    (typeof telegramCfg.blockStreaming === "boolean" ? !telegramCfg.blockStreaming : undefined);

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "telegram",
    accountId: route.accountId,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: route.accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);

  // Handle uncached stickers: get a dedicated vision description before dispatch
  // This ensures we cache a raw description rather than a conversational response
  const sticker = ctxPayload.Sticker;
  if (sticker?.fileId && sticker.fileUniqueId && ctxPayload.MediaPath) {
    const agentDir = resolveAgentDir(cfg, route.agentId);
    const stickerSupportsVision = await resolveStickerVisionSupport(cfg, route.agentId);
    let description = sticker.cachedDescription ?? null;
    if (!description) {
      description = await describeStickerImage({
        imagePath: ctxPayload.MediaPath,
        cfg,
        agentDir,
        agentId: route.agentId,
      });
    }
    if (description) {
      // Format the description with sticker context
      const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null]
        .filter(Boolean)
        .join(" ");
      const formattedDesc = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;

      sticker.cachedDescription = description;
      if (!stickerSupportsVision) {
        // Update context to use description instead of image
        ctxPayload.Body = formattedDesc;
        ctxPayload.BodyForAgent = formattedDesc;
        // Clear media paths so native vision doesn't process the image again
        ctxPayload.MediaPath = undefined;
        ctxPayload.MediaType = undefined;
        ctxPayload.MediaUrl = undefined;
        ctxPayload.MediaPaths = undefined;
        ctxPayload.MediaUrls = undefined;
        ctxPayload.MediaTypes = undefined;
      }

      // Cache the description for future encounters
      if (sticker.fileId) {
        cacheSticker({
          fileId: sticker.fileId,
          fileUniqueId: sticker.fileUniqueId,
          emoji: sticker.emoji,
          setName: sticker.setName,
          description,
          cachedAt: new Date().toISOString(),
          receivedFrom: ctxPayload.From,
        });
        logVerbose(`telegram: cached sticker description for ${sticker.fileUniqueId}`);
      } else {
        logVerbose(`telegram: skipped sticker cache (missing fileId)`);
      }
    }
  }

  const replyQuoteText =
    ctxPayload.ReplyToIsQuote && ctxPayload.ReplyToBody
      ? ctxPayload.ReplyToBody.trim() || undefined
      : undefined;
  const deliveryState = {
    delivered: false,
    skippedNonSilent: 0,
  };

  const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload, info) => {
        if (info.kind === "final") {
          await flushDraft();
          draftStream?.stop();
        }
        const result = await deliverReplies({
          replies: [payload],
          chatId: String(chatId),
          token: opts.token,
          runtime,
          bot,
          replyToMode,
          textLimit,
          thread: threadSpec,
          tableMode,
          chunkMode,
          onVoiceRecording: sendRecordVoice,
          linkPreview: telegramCfg.linkPreview,
          replyQuoteText,
        });
        if (result.delivered) {
          deliveryState.delivered = true;
        }
      },
      onSkip: (_payload, info) => {
        if (info.reason !== "silent") {
          deliveryState.skippedNonSilent += 1;
        }
      },
      onError: (err, info) => {
        runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
      },
      onReplyStart: createTypingCallbacks({
        start: sendTyping,
        onStartError: (err) => {
          logTypingFailure({
            log: logVerbose,
            channel: "telegram",
            target: String(chatId),
            error: err,
          });
        },
      }).onReplyStart,
    },
    replyOptions: {
      skillFilter,
      disableBlockStreaming,
      onPartialReply: draftStream ? (payload) => updateDraftFromPartial(payload.text) : undefined,
      onModelSelected,
    },
  });
  draftStream?.stop();
  let sentFallback = false;
  if (!deliveryState.delivered && deliveryState.skippedNonSilent > 0) {
    const result = await deliverReplies({
      replies: [{ text: EMPTY_RESPONSE_FALLBACK }],
      chatId: String(chatId),
      token: opts.token,
      runtime,
      bot,
      replyToMode,
      textLimit,
      thread: threadSpec,
      tableMode,
      chunkMode,
      linkPreview: telegramCfg.linkPreview,
      replyQuoteText,
    });
    sentFallback = result.delivered;
  }

  const hasFinalResponse = queuedFinal || sentFallback;
  if (!hasFinalResponse) {
    // Ensure typing indicator is stopped if no reply was sent
    // We can't access the specific controller instance easily here as it's created inside the dispatcher factory,
    // but the dispatcher wrapper should have handled it via onIdle if it ran.
    // However, if no items were enqueued, onIdle might not fire.
    // Since we can't easily reach into the closure to call cleanup(), we assume the
    // typing TTL handler (which we saw in typing.ts) will eventually kill it.
    //
    // BETTER FIX: The `createTypingCallbacks` helper should return a cleanup function we can call.
    // But for now, let's look at `sendTyping`.
    // Actually, checking `bot-message-dispatch.ts` again, `sendTyping` is `context.sendTyping`.
    // In `telegram/bot-message-context.ts`, `sendTyping` returns `typing.startTypingLoop()`.
    // We need access to `typing.cleanup()`.
    //
    // WAIT. `dispatchReplyWithBufferedBlockDispatcher` creates its OWN typing controller inside `getReply` -> `createTypingController`.
    // The `sendTyping` passed here is just the *callback* to actual Telegram API.
    // The *Controller* is internal to `getReply`.
    //
    // If `getReply` returns undefined (no response), `typing.cleanup()` IS called in `getReply.ts` (lines 195, 207, 272).
    // so if `getReply` exited early, typing should stop.
    //
    // Issue: What if `getReply` returns a payload, but it's filtered out (empty text)?
    // Then `reply-dispatcher` is used.
    // In `agent-runner.ts`, `typing.markRunComplete()` is called finally.
    // But `cleanup` only happens if `dispatchIdle` is true.
    // If we have 0 payloads, `buildReplyPayloads` returns empty array.
    // Then `finalizeWithFollowup` is called.
    // The specific code path in `agent-runner.ts`:
    // if (replyPayloads.length === 0) return finalizeWithFollowup(...)
    //
    // It returns *without* calling `signalTypingIfNeeded`?
    // No, `signalTypingIfNeeded` is called later.
    // WAIT. If `replyPayloads.length === 0`, it returns early at line 417.
    // In that case, `pendingToolTasks` are awaited.
    // `typing.markRunComplete()` is called in `finally`.
    // `maybeStopOnIdle` checks `runComplete && dispatchIdle`.
    // `dispatchIdle` is set by `typing.markDispatchIdle()`.
    // Who calls `markDispatchIdle`?
    // `createReplyDispatcherWithTyping` returns a `markDispatchIdle` function.
    // This is passed to `dispatchInboundMessageWithBufferedDispatcher`.
    //
    // If `replyPayloads` is empty, `agent-runner` returns.
    // The `dispatchInbound...` function receives the result.
    // If the result is "no reply", does it call `markDispatchIdle`?
    //
    // Let's modify `src/auto-reply/dispatch.ts` (where `dispatchInbound...` lives) to ensure `markDispatchIdle` is called.
    // But first, let's look at `dispatch.ts`.

    if (isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({ historyMap: groupHistories, historyKey, limit: historyLimit });
    }
    return;
  }
  removeAckReactionAfterReply({
    removeAfterReply: removeAckAfterReply,
    ackReactionPromise,
    ackReactionValue: ackReactionPromise ? "ack" : null,
    remove: () => reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve(),
    onError: (err) => {
      if (!msg.message_id) {
        return;
      }
      logAckFailure({
        log: logVerbose,
        channel: "telegram",
        target: `${chatId}/${msg.message_id}`,
        error: err,
      });
    },
  });
  if (isGroup && historyKey) {
    clearHistoryEntriesIfEnabled({ historyMap: groupHistories, historyKey, limit: historyLimit });
  }
};
