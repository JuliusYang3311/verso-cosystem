import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { HARD_MAX_TOOL_RESULT_CHARS } from "./pi-embedded-runner/tool-result-truncation.js";
import { makeMissingToolResult, sanitizeToolCallInputs } from "./session-transcript-repair.js";
const GUARD_TRUNCATION_SUFFIX =
  "\n\n⚠️ [Content truncated during persistence — original exceeded size limit. " +
  "Use offset/limit parameters or request specific sections for large content.]";
/**
 * Truncate oversized text content blocks in a tool result message.
 * Returns the original message if under the limit, or a new message with
 * truncated text blocks otherwise.
 */
function capToolResultSize(msg) {
  const role = msg.role;
  if (role !== "toolResult") {
    return msg;
  }
  const content = msg.content;
  if (!Array.isArray(content)) {
    return msg;
  }
  // Calculate total text size
  let totalTextChars = 0;
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text") {
      const text = block.text;
      if (typeof text === "string") {
        totalTextChars += text.length;
      }
    }
  }
  if (totalTextChars <= HARD_MAX_TOOL_RESULT_CHARS) {
    return msg;
  }
  // Truncate proportionally
  const newContent = content.map((block) => {
    if (!block || typeof block !== "object" || block.type !== "text") {
      return block;
    }
    const textBlock = block;
    if (typeof textBlock.text !== "string") {
      return block;
    }
    const blockShare = textBlock.text.length / totalTextChars;
    const blockBudget = Math.max(
      2_000,
      Math.floor(HARD_MAX_TOOL_RESULT_CHARS * blockShare) - GUARD_TRUNCATION_SUFFIX.length,
    );
    if (textBlock.text.length <= blockBudget) {
      return block;
    }
    // Try to cut at a newline boundary
    let cutPoint = blockBudget;
    const lastNewline = textBlock.text.lastIndexOf("\n", blockBudget);
    if (lastNewline > blockBudget * 0.8) {
      cutPoint = lastNewline;
    }
    return {
      ...textBlock,
      text: textBlock.text.slice(0, cutPoint) + GUARD_TRUNCATION_SUFFIX,
    };
  });
  return { ...msg, content: newContent };
}
function extractAssistantToolCalls(msg) {
  const content = msg.content;
  if (!Array.isArray(content)) {
    return [];
  }
  const toolCalls = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block;
    if (typeof rec.id !== "string" || !rec.id) {
      continue;
    }
    if (rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall") {
      toolCalls.push({
        id: rec.id,
        name: typeof rec.name === "string" ? rec.name : undefined,
      });
    }
  }
  return toolCalls;
}
function extractToolResultId(msg) {
  const toolCallId = msg.toolCallId;
  if (typeof toolCallId === "string" && toolCallId) {
    return toolCallId;
  }
  const toolUseId = msg.toolUseId;
  if (typeof toolUseId === "string" && toolUseId) {
    return toolUseId;
  }
  return null;
}
export function installSessionToolResultGuard(sessionManager, opts) {
  const originalAppend = sessionManager.appendMessage.bind(sessionManager);
  const pending = new Map();
  const persistToolResult = (message, meta) => {
    const transformer = opts?.transformToolResultForPersistence;
    return transformer ? transformer(message, meta) : message;
  };
  const allowSyntheticToolResults = opts?.allowSyntheticToolResults ?? true;
  const flushPendingToolResults = () => {
    if (pending.size === 0) {
      return;
    }
    if (allowSyntheticToolResults) {
      for (const [id, name] of pending.entries()) {
        const synthetic = makeMissingToolResult({ toolCallId: id, toolName: name });
        originalAppend(
          persistToolResult(synthetic, {
            toolCallId: id,
            toolName: name,
            isSynthetic: true,
          }),
        );
      }
    }
    pending.clear();
  };
  const guardedAppend = (message) => {
    let nextMessage = message;
    const role = message.role;
    if (role === "assistant") {
      const sanitized = sanitizeToolCallInputs([message]);
      if (sanitized.length === 0) {
        if (allowSyntheticToolResults && pending.size > 0) {
          flushPendingToolResults();
        }
        return undefined;
      }
      nextMessage = sanitized[0];
    }
    const nextRole = nextMessage.role;
    if (nextRole === "toolResult") {
      const id = extractToolResultId(nextMessage);
      const toolName = id ? pending.get(id) : undefined;
      if (id) {
        pending.delete(id);
      }
      // Apply hard size cap before persistence to prevent oversized tool results
      // from consuming the entire context window on subsequent LLM calls.
      const capped = capToolResultSize(nextMessage);
      return originalAppend(
        persistToolResult(capped, {
          toolCallId: id ?? undefined,
          toolName,
          isSynthetic: false,
        }),
      );
    }
    const toolCalls = nextRole === "assistant" ? extractAssistantToolCalls(nextMessage) : [];
    if (allowSyntheticToolResults) {
      // If previous tool calls are still pending, flush before non-tool results.
      if (pending.size > 0 && (toolCalls.length === 0 || nextRole !== "assistant")) {
        flushPendingToolResults();
      }
      // If new tool calls arrive while older ones are pending, flush the old ones first.
      if (pending.size > 0 && toolCalls.length > 0) {
        flushPendingToolResults();
      }
    }
    const result = originalAppend(nextMessage);
    const sessionFile = sessionManager.getSessionFile?.();
    if (sessionFile) {
      emitSessionTranscriptUpdate(sessionFile);
    }
    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        pending.set(call.id, call.name);
      }
    }
    return result;
  };
  // Monkey-patch appendMessage with our guarded version.
  sessionManager.appendMessage = guardedAppend;
  return {
    flushPendingToolResults,
    getPendingIds: () => Array.from(pending.keys()),
  };
}
