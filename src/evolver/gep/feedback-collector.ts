/**
 * feedback-collector.ts
 * Collects implicit/explicit user feedback as optimization signals for Evolver.
 * Feedback is associated with a context_params snapshot for causal attribution.
 */

import fs from "node:fs";
import path from "node:path";
import { getEvolverAssetsDir, getGepAssetsDir } from "./paths.js";

// ---------- Types ----------

export interface FeedbackEntry {
  timestamp: string;
  type: "implicit" | "explicit";
  signal: string;
  session_id: string | null;
  details: Record<string, unknown> | null;
  context_params_snapshot: ContextParams;
}

export interface ImplicitFeedbackResult {
  detected: boolean;
  signal: string;
  details?: Record<string, unknown>;
}

export interface FeedbackAggregation {
  signalCounts: Record<string, number>;
  dominantSignal: string | null;
  totalCount: number;
}

interface ContextParams {
  baseThreshold: number;
  thresholdFloor: number;
  timeDecayLambda: number;
  recentRatioBase: number;
  recentRatioMin: number;
  recentRatioMax: number;
  hybridVectorWeight: number;
  hybridMinScore: number;
  [key: string]: unknown;
}

interface FeedbackInput {
  type?: "implicit" | "explicit";
  signal: string;
  sessionId?: string;
  details?: Record<string, unknown>;
}

interface ImplicitFeedbackContext {
  userMessage: string;
  recentMessages: string[];
  turnCount: number;
  sessionId?: string;
}

// ---------- Constants ----------

const FEEDBACK_FILE = "feedback.jsonl";
const CONTEXT_PARAMS_FILE = "context_params.json";

// ---------- Default parameters ----------

export const DEFAULT_CONTEXT_PARAMS: ContextParams = {
  baseThreshold: 0.72,
  thresholdFloor: 0.5,
  timeDecayLambda: 0.01,
  recentRatioBase: 0.4,
  recentRatioMin: 0.2,
  recentRatioMax: 0.7,
  hybridVectorWeight: 0.7,
  hybridMinScore: 0.01,
};

// ---------- Parameter I/O ----------

function getContextParamsPath(): string {
  return path.join(getEvolverAssetsDir(), CONTEXT_PARAMS_FILE);
}

export function loadContextParams(): ContextParams {
  const filePath = getContextParamsPath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      return { ...DEFAULT_CONTEXT_PARAMS, ...JSON.parse(raw) };
    }
  } catch {}
  return { ...DEFAULT_CONTEXT_PARAMS };
}

