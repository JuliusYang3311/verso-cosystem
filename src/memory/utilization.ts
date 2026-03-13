/**
 * utilization.ts — Chunk utilization tracking for the memory feedback loop.
 *
 * Records how injected chunks are used by the LLM and provides aggregation
 * queries that feed back into the retrieval pipeline (adaptive threshold,
 * ranking prior, L1/L2 selection).
 *
 * Storage: `chunk_utilization` table (see memory-schema.ts).
 */

import type { DatabaseSync } from "node:sqlite";
import type { ChunkUtilizationStats, UtilizationEvent, UtilizationEventType } from "./types.js";

// ---------- Write ----------

/**
 * Batch-insert utilization events into the chunk_utilization table.
 */
export function recordUtilization(db: DatabaseSync, events: UtilizationEvent[]): void {
  if (events.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO chunk_utilization (chunk_id, session_id, event, factor_ids, query_hash, score, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const e of events) {
    stmt.run(
      e.chunkId,
      e.sessionId,
      e.event,
      JSON.stringify(e.factorIds),
      e.queryHash ?? null,
      e.score ?? null,
      e.timestamp,
    );
  }
}

// ---------- Read: per-chunk ----------

/**
 * Aggregate utilization statistics for a single chunk across all sessions.
 * Returns null if the chunk has never been injected.
 */
export function getChunkUtilizationStats(
  db: DatabaseSync,
  chunkId: string,
): ChunkUtilizationStats | null {
  const rows = db
    .prepare(
      `SELECT event, COUNT(*) as cnt
       FROM chunk_utilization
       WHERE chunk_id = ?
       GROUP BY event`,
    )
    .all(chunkId) as Array<{ event: UtilizationEventType; cnt: number }>;

  if (rows.length === 0) return null;

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.event] = r.cnt;

  const injectCount = counts["injected"] ?? 0;
  const utilizeCount = counts["utilized"] ?? 0;
  const ignoredCount = counts["ignored"] ?? 0;
  const l1MissCount = counts["l1_miss"] ?? 0;
  const misleadingCount = counts["misleading"] ?? 0;

  return {
    injectCount,
    utilizeCount,
    ignoredCount,
    l1MissCount,
    misleadingCount,
    utilizationRate: injectCount > 0 ? utilizeCount / injectCount : 0,
  };
}

// ---------- Read: per-session ----------

/**
 * Compute the utilization rate for a session within a time window.
 * Returns null if no data exists.
 */
export function getSessionUtilizationRate(
  db: DatabaseSync,
  sessionId: string,
  windowMs?: number,
): number | null {
  const since = windowMs ? Date.now() - windowMs : undefined;

  const rows = (
    since !== undefined
      ? db
          .prepare(
            `SELECT event, COUNT(*) as cnt
             FROM chunk_utilization
             WHERE session_id = ? AND timestamp >= ?
               AND event IN ('injected', 'utilized')
             GROUP BY event`,
          )
          .all(sessionId, since)
      : db
          .prepare(
            `SELECT event, COUNT(*) as cnt
             FROM chunk_utilization
             WHERE session_id = ?
               AND event IN ('injected', 'utilized')
             GROUP BY event`,
          )
          .all(sessionId)
  ) as Array<{ event: string; cnt: number }>;

  let injected = 0;
  let utilized = 0;
  for (const r of rows) {
    if (r.event === "injected") injected = r.cnt;
    if (r.event === "utilized") utilized = r.cnt;
  }

  return injected > 0 ? utilized / injected : null;
}

// ---------- Read: cross-session summary ----------

export type UtilizationSummary = {
  injectedCount: number;
  utilizedCount: number;
  ignoredCount: number;
  l1MissCount: number;
  misleadingCount: number;
  utilizationRate: number;
  l1MissRate: number;
  ignoredRatio: number;
  sessionCount: number;
};

/**
 * Cross-session utilization summary within a time window.
 * Used by evolver signal detection.
 */
