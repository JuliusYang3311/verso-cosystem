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

/** Minimum substring length to count as a utilization match. */
const MIN_PHRASE_LENGTH = 20;

/** Regex: extract phrases of ≥20 characters (letter/digit start). */
const PHRASE_RE = /[\p{L}\p{N}][^\n]{18,}/gu;

/**
 * Detect whether an LLM output utilized content from a snippet.
 *
 * Intentionally simple: extracts phrases ≥20 chars from the snippet and
 * checks for substring presence in the output. Designed for statistical
 * accuracy over many samples, not per-instance precision.
 */
export function detectUtilization(snippet: string, output: string): boolean {
  if (!snippet || !output) return false;

  const phrases = snippet.match(PHRASE_RE);
  if (!phrases) return false;

  const outputLower = output.toLowerCase();
  for (const phrase of phrases) {
    if (phrase.length >= MIN_PHRASE_LENGTH && outputLower.includes(phrase.toLowerCase())) {
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