export function saveContextParams(params: ContextParams): void {
  const filePath = getContextParamsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(params, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

// ---------- Feedback recording ----------

function getFeedbackPath(): string {
  return path.join(getGepAssetsDir(), FEEDBACK_FILE);
}

/** Record a feedback event. */
export function recordFeedback(feedback: FeedbackInput): FeedbackEntry {
  const entry: FeedbackEntry = {
    timestamp: new Date().toISOString(),
    type: feedback.type || "implicit",
    signal: feedback.signal,
    session_id: feedback.sessionId || null,
    details: feedback.details || null,
    context_params_snapshot: loadContextParams(),
  };

  const filePath = getFeedbackPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

// ---------- Implicit feedback detection ----------

/** Detect repeated questions (indicates insufficient context retrieval quality). */
export function detectRepeatQuestion(recentMessages: string[]): ImplicitFeedbackResult | null {
  if (!Array.isArray(recentMessages) || recentMessages.length < 2) {
    return null;
  }

  const last = normalize(recentMessages[recentMessages.length - 1]);
  for (let i = recentMessages.length - 2; i >= Math.max(0, recentMessages.length - 6); i--) {
    const prev = normalize(recentMessages[i]);
    if (similarity(last, prev) > 0.7) {
      return {
        detected: true,
        signal: "repeat_question",
        details: { current: last.slice(0, 200), similar_to: prev.slice(0, 200) },
      };
    }
  }
  return null;
}

/** Detect user corrections to agent replies. */
export function detectCorrection(userMessage: string): ImplicitFeedbackResult | null {
  const lower = String(userMessage || "").toLowerCase();
  const correctionPatterns: RegExp[] = [
    /\b(no[,.]?\s+i (meant|said|asked|want))/i,
    /\b(that'?s (wrong|incorrect|not what))/i,
    /\b(不对|不是这个|错了|我说的是|我的意思是)/, // Chinese correction patterns
    /\b(wrong|incorrect|not right|no that'?s not)/i,
  ];

  for (const pattern of correctionPatterns) {
    if (pattern.test(lower)) {
      return { detected: true, signal: "user_correction" };
    }
  }
  return null;
}

/** Detect low conversation efficiency (abnormally high turn count). */
export function detectLowEfficiency(
  turnCount: number,
  threshold?: number,
): ImplicitFeedbackResult | null {
  const t = threshold || 8;
  if (turnCount >= t) {
    return {
      detected: true,
      signal: "low_efficiency",
      details: { turn_count: turnCount, threshold: t },
    };
  }
  return null;
}

/** Detect user interruption / tool execution cancellation. */
export function detectToolCancellation(userMessage: string): ImplicitFeedbackResult | null {
  const lower = String(userMessage || "").toLowerCase();
  const cancelPatterns: RegExp[] = [
    /\b(stop|cancel|abort|kill|terminate|中断|取消|停止)\b/i, // includes Chinese cancel terms
    /\bctrl[+-]c\b/i,
  ];

  for (const pattern of cancelPatterns) {
    if (pattern.test(lower)) {
      return { detected: true, signal: "tool_cancelled" };
    }
  }
  return null;
}

/** Detect all implicit feedback signals from conversation context. */
export function detectImplicitFeedback(context: ImplicitFeedbackContext): FeedbackEntry[] {
  const { userMessage, recentMessages, turnCount, sessionId } = context;
  const feedbacks: FeedbackEntry[] = [];

  const repeat = detectRepeatQuestion(recentMessages);
  if (repeat) {
    feedbacks.push(
      recordFeedback({
        type: "implicit",
        signal: repeat.signal,
        sessionId,
        details: repeat.details,
      }),
    );
  }

  const correction = detectCorrection(userMessage);
  if (correction) {
    feedbacks.push(recordFeedback({ type: "implicit", signal: correction.signal, sessionId }));
  }

  const efficiency = detectLowEfficiency(turnCount);
  if (efficiency) {
    feedbacks.push(
      recordFeedback({
        type: "implicit",
        signal: efficiency.signal,
        sessionId,
        details: efficiency.details,
      }),
    );
  }

  const cancel = detectToolCancellation(userMessage);
  if (cancel) {
    feedbacks.push(recordFeedback({ type: "implicit", signal: cancel.signal, sessionId }));
  }

  return feedbacks;
}

/** Record explicit feedback (user directly rates via command). */
export function recordExplicitFeedback(
  rating: "good" | "bad",
  comment?: string,
  sessionId?: string,
): FeedbackEntry {
  return recordFeedback({
    type: "explicit",
    signal: `user_rating_${rating}`,
    sessionId,
    details: { rating, comment: comment || null },
  });
}

// ---------- Feedback retrieval (consumed by Evolver) ----------

/** Load recent feedback entries. */
export function loadRecentFeedback(limit?: number): FeedbackEntry[] {
  const maxEntries = limit || 50;
  const filePath = getFeedbackPath();
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    const recent = lines.slice(-maxEntries);
    return recent
      .map((line: string) => {
        try {
          return JSON.parse(line) as FeedbackEntry;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as FeedbackEntry[];
  } catch {
    return [];
  }
}

/** Aggregate feedback signals for Evolver decision-making. */
export function aggregateFeedbackSignals(hoursBack?: number): FeedbackAggregation {
  const hours = hoursBack || 24;
  const cutoff = Date.now() - hours * 3600_000;
  const feedback = loadRecentFeedback(200);

  const signalCounts: Record<string, number> = {};
  let total = 0;

  for (const entry of feedback) {
    const ts = Date.parse(entry.timestamp);
    if (!Number.isFinite(ts) || ts < cutoff) {
      continue;
    }

    const signal = entry.signal || "unknown";
    signalCounts[signal] = (signalCounts[signal] || 0) + 1;
    total++;
  }

  let dominantSignal: string | null = null;
  let maxCount = 0;
  for (const [signal, count] of Object.entries(signalCounts)) {
    if (count > maxCount) {
      maxCount = count;
      dominantSignal = signal;
    }
  }

  return { signalCounts, dominantSignal, totalCount: total };
}

// ---------- Utility functions ----------

function normalize(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a: string, b: string): number {
  if (!a || !b) {
    return 0;
  }
  const wordsA = new Set(a.split(" "));
  const wordsB = new Set(b.split(" "));
  const intersection = [...wordsA].filter((w) => wordsB.has(w));
  const union = new Set([...wordsA, ...wordsB]);
  return union.size > 0 ? intersection.length / union.size : 0;
}
