// src/orchestration/auto-detect.ts — Orchestration auto-detection heuristics
//
// The orchestration trigger is LLM-based, not code-based.
// The orchestrator prompt (orchestrator-prompt.ts) instructs the agent to
// self-assess task complexity and decide whether to use the orchestrate tool.
//
// This file provides optional utility for programmatic hints that can be
// injected into the system prompt to help the agent decide.

export type ComplexityHint = {
  shouldOrchestrate: boolean;
  reason: string;
};

/**
 * Provides a lightweight hint based on message characteristics.
 * This is advisory — the LLM makes the final decision.
 */
export function getComplexityHint(userMessage: string): ComplexityHint {
  const lower = userMessage.toLowerCase();

  // Explicit user request
  if (lower.includes("/orchestrate") || lower.includes("parallel") || lower.includes("多agent")) {
    return { shouldOrchestrate: true, reason: "User explicitly requested orchestration" };
  }

  // Count distinct action verbs suggesting multiple tasks
  const actionPatterns = [
    /\badd\b/i,
    /\bcreate\b/i,
    /\bbuild\b/i,
    /\bimplement\b/i,
    /\brefactor\b/i,
    /\bfix\b/i,
    /\bupdate\b/i,
    /\bmigrate\b/i,
    /\bremove\b/i,
    /\breplace\b/i,
    /\bredesign\b/i,
    /\boptimize\b/i,
  ];
  const matchedActions = actionPatterns.filter((p) => p.test(userMessage));
  if (matchedActions.length >= 3) {
    return {
      shouldOrchestrate: true,
      reason: `Multiple distinct actions detected (${matchedActions.length})`,
    };
  }

  // Numbered list detection
  const numberedItems = userMessage.match(/^\s*\d+[.)]/gm);
  if (numberedItems && numberedItems.length >= 3) {
    return {
      shouldOrchestrate: true,
      reason: `Numbered task list detected (${numberedItems.length} items)`,
    };
  }

  return { shouldOrchestrate: false, reason: "Task appears simple enough for direct execution" };
}
