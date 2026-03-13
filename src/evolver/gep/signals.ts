import { resolveStrategy } from "./strategy.js";

// Opportunity signal names (shared with mutation.js and personality.js).
export const OPPORTUNITY_SIGNALS: string[] = [
  "user_feature_request",
  "user_improvement_suggestion",
  "perf_bottleneck",
  "capability_gap",
  "stable_success_plateau",
  "external_opportunity",
  "recurring_error",
  "unsupported_input_type",
  "evolution_stagnation_detected",
  "repair_loop_detected",
  "force_innovation_after_repair_loop",
  // Memory utilization signals
  "memory_low_utilization",
  "memory_noise_dominant",
  "memory_retrieval_gap",
];

// Memory utilization signals (stability category, not opportunity)
export const MEMORY_STABILITY_SIGNALS: string[] = ["memory_high_utilization"];

// Memory utilization signals (repair category)
export const MEMORY_REPAIR_SIGNALS: string[] = ["memory_high_l1_miss"];

export function hasOpportunitySignal(signals: unknown): boolean {
  const list: string[] = Array.isArray(signals) ? signals : [];
  for (let i = 0; i < OPPORTUNITY_SIGNALS.length; i++) {
    if (list.includes(OPPORTUNITY_SIGNALS[i])) {
      return true;
    }
  }
  return false;
}

interface EvolutionEvent {
  intent?: string;
  signals?: unknown[];
  genes_used?: unknown[];
  [key: string]: unknown;
}

interface RecentHistoryResult {
  suppressedSignals: Set<string>;
  recentIntents: string[];
  consecutiveRepairCount: number;
  signalFreq?: Record<string, number>;
  geneFreq?: Record<string, number>;
}

// Build a de-duplication set from recent evolution events.
// Returns an object: { suppressedSignals: Set<string>, recentIntents: string[], consecutiveRepairCount: number }
export function analyzeRecentHistory(recentEvents: EvolutionEvent[]): RecentHistoryResult {
  if (!Array.isArray(recentEvents) || recentEvents.length === 0) {
    return { suppressedSignals: new Set(), recentIntents: [], consecutiveRepairCount: 0 };
  }
  // Take only the last 10 events
  const recent = recentEvents.slice(-10);

  // Count consecutive same-intent runs at the tail
  let consecutiveRepairCount = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].intent === "repair") {
      consecutiveRepairCount++;
    } else {
      break;
    }
  }

  // Count signal frequency in last 8 events: signal -> count
  const signalFreq: Record<string, number> = {};
  const geneFreq: Record<string, number> = {};
  const tail = recent.slice(-8);
  for (let j = 0; j < tail.length; j++) {
    const evt = tail[j];
    const sigs: unknown[] = Array.isArray(evt.signals) ? evt.signals : [];
    for (let k = 0; k < sigs.length; k++) {
      const s = String(sigs[k]);
      // Normalize: ignore errsig details for frequency counting
      const key = s.startsWith("errsig:")
        ? "errsig"
        : s.startsWith("recurring_errsig")
          ? "recurring_errsig"
          : s;
      signalFreq[key] = (signalFreq[key] || 0) + 1;
    }
    const genes: unknown[] = Array.isArray(evt.genes_used) ? evt.genes_used : [];
    for (let g = 0; g < genes.length; g++) {
      geneFreq[String(genes[g])] = (geneFreq[String(genes[g])] || 0) + 1;
    }
  }

  // Suppress signals that appeared in 3+ of the last 8 events (they are being over-processed)
  const suppressedSignals = new Set<string>();
  const entries = Object.entries(signalFreq);
  for (let ei = 0; ei < entries.length; ei++) {
    if (entries[ei][1] >= 3) {
      suppressedSignals.add(entries[ei][0]);
    }
  }

  const recentIntents: string[] = recent.map(function (e) {
    return e.intent || "unknown";
  });

  return {
    suppressedSignals: suppressedSignals,
    recentIntents: recentIntents,
    consecutiveRepairCount: consecutiveRepairCount,
    signalFreq: signalFreq,
    geneFreq: geneFreq,
  };
}

