// src/channels/plugins/streaming/telegram.ts — Telegram streaming via sendMessageDraft

import type { VersoConfig } from "../../../config/types.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { sendMessageDraftTelegram } from "../../../telegram/send.js";
import { parseTelegramTarget } from "../../../telegram/targets.js";

const logger = createSubsystemLogger("telegram/streaming");

export type TelegramStreamingSession = {
  chatId: number;
  draftId: number;
  messageThreadId?: number;
  accountId?: string;
  lastText: string;
  updateCount: number;
};

const activeSessions = new Map<string, TelegramStreamingSession>();

function createSessionKey(chatId: number, draftId: number): string {
  return `${chatId}:${draftId}`;
}

/**
 * Start a new streaming session using sendMessageDraft.
 * Returns a draftId that should be used for all subsequent updates.
 */
export async function startTelegramStreaming(params: {
  to: string;
  text: string;
  accountId?: string;
  messageThreadId?: number;
  cfg?: VersoConfig;
}): Promise<{ draftId: number; chatId: number }> {
  const target = parseTelegramTarget(params.to);
  const chatId = Number(target.chatId);

  if (!Number.isFinite(chatId)) {
    throw new Error("sendMessageDraft requires numeric chat_id (usernames not supported)");
  }

  // Generate unique draft ID (timestamp + random)
  const draftId = Date.now() * 1000 + Math.floor(Math.random() * 1000);

  const sessionKey = createSessionKey(chatId, draftId);
  const session: TelegramStreamingSession = {
    chatId,
    draftId,
    messageThreadId: params.messageThreadId,
    accountId: params.accountId,
    lastText: params.text,
    updateCount: 0,
  };

  activeSessions.set(sessionKey, session);

  try {
    await sendMessageDraftTelegram(chatId, draftId, params.text, {
      accountId: params.accountId,
      messageThreadId: params.messageThreadId,
      textMode: "html",
    });

    session.updateCount++;
    logger.info("Started streaming session", { chatId, draftId });

    return { draftId, chatId };
  } catch (err) {
    activeSessions.delete(sessionKey);
    throw err;
  }
}

/**
 * Update an existing streaming session with new text.
 * The draft message will be updated in-place with animation.
 */
export async function updateTelegramStreaming(params: {
  chatId: number;
  draftId: number;
  text: string;
  accountId?: string;
}): Promise<{ updated: boolean }> {
  const sessionKey = createSessionKey(params.chatId, params.draftId);
  const session = activeSessions.get(sessionKey);

  if (!session) {
    logger.warn("Streaming session not found", { chatId: params.chatId, draftId: params.draftId });
    return { updated: false };
  }

  // Skip update if text hasn't changed
  if (session.lastText === params.text) {
    return { updated: false };
  }

  try {
    await sendMessageDraftTelegram(params.chatId, params.draftId, params.text, {
      accountId: params.accountId ?? session.accountId,
      messageThreadId: session.messageThreadId,
      textMode: "html",
    });

    session.lastText = params.text;
    session.updateCount++;

    return { updated: true };
  } catch (err) {
    logger.error("Failed to update streaming session", {
      chatId: params.chatId,
      draftId: params.draftId,
      error: String(err),
    });
    throw err;
  }
}

/**
 * End a streaming session and clean up resources.
 */
export function endTelegramStreaming(params: { chatId: number; draftId: number }): {
  ended: boolean;
  updateCount: number;
} {
  const sessionKey = createSessionKey(params.chatId, params.draftId);
  const session = activeSessions.get(sessionKey);

  if (!session) {
    return { ended: false, updateCount: 0 };
  }

  const updateCount = session.updateCount;
  activeSessions.delete(sessionKey);

  logger.info("Ended streaming session", {
    chatId: params.chatId,
    draftId: params.draftId,
    updateCount,
  });

  return { ended: true, updateCount };
}

/**
 * Get active streaming session info.
 */
export function getTelegramStreamingSession(params: {
  chatId: number;
  draftId: number;
}): TelegramStreamingSession | null {
  const sessionKey = createSessionKey(params.chatId, params.draftId);
  return activeSessions.get(sessionKey) ?? null;
}

/**
 * Clean up all active streaming sessions (for shutdown).
 */
export function cleanupAllTelegramStreamingSessions(): number {
  const count = activeSessions.size;
  activeSessions.clear();
  logger.info("Cleaned up all streaming sessions", { count });
  return count;
}
