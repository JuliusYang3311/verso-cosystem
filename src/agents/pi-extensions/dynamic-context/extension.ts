/**
 * Dynamic Context SDK Extension (Layer 1)
 *
 * Fires on every "context" event (before each LLM call).
 * - Searches memory via injected memoryManager
 * - Applies dynamic budget allocation (recent ratio + retrieval ratio)
 * - Injects <memory-context> snippets
 * - Returns trimmed messages to the SDK
 *
 * Combined with context-pruning (Layer 3) and compaction-safeguard (Layer 2),
 * this provides a 3-layer context management pipeline that is transparent to callers.
 */

import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildDynamicContext, loadContextParams } from "../../dynamic-context.js";
import { getDynamicContextRuntime } from "./runtime.js";

export default function dynamicContextExtension(api: ExtensionAPI): void {
  api.on("context", async (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getDynamicContextRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined;
    }

    const messages = event.messages;
    if (messages.length === 0) {
      return undefined;
    }

    try {
      // Extract search query from last user message
      const lastUserMsg = messages
        .toReversed()
        .find(
          (m) =>
            m &&
            typeof m === "object" &&
            (m as { role?: string }).role === "user" &&
            typeof (m as { content?: unknown }).content === "string",
        );
      const searchQuery =
        lastUserMsg && typeof (lastUserMsg as { content?: unknown }).content === "string"
          ? (lastUserMsg as { content: string }).content.slice(0, 500)
          : "";

      // Retrieve memory chunks
      let retrievedChunks: Parameters<typeof buildDynamicContext>[0]["retrievedChunks"] = [];
      if (searchQuery && runtime.memoryManager) {
        try {
          const results = await runtime.memoryManager.search(searchQuery);
          retrievedChunks = results.map((r) => ({
            id: r.id,
            snippet: r.snippet,
            score: r.score,
            path: r.path,
            source: r.source,
            startLine: r.startLine,
            endLine: r.endLine,
            timestamp: r.timestamp,
            l0Tags: r.l0Tags,
            l1Sentences: r.l1Sentences,
          }));
        } catch {
          // Memory retrieval failure is non-fatal
        }
      }

      // Estimate system prompt tokens
      const systemPrompt = ctx.getSystemPrompt?.() ?? "";
      const systemPromptTokens = Math.ceil(systemPrompt.length / 4);

      // Context limit: runtime override > model context window > default
      const contextLimit = runtime.contextLimit ?? ctx.model?.contextWindow ?? 200_000;

      // Load evolver-tunable params
      const contextParams = await loadContextParams();

      // Build dynamic context
      const result = buildDynamicContext({
        allMessages: messages,
        retrievedChunks,
        contextLimit,
        systemPromptTokens,
        reserveForReply: 4_000,
        compactionSummary: null,
        params: contextParams,
      });

      // Assemble final messages
      let finalMessages = result.recentMessages;

      // Inject memory snippets as synthetic context message
      if (result.retrievedChunks.length > 0) {
        const memorySnippets = result.retrievedChunks
          .map(
            (c) =>
              `[${c.path}:${c.startLine}-${c.endLine}] (score=${c.score.toFixed(2)})\n${c.snippet}`,
          )
          .join("\n---\n");
        finalMessages = [
          {
            role: "user" as const,
            content: `<memory-context>\nThe following are relevant memory snippets retrieved for this conversation:\n\n${memorySnippets}\n</memory-context>`,
            timestamp: Date.now(),
          },
          ...finalMessages,
        ];
      }

      return { messages: finalMessages };
    } catch {
      // On any error, return undefined to use original messages
      return undefined;
    }
  });
}
