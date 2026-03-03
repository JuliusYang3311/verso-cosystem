import type { Bot } from "grammy";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";

const TELEGRAM_DRAFT_MAX_CHARS = 4096;
const DEFAULT_THROTTLE_MS = 300;
const DRAFT_METHOD_UNAVAILABLE_RE =
  /(unknown method|method .*not (found|available|supported)|unsupported|not available)/i;
const DRAFT_CHAT_UNSUPPORTED_RE = /(can't be used|can be used only)/i;

type TelegramSendMessageDraft = (
  chatId: number,
  draftId: number,
  text: string,
  params?: {
    message_thread_id?: number;
    parse_mode?: "HTML";
  },
) => Promise<unknown>;

export type TelegramDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  stop: () => void;
  messageId?: () => number | undefined;
};

function resolveSendMessageDraftApi(api: Bot["api"]): TelegramSendMessageDraft | undefined {
  const sendMessageDraft = (api as Bot["api"] & { sendMessageDraft?: TelegramSendMessageDraft })
    .sendMessageDraft;
  if (typeof sendMessageDraft !== "function") {
    return undefined;
  }
  return sendMessageDraft.bind(api as object);
}

function shouldFallbackFromDraftTransport(err: unknown): boolean {
  const text =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof err === "object" && err && "description" in err
          ? typeof err.description === "string"
            ? err.description
            : ""
          : "";
  if (!/sendMessageDraft/i.test(text)) {
    return false;
  }
  return DRAFT_METHOD_UNAVAILABLE_RE.test(text) || DRAFT_CHAT_UNSUPPORTED_RE.test(text);
}

export function createTelegramDraftStream(params: {
  api: Bot["api"];
  chatId: number;
  draftId: number;
  maxChars?: number;
  thread?: TelegramThreadSpec | null;
  throttleMs?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): TelegramDraftStream {
  const maxChars = Math.min(params.maxChars ?? TELEGRAM_DRAFT_MAX_CHARS, TELEGRAM_DRAFT_MAX_CHARS);
  const throttleMs = Math.max(50, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const rawDraftId = Number.isFinite(params.draftId) ? Math.trunc(params.draftId) : 1;
  const draftId = rawDraftId === 0 ? 1 : Math.abs(rawDraftId);
  const chatId = params.chatId;
  const threadParams = buildTelegramThreadParams(params.thread);

  // Check if sendMessageDraft is available
  const draftApi = resolveSendMessageDraftApi(params.api);
  let useMessageFallback = !draftApi;
  let streamMessageId: number | undefined;

  if (!draftApi) {
    params.warn?.(
      "telegram draft stream: sendMessageDraft unavailable; falling back to sendMessage/editMessageText",
    );
  }

  let lastSentText = "";
  let lastSentAt = 0;
  let pendingText = "";
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const sendDraft = async (text: string) => {
    if (stopped) {
      return;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return;
    }
    if (trimmed.length > maxChars) {
      // Drafts are capped at 4096 chars. Stop streaming once we exceed the cap
      // so we don't keep sending failing updates or a truncated preview.
      stopped = true;
      params.warn?.(`telegram draft stream stopped (draft length ${trimmed.length} > ${maxChars})`);
      return;
    }
    if (trimmed === lastSentText) {
      return;
    }
    lastSentText = trimmed;
    lastSentAt = Date.now();
    try {
      if (useMessageFallback) {
        // Fallback to sendMessage/editMessageText
        if (typeof streamMessageId === "number") {
          await params.api.editMessageText(chatId, streamMessageId, trimmed);
        } else {
          const sent = await params.api.sendMessage(chatId, trimmed, threadParams);
          const sentMessageId = sent?.message_id;
          if (typeof sentMessageId === "number" && Number.isFinite(sentMessageId)) {
            streamMessageId = Math.trunc(sentMessageId);
          }
        }
      } else {
        await draftApi!(chatId, draftId, trimmed, threadParams);
      }
    } catch (err) {
      // Check if we should fallback from draft to message transport
      if (!useMessageFallback && shouldFallbackFromDraftTransport(err)) {
        useMessageFallback = true;
        params.warn?.(
          "telegram draft stream: sendMessageDraft rejected by API; falling back to sendMessage/editMessageText",
        );
        // Retry with fallback
        try {
          const sent = await params.api.sendMessage(chatId, trimmed, threadParams);
          const sentMessageId = sent?.message_id;
          if (typeof sentMessageId === "number" && Number.isFinite(sentMessageId)) {
            streamMessageId = Math.trunc(sentMessageId);
          }
          return;
        } catch (fallbackErr) {
          stopped = true;
          params.warn?.(
            `telegram draft stream fallback failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
          );
          return;
        }
      }
      stopped = true;
      params.warn?.(
        `telegram draft stream failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (inFlight) {
      schedule();
      return;
    }
    const text = pendingText;
    const trimmed = text.trim();
    if (!trimmed) {
      if (pendingText === text) {
        pendingText = "";
      }
      if (pendingText) {
        schedule();
      }
      return;
    }
    pendingText = "";
    inFlight = true;
    try {
      await sendDraft(text);
    } finally {
      inFlight = false;
    }
    if (pendingText) {
      schedule();
    }
  };

  const schedule = () => {
    if (timer) {
      return;
    }
    const delay = Math.max(0, throttleMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      void flush();
    }, delay);
  };

  const update = (text: string) => {
    if (stopped) {
      return;
    }
    pendingText = text;
    if (inFlight) {
      schedule();
      return;
    }
    if (!timer && Date.now() - lastSentAt >= throttleMs) {
      void flush();
      return;
    }
    schedule();
  };

  const stop = () => {
    stopped = true;
    pendingText = "";
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  params.log?.(
    `telegram draft stream ready (draftId=${draftId}, maxChars=${maxChars}, throttleMs=${throttleMs}, fallback=${useMessageFallback})`,
  );

  return {
    update,
    flush,
    stop,
    messageId: () => streamMessageId,
  };
}
