import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  isEmbeddedPiRunActive,
  isDispatchPending,
  markDispatchPending,
  clearDispatchPending,
  queueEmbeddedPiMessage,
  queuePendingMessage,
} from "../../agents/pi-embedded-runner/runs.js";
import { loadSessionStore, resolveStorePath } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import {
  logMessageProcessed,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { maybeApplyTtsToPayload, normalizeTtsAutoMode, resolveTtsConfig } from "../../tts/tts.js";
import { getReplyFromConfig } from "../reply.js";
import { formatAbortReplyText, tryFastAbortFromMessage } from "./abort.js";
import { shouldSkipDuplicateInbound } from "./inbound-dedupe.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
const AUDIO_PLACEHOLDER_RE = /^<media:audio>(\s*\([^)]*\))?$/i;
const AUDIO_HEADER_RE = /^\[Audio\b/i;
const normalizeMediaType = (value) => value.split(";")[0]?.trim().toLowerCase();
const isInboundAudioContext = (ctx) => {
  const rawTypes = [
    typeof ctx.MediaType === "string" ? ctx.MediaType : undefined,
    ...(Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : []),
  ].filter(Boolean);
  const types = rawTypes.map((type) => normalizeMediaType(type));
  if (types.some((type) => type === "audio" || type.startsWith("audio/"))) {
    return true;
  }
  const body =
    typeof ctx.BodyForCommands === "string"
      ? ctx.BodyForCommands
      : typeof ctx.CommandBody === "string"
        ? ctx.CommandBody
        : typeof ctx.RawBody === "string"
          ? ctx.RawBody
          : typeof ctx.Body === "string"
            ? ctx.Body
            : "";
  const trimmed = body.trim();
  if (!trimmed) {
    return false;
  }
  if (AUDIO_PLACEHOLDER_RE.test(trimmed)) {
    return true;
  }
  return AUDIO_HEADER_RE.test(trimmed);
};
const resolveSessionTtsAuto = (ctx, cfg) => {
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const sessionKey = (targetSessionKey ?? ctx.SessionKey)?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  try {
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey.toLowerCase()] ?? store[sessionKey];
    return normalizeTtsAutoMode(entry?.ttsAuto);
  } catch {
    return undefined;
  }
};
async function routePayloadToOriginating(turnCtx, payload, abortSignal, mirror) {
  const { originatingChannel, originatingTo, ctx, cfg } = turnCtx;
  if (!originatingChannel || !originatingTo) {
    return;
  }
  if (abortSignal?.aborted) {
    return;
  }
  const result = await routeReply({
    payload,
    channel: originatingChannel,
    to: originatingTo,
    sessionKey: ctx.SessionKey,
    accountId: ctx.AccountId,
    threadId: ctx.MessageThreadId,
    cfg,
    abortSignal,
    mirror,
  });
  if (!result.ok) {
    logVerbose(`dispatch-from-config: route-reply failed: ${result.error ?? "unknown error"}`);
  }
}
function buildTurnReplyCallbacks(turnCtx) {
  return {
    onToolResult: turnCtx.shouldSendToolSummaries
      ? (payload) => {
          const run = async () => {
            const ttsPayload = await maybeApplyTtsToPayload({
              payload,
              cfg: turnCtx.cfg,
              channel: turnCtx.ttsChannel,
              kind: "tool",
              inboundAudio: turnCtx.inboundAudio,
              ttsAuto: turnCtx.sessionTtsAuto,
            });
            if (turnCtx.shouldRouteToOriginating) {
              await routePayloadToOriginating(turnCtx, ttsPayload, undefined, false);
            } else {
              turnCtx.dispatcher.sendToolResult(ttsPayload);
            }
          };
          return run();
        }
      : undefined,
    onBlockReply: (payload, context) => {
      const run = async () => {
        const ttsPayload = await maybeApplyTtsToPayload({
          payload,
          cfg: turnCtx.cfg,
          channel: turnCtx.ttsChannel,
          kind: "block",
          inboundAudio: turnCtx.inboundAudio,
          ttsAuto: turnCtx.sessionTtsAuto,
        });
        if (turnCtx.shouldRouteToOriginating) {
          await routePayloadToOriginating(turnCtx, ttsPayload, context?.abortSignal, false);
        } else {
          turnCtx.dispatcher.sendBlockReply(ttsPayload);
        }
      };
      return run();
    },
  };
}
async function deliverTurnReplies(turnCtx, replyResult) {
  const replies = replyResult ? (Array.isArray(replyResult) ? replyResult : [replyResult]) : [];
  for (const reply of replies) {
    const ttsReply = await maybeApplyTtsToPayload({
      payload: reply,
      cfg: turnCtx.cfg,
      channel: turnCtx.ttsChannel,
      kind: "final",
      inboundAudio: turnCtx.inboundAudio,
      ttsAuto: turnCtx.sessionTtsAuto,
    });
    if (turnCtx.shouldRouteToOriginating && turnCtx.originatingChannel && turnCtx.originatingTo) {
      await routeReply({
        payload: ttsReply,
        channel: turnCtx.originatingChannel,
        to: turnCtx.originatingTo,
        sessionKey: turnCtx.ctx.SessionKey,
        accountId: turnCtx.ctx.AccountId,
        threadId: turnCtx.ctx.MessageThreadId,
        cfg: turnCtx.cfg,
      });
    } else {
      turnCtx.dispatcher.sendFinalReply(ttsReply);
    }
  }
}
async function runAsyncAgentTurn(turnCtx) {
  try {
    const callbacks = buildTurnReplyCallbacks(turnCtx);
    const result = await turnCtx.replyResolver(
      turnCtx.ctx,
      { ...turnCtx.replyOptions, ...callbacks },
      turnCtx.cfg,
    );
    await deliverTurnReplies(turnCtx, result);
  } catch (err) {
    logVerbose(
      `dispatch-from-config: async agent turn error: ${err instanceof Error ? err.message : String(err)}`,
    );
    try {
      const errorPayload = {
        text: `Error processing your message: ${err instanceof Error ? err.message : String(err)}`,
      };
      if (turnCtx.shouldRouteToOriginating && turnCtx.originatingChannel && turnCtx.originatingTo) {
        await routeReply({
          payload: errorPayload,
          channel: turnCtx.originatingChannel,
          to: turnCtx.originatingTo,
          sessionKey: turnCtx.ctx.SessionKey,
          accountId: turnCtx.ctx.AccountId,
          threadId: turnCtx.ctx.MessageThreadId,
          cfg: turnCtx.cfg,
        });
      } else {
        turnCtx.dispatcher.sendFinalReply(errorPayload);
      }
    } catch (deliveryErr) {
      logVerbose(`dispatch-from-config: failed to deliver error: ${String(deliveryErr)}`);
    }
  } finally {
    // Clean up pending dispatch state — either setActiveEmbeddedRun already
    // drained it, or the turn ended without ever registering.
    clearDispatchPending(turnCtx.sessionIdForRuns);
  }
}
export async function dispatchReplyFromConfig(params) {
  const { ctx, cfg, dispatcher } = params;
  const diagnosticsEnabled = isDiagnosticsEnabled(cfg);
  const channel = String(ctx.Surface ?? ctx.Provider ?? "unknown").toLowerCase();
  const chatId = ctx.To ?? ctx.From;
  const messageId = ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const sessionKey = ctx.SessionKey;
  const startTime = diagnosticsEnabled ? Date.now() : 0;
  const canTrackSession = diagnosticsEnabled && Boolean(sessionKey);
  const recordProcessed = (outcome, opts) => {
    if (!diagnosticsEnabled) {
      return;
    }
    logMessageProcessed({
      channel,
      chatId,
      messageId,
      sessionKey,
      durationMs: Date.now() - startTime,
      outcome,
      reason: opts?.reason,
      error: opts?.error,
    });
  };
  const markProcessing = () => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logMessageQueued({ sessionKey, channel, source: "dispatch" });
    logSessionStateChange({
      sessionKey,
      state: "processing",
      reason: "message_start",
    });
  };
  const markIdle = (reason) => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logSessionStateChange({
      sessionKey,
      state: "idle",
      reason,
    });
  };
  if (shouldSkipDuplicateInbound(ctx)) {
    recordProcessed("skipped", { reason: "duplicate" });
    return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
  }
  const inboundAudio = isInboundAudioContext(ctx);
  const sessionTtsAuto = resolveSessionTtsAuto(ctx, cfg);
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("message_received")) {
    const timestamp =
      typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp)
        ? ctx.Timestamp
        : undefined;
    const messageIdForHook =
      ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
    const content =
      typeof ctx.BodyForCommands === "string"
        ? ctx.BodyForCommands
        : typeof ctx.RawBody === "string"
          ? ctx.RawBody
          : typeof ctx.Body === "string"
            ? ctx.Body
            : "";
    const channelId = (ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "").toLowerCase();
    const conversationId = ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? undefined;
    void hookRunner
      .runMessageReceived(
        {
          from: ctx.From ?? "",
          content,
          timestamp,
          metadata: {
            to: ctx.To,
            provider: ctx.Provider,
            surface: ctx.Surface,
            threadId: ctx.MessageThreadId,
            originatingChannel: ctx.OriginatingChannel,
            originatingTo: ctx.OriginatingTo,
            messageId: messageIdForHook,
            senderId: ctx.SenderId,
            senderName: ctx.SenderName,
            senderUsername: ctx.SenderUsername,
            senderE164: ctx.SenderE164,
          },
        },
        {
          channelId,
          accountId: ctx.AccountId,
          conversationId,
        },
      )
      .catch((err) => {
        logVerbose(`dispatch-from-config: message_received hook failed: ${String(err)}`);
      });
  }
  // Check if we should route replies to originating channel instead of dispatcher.
  // Only route when the originating channel is DIFFERENT from the current surface.
  // This handles cross-provider routing (e.g., message from Telegram being processed
  // by a shared session that's currently on Slack) while preserving normal dispatcher
  // flow when the provider handles its own messages.
  //
  // Debug: `pnpm test src/auto-reply/reply/dispatch-from-config.test.ts`
  const originatingChannel = ctx.OriginatingChannel;
  const originatingTo = ctx.OriginatingTo;
  const currentSurface = (ctx.Surface ?? ctx.Provider)?.toLowerCase();
  const shouldRouteToOriginating =
    isRoutableChannel(originatingChannel) && originatingTo && originatingChannel !== currentSurface;
  const ttsChannel = shouldRouteToOriginating ? originatingChannel : currentSurface;
  /**
   * Helper to send a payload via route-reply (async).
   * Only used when actually routing to a different provider.
   * Note: Only called when shouldRouteToOriginating is true, so
   * originatingChannel and originatingTo are guaranteed to be defined.
   */
  const sendPayloadAsync = async (payload, abortSignal, mirror) => {
    // TypeScript doesn't narrow these from the shouldRouteToOriginating check,
    // but they're guaranteed non-null when this function is called.
    if (!originatingChannel || !originatingTo) {
      return;
    }
    if (abortSignal?.aborted) {
      return;
    }
    const result = await routeReply({
      payload,
      channel: originatingChannel,
      to: originatingTo,
      sessionKey: ctx.SessionKey,
      accountId: ctx.AccountId,
      threadId: ctx.MessageThreadId,
      cfg,
      abortSignal,
      mirror,
    });
    if (!result.ok) {
      logVerbose(`dispatch-from-config: route-reply failed: ${result.error ?? "unknown error"}`);
    }
  };
  markProcessing();
  try {
    const fastAbort = await tryFastAbortFromMessage({ ctx, cfg });
    if (fastAbort.handled) {
      const payload = {
        text: formatAbortReplyText(),
      };
      let queuedFinal = false;
      let routedFinalCount = 0;
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        const result = await routeReply({
          payload,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: ctx.SessionKey,
          accountId: ctx.AccountId,
          threadId: ctx.MessageThreadId,
          cfg,
        });
        queuedFinal = result.ok;
        if (result.ok) {
          routedFinalCount += 1;
        }
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (abort) failed: ${result.error ?? "unknown error"}`,
          );
        }
      } else {
        queuedFinal = dispatcher.sendFinalReply(payload);
      }
      await dispatcher.waitForIdle();
      const counts = dispatcher.getQueuedCounts();
      counts.final += routedFinalCount;
      recordProcessed("completed", { reason: "fast_abort" });
      markIdle("message_completed");
      return { queuedFinal, counts };
    }
    // Track accumulated block text for TTS generation after streaming completes.
    // When block streaming succeeds, there's no final reply, so we need to generate
    // TTS audio separately from the accumulated block content.
    let accumulatedBlockText = "";
    let blockCount = 0;
    const shouldSendToolSummaries = ctx.ChatType !== "group" && ctx.CommandSource !== "native";
    // Check if async dispatch is enabled for this agent.
    const agentId = resolveSessionAgentId({ sessionKey: ctx.SessionKey, config: cfg });
    const asyncDispatchEnabled = cfg.agents?.defaults?.asyncDispatch !== false;
    const sessionIdForRuns = ctx.SessionKey ?? agentId;
    // Async dispatch mode: check if there's an active run and steer or fire-and-forget.
    if (asyncDispatchEnabled && sessionIdForRuns) {
      const turnCtx = {
        ctx,
        cfg,
        dispatcher,
        ttsChannel,
        inboundAudio,
        sessionTtsAuto,
        shouldRouteToOriginating,
        originatingChannel,
        originatingTo,
        shouldSendToolSummaries,
        sessionIdForRuns,
        replyResolver: params.replyResolver ?? getReplyFromConfig,
        replyOptions: params.replyOptions,
      };
      const hasActiveRun = isEmbeddedPiRunActive(sessionIdForRuns);
      const hasPendingDispatch = isDispatchPending(sessionIdForRuns);
      if (hasActiveRun) {
        // Active run — steer the message into the running turn's queue.
        const steered = queueEmbeddedPiMessage(sessionIdForRuns, ctx.Body ?? "");
        if (steered) {
          logVerbose(
            `dispatch-from-config: async mode - steered message to active run (session=${sessionIdForRuns})`,
          );
          markIdle("message_steered");
          const counts = dispatcher.getQueuedCounts();
          recordProcessed("completed", { reason: "async_steered" });
          return { queuedFinal: false, counts };
        }
        // Active but not streaming/compacting — fall through to pending buffer or new run.
      }
      if (hasPendingDispatch) {
        // Turn fired but not yet registered — buffer the message.
        const buffered = queuePendingMessage(sessionIdForRuns, ctx.Body ?? "");
        if (buffered) {
          logVerbose(
            `dispatch-from-config: async mode - buffered message for pending dispatch (session=${sessionIdForRuns})`,
          );
          markIdle("message_buffered");
          const counts = dispatcher.getQueuedCounts();
          recordProcessed("completed", { reason: "async_buffered" });
          return { queuedFinal: false, counts };
        }
      }
      // No active run and no pending dispatch (or buffering failed): fire-and-forget new agent turn.
      // Mark pending BEFORE starting the turn to close the race window.
      markDispatchPending(sessionIdForRuns);
      // Start the agent turn in the background without awaiting.
      logVerbose(
        `dispatch-from-config: async mode - fire-and-forget agent turn (session=${sessionIdForRuns})`,
      );
      const fireAndForgetTask = runAsyncAgentTurn(turnCtx);
      // Don't await the task - fire and forget.
      // Catch unhandled rejections to prevent process crashes.
      fireAndForgetTask.catch((err) => {
        logVerbose(
          `dispatch-from-config: async mode - unhandled fire-and-forget rejection: ${String(err)}`,
        );
      });
      // Return immediately - agent turn continues in background.
      markIdle("message_dispatched_async");
      const counts = dispatcher.getQueuedCounts();
      recordProcessed("completed", { reason: "async_dispatched" });
      return { queuedFinal: false, counts };
    }
    // Synchronous (blocking) mode - original behavior.
    const replyResult = await (params.replyResolver ?? getReplyFromConfig)(
      ctx,
      {
        ...params.replyOptions,
        onToolResult: shouldSendToolSummaries
          ? (payload) => {
              const run = async () => {
                const ttsPayload = await maybeApplyTtsToPayload({
                  payload,
                  cfg,
                  channel: ttsChannel,
                  kind: "tool",
                  inboundAudio,
                  ttsAuto: sessionTtsAuto,
                });
                if (shouldRouteToOriginating) {
                  await sendPayloadAsync(ttsPayload, undefined, false);
                } else {
                  dispatcher.sendToolResult(ttsPayload);
                }
              };
              return run();
            }
          : undefined,
        onBlockReply: (payload, context) => {
          const run = async () => {
            // Accumulate block text for TTS generation after streaming
            if (payload.text) {
              if (accumulatedBlockText.length > 0) {
                accumulatedBlockText += "\n";
              }
              accumulatedBlockText += payload.text;
              blockCount++;
            }
            const ttsPayload = await maybeApplyTtsToPayload({
              payload,
              cfg,
              channel: ttsChannel,
              kind: "block",
              inboundAudio,
              ttsAuto: sessionTtsAuto,
            });
            if (shouldRouteToOriginating) {
              await sendPayloadAsync(ttsPayload, context?.abortSignal, false);
            } else {
              dispatcher.sendBlockReply(ttsPayload);
            }
          };
          return run();
        },
      },
      cfg,
    );
    const replies = replyResult ? (Array.isArray(replyResult) ? replyResult : [replyResult]) : [];
    let queuedFinal = false;
    let routedFinalCount = 0;
    for (const reply of replies) {
      const ttsReply = await maybeApplyTtsToPayload({
        payload: reply,
        cfg,
        channel: ttsChannel,
        kind: "final",
        inboundAudio,
        ttsAuto: sessionTtsAuto,
      });
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        // Route final reply to originating channel.
        const result = await routeReply({
          payload: ttsReply,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: ctx.SessionKey,
          accountId: ctx.AccountId,
          threadId: ctx.MessageThreadId,
          cfg,
        });
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (final) failed: ${result.error ?? "unknown error"}`,
          );
        }
        queuedFinal = result.ok || queuedFinal;
        if (result.ok) {
          routedFinalCount += 1;
        }
      } else {
        queuedFinal = dispatcher.sendFinalReply(ttsReply) || queuedFinal;
      }
    }
    const ttsMode = resolveTtsConfig(cfg).mode ?? "final";
    // Generate TTS-only reply after block streaming completes (when there's no final reply).
    // This handles the case where block streaming succeeds and drops final payloads,
    // but we still want TTS audio to be generated from the accumulated block content.
    if (
      ttsMode === "final" &&
      replies.length === 0 &&
      blockCount > 0 &&
      accumulatedBlockText.trim()
    ) {
      try {
        const ttsSyntheticReply = await maybeApplyTtsToPayload({
          payload: { text: accumulatedBlockText },
          cfg,
          channel: ttsChannel,
          kind: "final",
          inboundAudio,
          ttsAuto: sessionTtsAuto,
        });
        // Only send if TTS was actually applied (mediaUrl exists)
        if (ttsSyntheticReply.mediaUrl) {
          // Send TTS-only payload (no text, just audio) so it doesn't duplicate the block content
          const ttsOnlyPayload = {
            mediaUrl: ttsSyntheticReply.mediaUrl,
            audioAsVoice: ttsSyntheticReply.audioAsVoice,
          };
          if (shouldRouteToOriginating && originatingChannel && originatingTo) {
            const result = await routeReply({
              payload: ttsOnlyPayload,
              channel: originatingChannel,
              to: originatingTo,
              sessionKey: ctx.SessionKey,
              accountId: ctx.AccountId,
              threadId: ctx.MessageThreadId,
              cfg,
            });
            queuedFinal = result.ok || queuedFinal;
            if (result.ok) {
              routedFinalCount += 1;
            }
            if (!result.ok) {
              logVerbose(
                `dispatch-from-config: route-reply (tts-only) failed: ${result.error ?? "unknown error"}`,
              );
            }
          } else {
            const didQueue = dispatcher.sendFinalReply(ttsOnlyPayload);
            queuedFinal = didQueue || queuedFinal;
          }
        }
      } catch (err) {
        logVerbose(
          `dispatch-from-config: accumulated block TTS failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await dispatcher.waitForIdle();
    const counts = dispatcher.getQueuedCounts();
    counts.final += routedFinalCount;
    recordProcessed("completed");
    markIdle("message_completed");
    return { queuedFinal, counts };
  } catch (err) {
    recordProcessed("error", { error: String(err) });
    markIdle("message_error");
    throw err;
  }
}