interface FeedbackEntry {
  signal?: string;
  details?: {
    utilization_rate?: number;
    l1_miss_rate?: number;
    ignored_ratio?: number;
    retrieval_gaps?: number;
    injected_count?: number;
  } | null;
  [key: string]: unknown;
}

interface ExtractSignalsInput {
  recentSessionTranscript?: string;
  todayLog?: string;
  memorySnippet?: string;
  userSnippet?: string;
  recentEvents?: EvolutionEvent[];
  recentFeedback?: FeedbackEntry[];
}

export function extractSignals({
  recentSessionTranscript,
  todayLog,
  memorySnippet,
  userSnippet,
  recentEvents,
  recentFeedback,
}: ExtractSignalsInput): string[] {
  let signals: string[] = [];
  const corpus = [
    String(recentSessionTranscript || ""),
    String(todayLog || ""),
    String(memorySnippet || ""),
    String(userSnippet || ""),
  ].join("\n");
  const lower = corpus.toLowerCase();

  // Analyze recent evolution history for de-duplication
  const history = analyzeRecentHistory(recentEvents || []);

  // --- Defensive signals (errors, missing resources) ---

  const errorHit = /\[error|error:|exception|fail|failed|iserror":true/.test(lower);
  if (errorHit) {
    signals.push("log_error");
  }

  // Error signature (more reproducible than a coarse "log_error" tag).
  try {
    const lines = corpus
      .split("\n")
      .map(function (l) {
        return String(l || "").trim();
      })
      .filter(Boolean);

    const errLine =
      lines.find(function (l) {
        return /\b(typeerror|referenceerror|syntaxerror)\b\s*:|error\s*:|exception\s*:|\[error/i.test(
          l,
        );
      }) || null;

    if (errLine) {
      const clipped = errLine.replace(/\s+/g, " ").slice(0, 260);
      signals.push("errsig:" + clipped);
    }
  } catch {}

  if (lower.includes("memory.md missing")) {
    signals.push("memory_missing");
  }
  if (lower.includes("user.md missing")) {
    signals.push("user_missing");
  }
  if (lower.includes("key missing")) {
    signals.push("integration_key_missing");
  }
  if (lower.includes("no session logs found") || lower.includes("no jsonl files")) {
    signals.push("session_logs_missing");
  }
  if (lower.includes("pgrep") || lower.includes("ps aux")) {
    signals.push("windows_shell_incompatible");
  }
  if (lower.includes("path.resolve(__dirname, '../../")) {
    signals.push("path_outside_workspace");
  }

  // Protocol-specific drift signals
  if (lower.includes("prompt") && !lower.includes("evolutionevent")) {
    signals.push("protocol_drift");
  }

  // --- Recurring error detection (robustness signals) ---
  // Count repeated identical errors -- these indicate systemic issues that need automated fixes
  try {
    const errorCounts: Record<string, number> = {};
    const errPatterns =
      corpus.match(/(?:LLM error|"error"|"status":\s*"error")[^}]{0,200}/gi) || [];
    for (let ep = 0; ep < errPatterns.length; ep++) {
      // Normalize to a short key
      const key = errPatterns[ep].replace(/\s+/g, " ").slice(0, 100);
      errorCounts[key] = (errorCounts[key] || 0) + 1;
    }
    const recurringErrors = Object.entries(errorCounts).filter(function (e) {
      return e[1] >= 3;
    });
    if (recurringErrors.length > 0) {
      signals.push("recurring_error");
      // Include the top recurring error signature for the agent to diagnose
      const topErr = recurringErrors.toSorted(function (a, b) {
        return b[1] - a[1];
      })[0];
      signals.push("recurring_errsig(" + topErr[1] + "x):" + topErr[0].slice(0, 150));
    }
  } catch {}

  // --- Unsupported input type (e.g. GIF, video formats the LLM can't handle) ---
  if (/unsupported mime|unsupported.*type|invalid.*mime/i.test(lower)) {
    signals.push("unsupported_input_type");
  }

  // --- Opportunity signals (innovation / feature requests) ---

  // user_feature_request: user explicitly asks for a new capability
  // Look for action verbs + object patterns that indicate a feature request
  if (
    /\b(add|implement|create|build|make|develop|write|design)\b[^.?!\n]{3,60}\b(feature|function|module|capability|tool|support|endpoint|command|option|mode)\b/i.test(
      corpus,
    )
  ) {
    signals.push("user_feature_request");
  }
  // Also catch direct "I want/need X" patterns
  if (/\b(i want|i need|we need|please add|can you add|could you add|let'?s add)\b/i.test(lower)) {
    signals.push("user_feature_request");
  }
  // Chinese: 增加/添加/实现/开发/希望有/需要 + object
  if (
    /(增加|添加|实现|开发|新增|加上|做一个|写一个|希望有|需要.{0,10}功能|希望能|能不能加)/.test(
      corpus,
    )
  ) {
    signals.push("user_feature_request");
  }

  // user_improvement_suggestion: user suggests making something better
  if (
    /\b(should be|could be better|improve|enhance|upgrade|refactor|clean up|simplify|streamline)\b/i.test(
      lower,
    ) ||
    /(优化|改进|提升|改善|简化|重构|可以更好|应该更|做得更好|整理一下|清理)/.test(corpus)
  ) {
    // Only fire if there is no active error (to distinguish from repair requests)
    if (!errorHit) {
      signals.push("user_improvement_suggestion");
    }
  }

  // perf_bottleneck: performance issues detected
  if (
    /\b(slow|timeout|timed?\s*out|latency|bottleneck|took too long|performance issue|high cpu|high memory|oom|out of memory)\b/i.test(
      lower,
    ) ||
    /(太慢|超时|卡顿|延迟高|性能问题|响应慢|加载慢|内存不足|内存溢出|CPU.{0,4}高)/.test(corpus)
  ) {
    signals.push("perf_bottleneck");
  }

  // capability_gap: something is explicitly unsupported or missing
  if (
    /\b(not supported|cannot|doesn'?t support|no way to|missing feature|unsupported|not available|not implemented|no support for)\b/i.test(
      lower,
    ) ||
    /(不支持|无法|缺少|没有这个功能|缺失|未实现|不能用|做不到|还不能)/.test(corpus)
  ) {
    // Only fire if it is not just a missing file/config signal
    if (
      !signals.includes("memory_missing") &&
      !signals.includes("user_missing") &&
      !signals.includes("session_logs_missing")
    ) {
      signals.push("capability_gap");
    }
  }

  // --- Tool usage analytics (auto-evolved) ---
  // Detect high-frequency tool usage patterns that suggest automation opportunities
  const toolUsage: Record<string, number> = {};
  const toolMatches = corpus.match(/\[TOOL:\s*(\w+)\]/g) || [];
  for (let ti = 0; ti < toolMatches.length; ti++) {
    const toolName = toolMatches[ti].match(/\[TOOL:\s*(\w+)\]/)![1];
    toolUsage[toolName] = (toolUsage[toolName] || 0) + 1;
  }
  Object.keys(toolUsage).forEach(function (tool) {
    if (toolUsage[tool] >= 5) {
      signals.push("high_tool_usage:" + tool);
    }
    if (tool === "exec" && toolUsage[tool] >= 3) {
      signals.push("repeated_tool_usage:exec");
    }
  });

  // --- src/ core code optimization signals ---

  // Performance-related
  if (/\b(slow[_ ]?response|high[_ ]?latency|response[_ ]?time[_ ]?exceeded)\b/i.test(lower)) {
    signals.push("src_slow_response");
  }
  if (
    /\b(memory[_ ]?leak|heap[_ ]?out[_ ]?of[_ ]?memory|heap[_ ]?exceeded|rss[_ ]?growth)\b/i.test(
      lower,
    )
  ) {
    signals.push("src_memory_leak");
  }

  // Token/context-related
  if (/\b(high[_ ]?token[_ ]?usage|token[_ ]?limit|max[_ ]?tokens?[_ ]?exceeded)\b/i.test(lower)) {
    signals.push("src_high_token_usage");
  }
  if (
    /\b(context[_ ]?overflow|context[_ ]?window[_ ]?exceeded|context[_ ]?too[_ ]?long)\b/i.test(
      lower,
    )
  ) {
    signals.push("src_context_overflow");
  }

  // Build/test-related
  if (/\b(build[_ ]?fail|compilation[_ ]?error|tsc.*error)\b/i.test(lower)) {
    signals.push("src_build_failure");
  }
  if (/\b(test[_ ]?fail|tests?[_ ]?failed|vitest.*fail|jest.*fail)\b/i.test(lower)) {
    signals.push("src_test_failure");
  }
  if (/\b(lint[_ ]?error|eslint.*error|prettier.*error)\b/i.test(lower)) {
    signals.push("src_lint_error");
  }

  // Type safety
  if (/\b(typeerror|type[_ ]?mismatch|ts\d{4}|typescript[_ ]?error)\b/i.test(lower)) {
    signals.push("src_type_error");
  }

  // --- Signal prioritization ---
  // Remove cosmetic signals when actionable signals exist
  const actionable = signals.filter(function (s) {
    return (
      s !== "user_missing" &&
      s !== "memory_missing" &&
      s !== "session_logs_missing" &&
      s !== "windows_shell_incompatible"
    );
  });
  // If we have actionable signals, drop the cosmetic ones
  if (actionable.length > 0) {
    signals = actionable;
  }

  // --- De-duplication: suppress signals that have been over-processed ---
  if (history.suppressedSignals.size > 0) {
    const beforeDedup = signals.length;
    signals = signals.filter(function (s) {
      // Normalize signal key for comparison
      const key = s.startsWith("errsig:")
        ? "errsig"
        : s.startsWith("recurring_errsig")
          ? "recurring_errsig"
          : s;
      return !history.suppressedSignals.has(key);
    });
    if (beforeDedup > 0 && signals.length === 0) {
      // All signals were suppressed = system is stable but stuck in a loop
      // Force innovation
      signals.push("evolution_stagnation_detected");
      signals.push("stable_success_plateau");
    }
  }

  // --- Force innovation when repair-heavy (ratio or consecutive) ---
  // Threshold is strategy-aware: "innovate" mode triggers sooner, "harden" mode allows more repairs
  const strategy = resolveStrategy();
  let repairRatio = 0;
  if (history.recentIntents && history.recentIntents.length > 0) {
    const repairCount = history.recentIntents.filter(function (i) {
      return i === "repair";
    }).length;
    repairRatio = repairCount / history.recentIntents.length;
  }
  const shouldForceInnovation =
    strategy.name === "repair-only"
      ? false
      : history.consecutiveRepairCount >= 3 || repairRatio >= strategy.repairLoopThreshold;
  if (shouldForceInnovation) {
    // Remove repair-only signals (log_error, errsig) and inject innovation signals
    signals = signals.filter(function (s) {
      return s !== "log_error" && !s.startsWith("errsig:") && !s.startsWith("recurring_errsig");
    });
    if (signals.length === 0) {
      signals.push("repair_loop_detected");
      signals.push("stable_success_plateau");
    }
    // Append a directive signal that the prompt can pick up
    signals.push("force_innovation_after_repair_loop");
  }

  // --- Memory utilization signals (from feedback.jsonl entries) ---
  if (Array.isArray(recentFeedback) && recentFeedback.length > 0) {
    const memFeedback = recentFeedback.filter(
      (f) => f.signal === "memory_session_utilization" && f.details,
    );
    if (memFeedback.length >= 3) {
      const avgUtil =
        memFeedback.reduce((s, f) => s + (f.details!.utilization_rate ?? 0), 0) /
        memFeedback.length;
      const avgL1Miss =
        memFeedback.reduce((s, f) => s + (f.details!.l1_miss_rate ?? 0), 0) / memFeedback.length;
      const avgIgnored =
        memFeedback.reduce((s, f) => s + (f.details!.ignored_ratio ?? 0), 0) / memFeedback.length;
      const totalGaps = memFeedback.reduce((s, f) => s + (f.details!.retrieval_gaps ?? 0), 0);

      if (avgUtil < 0.3) signals.push("memory_low_utilization");
      if (avgUtil > 0.8) signals.push("memory_high_utilization");
      if (avgL1Miss > 0.4) signals.push("memory_high_l1_miss");
      if (avgIgnored > 0.7) signals.push("memory_noise_dominant");
      if (totalGaps > 3) signals.push("memory_retrieval_gap");
    }
  }

  // If no signals at all, add a default innovation signal
  if (signals.length === 0) {
    signals.push("stable_success_plateau");
  }

  return Array.from(new Set(signals));
}
