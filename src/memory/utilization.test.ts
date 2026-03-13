import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { UtilizationEvent } from "./types.js";
import {
  computeAdaptiveThreshold,
  detectUtilization,
  getChunkUtilizationStats,
  getRecentUtilizationSummary,
  getSessionUtilizationRate,
  recordUtilization,
} from "./utilization.js";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE chunk_utilization (
      chunk_id    TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      event       TEXT NOT NULL,
      factor_ids  TEXT NOT NULL DEFAULT '[]',
      query_hash  TEXT,
      score       REAL,
      timestamp   INTEGER NOT NULL
    );
    CREATE INDEX idx_chunk_util_chunk ON chunk_utilization(chunk_id);
    CREATE INDEX idx_chunk_util_session ON chunk_utilization(session_id, timestamp);
  `);
  return db;
}

function makeEvent(overrides: Partial<UtilizationEvent> = {}): UtilizationEvent {
  return {
    chunkId: "chunk-1",
    sessionId: "session-1",
    event: "injected",
    factorIds: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("recordUtilization", () => {
  it("inserts events into the database", () => {
    const db = createTestDb();
    recordUtilization(db, [makeEvent({ event: "injected" }), makeEvent({ event: "utilized" })]);

    const rows = db.prepare("SELECT COUNT(*) as cnt FROM chunk_utilization").get() as {
      cnt: number;
    };
    expect(rows.cnt).toBe(2);
  });

  it("no-ops on empty events", () => {
    const db = createTestDb();
    recordUtilization(db, []);
    const rows = db.prepare("SELECT COUNT(*) as cnt FROM chunk_utilization").get() as {
      cnt: number;
    };
    expect(rows.cnt).toBe(0);
  });

  it("stores factor_ids as JSON", () => {
    const db = createTestDb();
    recordUtilization(db, [makeEvent({ factorIds: ["f1", "f2"] })]);
    const row = db.prepare("SELECT factor_ids FROM chunk_utilization").get() as {
      factor_ids: string;
    };
    expect(JSON.parse(row.factor_ids)).toEqual(["f1", "f2"]);
  });
});

describe("getChunkUtilizationStats", () => {
  it("returns null for unknown chunk", () => {
    const db = createTestDb();
    expect(getChunkUtilizationStats(db, "unknown")).toBeNull();
  });

  it("aggregates event counts correctly", () => {
    const db = createTestDb();
    recordUtilization(db, [
      makeEvent({ chunkId: "c1", event: "injected" }),
      makeEvent({ chunkId: "c1", event: "injected" }),
      makeEvent({ chunkId: "c1", event: "injected" }),
      makeEvent({ chunkId: "c1", event: "utilized" }),
      makeEvent({ chunkId: "c1", event: "ignored" }),
      makeEvent({ chunkId: "c1", event: "l1_miss" }),
    ]);

    const stats = getChunkUtilizationStats(db, "c1")!;
    expect(stats.injectCount).toBe(3);
    expect(stats.utilizeCount).toBe(1);
    expect(stats.ignoredCount).toBe(1);
    expect(stats.l1MissCount).toBe(1);
    expect(stats.utilizationRate).toBeCloseTo(1 / 3, 5);
  });

  it("returns 0 utilization rate when no injections", () => {
    const db = createTestDb();
    recordUtilization(db, [makeEvent({ chunkId: "c1", event: "utilized" })]);
    const stats = getChunkUtilizationStats(db, "c1")!;
    expect(stats.utilizationRate).toBe(0);
  });
});

describe("getSessionUtilizationRate", () => {
  it("returns null for unknown session", () => {
    const db = createTestDb();
    expect(getSessionUtilizationRate(db, "unknown")).toBeNull();
  });

  it("computes rate for a session", () => {
    const db = createTestDb();
    recordUtilization(db, [
      makeEvent({ sessionId: "s1", event: "injected" }),
      makeEvent({ sessionId: "s1", event: "injected" }),
      makeEvent({ sessionId: "s1", event: "utilized" }),
    ]);
    expect(getSessionUtilizationRate(db, "s1")).toBeCloseTo(0.5, 5);
  });

  it("respects time window", () => {
    const db = createTestDb();
    const now = Date.now();
    recordUtilization(db, [
      makeEvent({ sessionId: "s1", event: "injected", timestamp: now - 100_000 }),
      makeEvent({ sessionId: "s1", event: "utilized", timestamp: now - 100_000 }),
      makeEvent({ sessionId: "s1", event: "injected", timestamp: now }),
    ]);
    // Only the recent injection (no utilization) within 50s window
    expect(getSessionUtilizationRate(db, "s1", 50_000)).toBe(0);
  });
});

describe("getRecentUtilizationSummary", () => {
  it("returns null when no data", () => {
    const db = createTestDb();
    expect(getRecentUtilizationSummary(db)).toBeNull();
  });

  it("aggregates across sessions", () => {
    const db = createTestDb();
    const now = Date.now();
    recordUtilization(db, [
      makeEvent({ sessionId: "s1", event: "injected", timestamp: now }),
      makeEvent({ sessionId: "s1", event: "utilized", timestamp: now }),
      makeEvent({ sessionId: "s2", event: "injected", timestamp: now }),
      makeEvent({ sessionId: "s2", event: "ignored", timestamp: now }),
    ]);
    const summary = getRecentUtilizationSummary(db)!;
    expect(summary.injectedCount).toBe(2);
    expect(summary.utilizedCount).toBe(1);
    expect(summary.ignoredCount).toBe(1);
    expect(summary.utilizationRate).toBeCloseTo(0.5, 5);
    expect(summary.sessionCount).toBe(2);
  });
});

describe("detectUtilization", () => {
  it("returns false for empty inputs", () => {
    expect(detectUtilization("", "some output")).toBe(false);
    expect(detectUtilization("some snippet", "")).toBe(false);
  });

  it("returns true when output contains a phrase from snippet", () => {
    const snippet = "The memory retrieval system uses cosine similarity for ranking";
    const output =
      "Based on the data, the memory retrieval system uses cosine similarity for ranking results.";
    expect(detectUtilization(snippet, output)).toBe(true);
  });

  it("returns false when no matching phrase found", () => {
    const snippet = "The memory retrieval system uses cosine similarity";
    const output = "I don't know anything about that topic.";
    expect(detectUtilization(snippet, output)).toBe(false);
  });

  it("ignores phrases shorter than 20 characters", () => {
    const snippet = "Short phrase here.";
    const output = "Short phrase here.";
    expect(detectUtilization(snippet, output)).toBe(false);
  });

  it("is case-insensitive", () => {
    const snippet = "The Memory Retrieval System Uses Cosine Similarity";
    const output = "the memory retrieval system uses cosine similarity is great";
    expect(detectUtilization(snippet, output)).toBe(true);
  });
});

describe("computeAdaptiveThreshold", () => {
  it("returns baseThreshold when utilization is null (cold start)", () => {
    expect(computeAdaptiveThreshold(0.72, null, 0.1)).toBe(0.72);
  });

  it("increases threshold when utilization is low", () => {
    // rate=0.3, boost=0.1 → 0.72 + (1-0.3)*0.1 = 0.72 + 0.07 = 0.79
    expect(computeAdaptiveThreshold(0.72, 0.3, 0.1)).toBeCloseTo(0.79, 5);
  });

  it("barely changes threshold when utilization is high", () => {
    // rate=0.8, boost=0.1 → 0.72 + (1-0.8)*0.1 = 0.72 + 0.02 = 0.74
    expect(computeAdaptiveThreshold(0.72, 0.8, 0.1)).toBeCloseTo(0.74, 5);
  });

  it("returns baseThreshold when utilization is perfect", () => {
    expect(computeAdaptiveThreshold(0.72, 1.0, 0.1)).toBeCloseTo(0.72, 5);
  });

  it("scales linearly with thresholdBoost", () => {
    const a = computeAdaptiveThreshold(0.72, 0.5, 0.1);
    const b = computeAdaptiveThreshold(0.72, 0.5, 0.2);
    // rate=0.5 → (1-0.5)*boost → 0.5*boost
    expect(a).toBeCloseTo(0.72 + 0.05, 5);
    expect(b).toBeCloseTo(0.72 + 0.1, 5);
  });
});

describe("utilization prior formula", () => {
  it("well-utilized chunks get boosted (utilizationRate > 0.5)", () => {
    const db = createTestDb();
    // Simulate a chunk that was injected 5 times and utilized 4 times
    recordUtilization(db, [
      ...Array.from({ length: 5 }, () => makeEvent({ chunkId: "c1", event: "injected" })),
      ...Array.from({ length: 4 }, () => makeEvent({ chunkId: "c1", event: "utilized" })),
      makeEvent({ chunkId: "c1", event: "ignored" }),
    ]);
    const stats = getChunkUtilizationStats(db, "c1")!;
    expect(stats.utilizationRate).toBeCloseTo(0.8, 2);
    // Prior formula: multiplier = 1.0 + strength * (rate - 0.5)
    // With strength=0.3, rate=0.8: multiplier = 1.0 + 0.3 * 0.3 = 1.09
    const strength = 0.3;
    const multiplier = 1.0 + strength * (stats.utilizationRate - 0.5);
    expect(multiplier).toBeGreaterThan(1.0);
    expect(multiplier).toBeCloseTo(1.09, 2);
  });

  it("often-ignored chunks get penalized (utilizationRate < 0.5)", () => {
    const db = createTestDb();
    recordUtilization(db, [
      ...Array.from({ length: 5 }, () => makeEvent({ chunkId: "c2", event: "injected" })),
      makeEvent({ chunkId: "c2", event: "utilized" }),
      ...Array.from({ length: 4 }, () => makeEvent({ chunkId: "c2", event: "ignored" })),
    ]);
    const stats = getChunkUtilizationStats(db, "c2")!;
    expect(stats.utilizationRate).toBeCloseTo(0.2, 2);
    const strength = 0.3;
    const multiplier = 1.0 + strength * (stats.utilizationRate - 0.5);
    expect(multiplier).toBeLessThan(1.0);
    expect(multiplier).toBeCloseTo(0.91, 2);
  });

  it("chunks with no observations are not adjusted", () => {
    const db = createTestDb();
    const stats = getChunkUtilizationStats(db, "nonexistent");
    expect(stats).toBeNull();
    // Prior formula: skip when stats is null → multiplier stays 1.0
  });
});
