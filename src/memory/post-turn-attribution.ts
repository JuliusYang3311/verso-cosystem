/**
 * post-turn-attribution.ts — Reusable post-turn attribution for memory utilization feedback.
 *
 * Extracted from attempt.ts so that ALL session runners (main agent, orchestrator,
 * workers) share the same attribution logic. Each runner calls
 * `performPostTurnAttribution()` after `session.prompt()` completes.
 *
 * Attribution priority per injected chunk:
 *   1. chunk.id found in memory_get tool calls → "l1_miss"
 *   2. snippet phrase match in assistant output → "utilized"
 *   3. neither → "ignored"
 */

import type { InjectedChunkRecord } from "../agents/pi-extensions/dynamic-context/runtime.js";
import type { MemorySearchManager, UtilizationEvent, UtilizationEventType } from "./types.js";
import { detectUtilization } from "./utilization.js";

// ---------- Types ----------

export type ToolMeta = {
  toolName: string;
  meta?: string | null;
};

export type AttributionInput = {
  /** Chunks injected in the most recent <memory-context> block. */
  injectedChunks: InjectedChunkRecord[];
  /** Concatenated assistant text from the turn. */
  assistantOutput: string;
  /** Normalized tool call metadata from the turn. */
  toolMetas: ToolMeta[];
  /** Session identifier. */
  sessionId: string;
};

export type AttributionResult = {
  events: UtilizationEvent[];
  injectedCount: number;
  utilizedCount: number;
  ignoredCount: number;
  l1MissCount: number;
  misleadingCount: number;
};

// ---------- Pure attribution computation ----------

/**
 * Compute utilization events from a single turn's data.
 * Pure function — no I/O, no side effects.
 */
export function computeAttribution(input: AttributionInput): AttributionResult {
  const { injectedChunks, assistantOutput, toolMetas, sessionId } = input;

  if (injectedChunks.length === 0) {
    return {
      events: [],
      injectedCount: 0,
      utilizedCount: 0,
      ignoredCount: 0,
      l1MissCount: 0,
      misleadingCount: 0,
    };
  }

  // Lazy-import avoidance: inline the phrase detection logic (same as detectUtilization)
  const memoryGetChunkIds = new Set(
    toolMetas
      .filter((t) => t.toolName === "memory_get" && t.meta)
      .map((t) => {
        try {
          return JSON.parse(t.meta!).chunkId as string | undefined;
        } catch {
          return undefined;
        }
      })
      .filter(Boolean) as string[],
  );

  const now = Date.now();
  const events: UtilizationEvent[] = [];
  let utilizedCount = 0;
  let ignoredCount = 0;
  let l1MissCount = 0;

  for (const chunk of injectedChunks) {
    // Record injection event
    events.push({
      chunkId: chunk.id,
      sessionId,
      event: "injected",
      factorIds: chunk.factorIds,
      score: chunk.score,
      timestamp: now,
    });

    // Determine attribution
    let attribution: UtilizationEventType;
    if (chunk.id && memoryGetChunkIds.has(chunk.id)) {
      attribution = "l1_miss";
      l1MissCount++;
    } else if (detectPhraseMatch(chunk.snippet, assistantOutput)) {
      attribution = "utilized";
      utilizedCount++;
    } else {
      attribution = "ignored";
      ignoredCount++;
    }

    events.push({
      chunkId: chunk.id,
      sessionId,
      event: attribution,
      factorIds: chunk.factorIds,
      score: chunk.score,
      timestamp: now,
    });
  }

  return {
    events,
    injectedCount: injectedChunks.length,
    utilizedCount,
    ignoredCount,
    l1MissCount,
    misleadingCount: 0,
  };
}

// Phrase matching delegated to utilization.ts (CJK-aware implementation).
const detectPhraseMatch = detectUtilization;

// ---------- Full attribution pipeline ----------

/**
 * Perform post-turn attribution: record utilization events + emit feedback.
 *
 * Call this after `session.prompt()` completes, providing the session's
 * dynamic context runtime and assistant output.
 *
 * @returns Attribution result, or null if no chunks were injected.
 */
export async function performPostTurnAttribution(params: {
  /** The sessionManager object (runtime is stored on it via Symbol). */
  sessionManager: unknown;
  /** Memory manager with recordUtilization support. */
  memoryManager: MemorySearchManager;
  /** Concatenated assistant text from the turn. */
  assistantOutput: string;
  /** Tool call metadata from the turn (empty array if not available). */
  toolMetas: ToolMeta[];
  /** Session identifier for attribution events. */
  sessionId: string;
  /** Whether to emit feedback.jsonl for evolver (default: true). */
  emitFeedback?: boolean;
}): Promise<AttributionResult | null> {
  const { sessionManager, memoryManager, assistantOutput, toolMetas, sessionId } = params;
  const emitFeedback = params.emitFeedback !== false;

  // Get dynamic context runtime to access lastInjectedChunks
  const { getDynamicContextRuntime } =
    await import("../agents/pi-extensions/dynamic-context/runtime.js");
  const dcRuntime = getDynamicContextRuntime(sessionManager);
  const injected = dcRuntime?.lastInjectedChunks ?? [];

  if (injected.length === 0) return null;
  if (typeof memoryManager.recordUtilization !== "function") return null;

  const result = computeAttribution({
    injectedChunks: injected,
    assistantOutput,
    toolMetas,
    sessionId,
  });

  // Record events to SQL
  memoryManager.recordUtilization(result.events);

  // Clear injected chunks for next turn
  dcRuntime!.lastInjectedChunks = [];

  // Emit aggregated feedback for evolver
  if (emitFeedback && result.injectedCount > 0) {
    try {
      const { recordFeedback } = await import("../evolver/gep/feedback-collector.js");
      const utilizedEvents = result.events.filter((e) => e.event === "utilized");
      const ignoredEvents = result.events.filter((e) => e.event === "ignored");
      const memorySearchCalls = toolMetas.filter((t) => t.toolName === "memory_search").length;

      recordFeedback({
        type: "implicit",
        signal: "memory_session_utilization",
        sessionId,
        details: {
          injected_count: result.injectedCount,
          utilized_count: result.utilizedCount,
          ignored_count: result.ignoredCount,
          l1_miss_count: result.l1MissCount,
          misleading_count: result.misleadingCount,
          utilization_rate: result.utilizedCount / result.injectedCount,
          l1_miss_rate: result.l1MissCount / result.injectedCount,
          ignored_ratio: result.ignoredCount / result.injectedCount,
          retrieval_gaps: memorySearchCalls,
          avg_score_utilized:
            utilizedEvents.length > 0
              ? utilizedEvents.reduce((s, e) => s + (e.score ?? 0), 0) / utilizedEvents.length
              : 0,
          avg_score_ignored:
            ignoredEvents.length > 0
              ? ignoredEvents.reduce((s, e) => s + (e.score ?? 0), 0) / ignoredEvents.length
              : 0,
        },
      });
    } catch {
      // Feedback recording is non-critical
    }
  }

  return result;
}
