/**
 * Dynamic Context SDK Extension (Layer 1)
 *
 * Fires on every "context" event (before each LLM call).
 * - Searches memory via injected memoryManager
 * - Applies dynamic budget allocation (recent ratio + retrieval ratio)
 * - Adaptive threshold based on session utilization feedback
 * - L1/L2 adaptive selection per chunk
 * - Injects <memory-context> snippets
 * - Returns trimmed messages to the SDK
 *
 * Combined with context-pruning (Layer 3) and compaction-safeguard (Layer 2),
 * this provides a 3-layer context management pipeline that is transparent to callers.
 */

import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { computeAdaptiveThreshold } from "../../../memory/utilization.js";
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
      // Load evolver-tunable params
      const contextParams = await loadContextParams();

      // Extract search query from last user message(s)
      const querySourceMessages = contextParams.querySourceMessages ?? 1;
      const queryMaxChars = contextParams.queryMaxChars ?? 500;
      const userMessages = messages
        .filter(
          (m) =>
            m &&
            typeof m === "object" &&
            (m as { role?: string }).role === "user" &&
            (m as { content?: unknown }).content != null,
        )
        .slice(-querySourceMessages);
      const searchQuery = userMessages
        .map((m) => {
          const content = (m as { content: unknown }).content;
          if (typeof content === "string") return content;
          // SDK stores user messages as array of content blocks: [{ type: "text", text: "..." }]
          if (Array.isArray(content)) {
            return content
              .filter(
                (b: unknown) =>
                  b && typeof b === "object" && (b as { type?: string }).type === "text",
              )
              .map((b: unknown) => (b as { text: string }).text ?? "")
              .join("\n");
          }
          return "";
        })
        .join("\n")
        .slice(0, queryMaxChars);

      // Retrieve memory chunks
      let retrievedChunks: Parameters<typeof buildDynamicContext>[0]["retrievedChunks"] = [];

      // Apply adaptive threshold: raise threshold when utilization is low
      let effectiveParams = contextParams;
      if (searchQuery && runtime.memoryManager) {
        try {
          // Get session utilization rate for adaptive threshold
          const sessionUtilRate = runtime.memoryManager.getSessionUtilizationRate?.(
            /* sessionId is not easily available here; use a general recent window */
            "",
          );
          if (
            sessionUtilRate !== undefined &&
            sessionUtilRate !== null &&
            contextParams.utilizationThresholdBoost
          ) {
            const adaptedThreshold = computeAdaptiveThreshold(
              contextParams.baseThreshold,
              sessionUtilRate,
              contextParams.utilizationThresholdBoost,
            );
            effectiveParams = { ...contextParams, baseThreshold: adaptedThreshold };
          }

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

          // L1/L2 adaptive selection: upgrade high-L1-miss chunks to L2
          if (
            typeof runtime.memoryManager.getChunkUtilizationStats === "function" &&
            typeof runtime.memoryManager.readChunk === "function"
          ) {
            const l1MissRateThreshold = contextParams.l1MissRateThreshold ?? 0.5;
            const l2BudgetRatio = contextParams.l2BudgetRatio ?? 0.3;
            const minSamples = contextParams.utilizationMinSamples ?? 3;
            // Estimate total retrieval budget for L2 cap
            const contextLimit = runtime.contextLimit ?? ctx.model?.contextWindow ?? 200_000;
            const systemPromptTokens = Math.ceil((ctx.getSystemPrompt?.() ?? "").length / 4);
            const totalBudget = Math.floor(contextLimit * 0.8 - systemPromptTokens - 4_000);
            const l2TokenBudget = Math.floor(totalBudget * l2BudgetRatio);
            let l2TokensUsed = 0;

            retrievedChunks = await Promise.all(
              retrievedChunks.map(async (chunk) => {
                if (!chunk.id || l2TokensUsed >= l2TokenBudget) return chunk;
                try {
                  const stats = runtime.memoryManager!.getChunkUtilizationStats!(chunk.id);
                  if (
                    stats &&
                    stats.injectCount >= minSamples &&
                    stats.l1MissCount / stats.injectCount > l1MissRateThreshold
                  ) {
                    const l2 = await runtime.memoryManager!.readChunk!(chunk.id);
                    if (l2) {
                      const l2Tokens = Math.ceil(l2.text.length / 4);
                      if (l2TokensUsed + l2Tokens <= l2TokenBudget) {
                        l2TokensUsed += l2Tokens;
                        return { ...chunk, snippet: l2.text };
                      }
                    }
                  }
                } catch {
                  // Fall back to L1 snippet
                }
                return chunk;
              }),
            );
          }
        } catch {
          // Memory retrieval failure is non-fatal
        }
      }

      // Estimate system prompt tokens
      const systemPrompt = ctx.getSystemPrompt?.() ?? "";
      const systemPromptTokens = Math.ceil(systemPrompt.length / 4);

      // Context limit: runtime override > model context window > default
      const contextLimit = runtime.contextLimit ?? ctx.model?.contextWindow ?? 200_000;

      // Build dynamic context
      const result = buildDynamicContext({
        allMessages: messages,
        retrievedChunks,
        contextLimit,
        systemPromptTokens,
        reserveForReply: 4_000,
        compactionSummary: null,
        params: effectiveParams,
      });

      // Record injected chunks on runtime for post-turn attribution
      runtime.lastInjectedChunks = result.retrievedChunks.map((c) => ({
        id: c.id ?? "",
        path: c.path,
        startLine: c.startLine,
        endLine: c.endLine,
        snippet: c.snippet,
        score: c.score,
        factorIds: Object.keys(c.l0Tags ?? {}),
      }));

      // Assemble final messages
      let finalMessages = result.recentMessages;

      // Inject memory snippets as synthetic context message
      if (result.retrievedChunks.length > 0) {
        const memorySnippets = result.retrievedChunks
          .map((c) => {
            const header = `[${c.path}:${c.startLine}-${c.endLine}] (score=${c.score.toFixed(2)})`;
            const ref = c.id
              ? `→ memory_get({"chunkId": "${c.id}"})`
              : `→ memory_get({"path": "${c.path}", "from": ${c.startLine}, "lines": ${c.endLine - c.startLine}})`;
            return `${header}\n${c.snippet}\n${ref}`;
          })
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