export function getRecentUtilizationSummary(
  db: DatabaseSync,
  windowMs: number = 7 * 24 * 60 * 60 * 1000, // 7 days default
): UtilizationSummary | null {
  const since = Date.now() - windowMs;

  const rows = db
    .prepare(
      `SELECT event, COUNT(*) as cnt
       FROM chunk_utilization
       WHERE timestamp >= ?
       GROUP BY event`,
    )
    .all(since) as Array<{ event: string; cnt: number }>;

  if (rows.length === 0) return null;

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.event] = r.cnt;

  const injectedCount = counts["injected"] ?? 0;
  const utilizedCount = counts["utilized"] ?? 0;
  const ignoredCount = counts["ignored"] ?? 0;
  const l1MissCount = counts["l1_miss"] ?? 0;
  const misleadingCount = counts["misleading"] ?? 0;

  const sessionRow = db
    .prepare(
      `SELECT COUNT(DISTINCT session_id) as cnt
       FROM chunk_utilization
       WHERE timestamp >= ?`,
    )
    .get(since) as { cnt: number } | undefined;

  return {
    injectedCount,
    utilizedCount,
    ignoredCount,
    l1MissCount,
    misleadingCount,
    utilizationRate: injectedCount > 0 ? utilizedCount / injectedCount : 0,
    l1MissRate: injectedCount > 0 ? l1MissCount / injectedCount : 0,
    ignoredRatio: injectedCount > 0 ? ignoredCount / injectedCount : 0,
    sessionCount: sessionRow?.cnt ?? 0,
  };
}

// ---------- Attribution helpers ----------

/**
 * Minimum "information units" for a phrase to be considered meaningful.
 * A single threshold governs both CJK and Latin text — CJK characters
 * are weighted higher (≈2.5 info-units each) because they carry more
 * information per character than Latin (1 info-unit each).
 */
const MIN_INFO_UNITS = 20;
const CJK_CHAR_WEIGHT = 2.5;

/** CJK codepoint ranges: CJK Unified, Extension A, Compat, Kana, Hangul. */
const CJK_RANGE_RE =
  /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;

/** CJK clause-splitting punctuation + newlines. */
const CJK_CLAUSE_SPLIT_RE = /[，。；！？、\n]/;

/** Latin phrase extraction: ≥18 non-newline chars starting with letter/digit. */
const LATIN_PHRASE_RE = /[\p{L}\p{N}][^\n]{18,}/gu;

/** Compute information units for a string: CJK chars count as ~2.5, others as 1. */
function infoUnits(text: string): number {
  let units = 0;
  for (const ch of text) {
    units += CJK_RANGE_RE.test(ch) ? CJK_CHAR_WEIGHT : 1;
  }
  return units;
}

/**
 * Does the text contain enough CJK to warrant clause-level splitting?
 * Threshold: >30% CJK codepoints.
 */
function hasCjkMajority(text: string): boolean {
  let cjk = 0;
  let total = 0;
  for (const ch of text) {
    total++;
    if (CJK_RANGE_RE.test(ch)) cjk++;
  }
  return total > 0 && cjk / total > 0.3;
}

/**
 * Extract meaningful phrases from text, handling both CJK and Latin scripts.
 *
 * CJK text: split by clause-level punctuation (，。；！？、), keep clauses
 * whose information weight ≥ MIN_INFO_UNITS. This avoids matching entire
 * lines as a single phrase.
 *
 * Latin/mixed text: regex extraction of ≥20-char substrings.
 *
 * Both paths use the same information-unit threshold — no separate hardcoded
 * constants per script.
 */
export function extractPhrases(text: string): string[] {
  if (!text) return [];

  if (hasCjkMajority(text)) {
    return text
      .split(CJK_CLAUSE_SPLIT_RE)
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0 && infoUnits(clause) >= MIN_INFO_UNITS);
  }

  return (text.match(LATIN_PHRASE_RE) ?? []).filter((p) => infoUnits(p) >= MIN_INFO_UNITS);
}

/**
 * Detect whether an LLM output utilized content from a snippet.
 *
 * Extracts phrases from the snippet (CJK-aware clause splitting) and checks
 * for substring presence in the output. Uses information-unit weighting so
 * the same threshold governs both scripts. Designed for statistical accuracy
 * over many samples, not per-instance precision.
 */
export function detectUtilization(snippet: string, output: string): boolean {
  if (!snippet || !output) return false;

  const phrases = extractPhrases(snippet);
  if (phrases.length === 0) return false;

  const outputLower = output.toLowerCase();
  for (const phrase of phrases) {
    if (outputLower.includes(phrase.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Compute adaptive threshold based on session utilization rate.
 *
 * effectiveThreshold = baseThreshold + (1 - utilizationRate) × thresholdBoost
 *
 * - Low utilization (0.3) → higher threshold → fewer, better chunks
 * - High utilization (0.8) → barely changed → current behavior
 * - Cold start (null) → baseThreshold unchanged
 */
export function computeAdaptiveThreshold(
  baseThreshold: number,
  utilizationRate: number | null,
  thresholdBoost: number,
): number {
  if (utilizationRate === null) return baseThreshold;
  return baseThreshold + (1 - utilizationRate) * thresholdBoost;
}
