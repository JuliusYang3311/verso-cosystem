import { describe, expect, it } from "vitest";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./hybrid.js";

describe("memory hybrid helpers", () => {
  // -------- buildFtsQuery --------

  it("buildFtsQuery tokenizes ASCII and AND-joins", () => {
    expect(buildFtsQuery("hello world")).toBe('"hello" AND "world"');
    expect(buildFtsQuery("FOO_bar baz-1")).toBe('"FOO_bar" AND "baz" AND "1"');
    expect(buildFtsQuery("   ")).toBeNull();
  });

  it("buildFtsQuery supports Chinese characters", () => {
    expect(buildFtsQuery("项目进度")).toBe('"项目进度"');
    expect(buildFtsQuery("Alice 项目进度")).toBe('"Alice" AND "项目进度"');
  });

  it("buildFtsQuery supports mixed Unicode", () => {
    expect(buildFtsQuery("日本語テスト")).toBe('"日本語テスト"');
    expect(buildFtsQuery("café résumé")).toBe('"café" AND "résumé"');
  });

  // -------- bm25RankToScore --------

  it("bm25RankToScore: more negative rank = higher score", () => {
    // FTS5 bm25(): more negative = more relevant
    const highlyRelevant = bm25RankToScore(-5);
    const lessRelevant = bm25RankToScore(-1);
    const barelyRelevant = bm25RankToScore(-0.1);
    expect(highlyRelevant).toBeGreaterThan(lessRelevant);
    expect(lessRelevant).toBeGreaterThan(barelyRelevant);
  });

  it("bm25RankToScore returns values in (0, 1)", () => {
    expect(bm25RankToScore(-10)).toBeLessThan(1);
    expect(bm25RankToScore(-10)).toBeGreaterThan(0);
    expect(bm25RankToScore(0)).toBeCloseTo(0.5);
    expect(bm25RankToScore(10)).toBeGreaterThan(0);
    expect(bm25RankToScore(10)).toBeLessThan(0.5);
  });

  it("bm25RankToScore handles edge cases", () => {
    expect(bm25RankToScore(Infinity)).toBe(0);
    expect(bm25RankToScore(-Infinity)).toBe(0);
    expect(bm25RankToScore(NaN)).toBe(0);
  });

  // -------- mergeHybridResults (normalized rank) --------

  it("mergeHybridResults unions by id", () => {
    const merged = mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.9,
        },
      ],
      keyword: [
        {
          id: "b",
          path: "memory/b.md",
          startLine: 3,
          endLine: 4,
          source: "memory",
          snippet: "kw-b",
          textScore: 1.0,
        },
      ],
    });

    expect(merged).toHaveLength(2);
    // Both should have non-zero scores
    expect(merged[0]?.score).toBeGreaterThan(0);
    expect(merged[1]?.score).toBeGreaterThan(0);
    // Scores normalized to [0, 1]
    expect(merged[0]?.score).toBeLessThanOrEqual(1);
  });

  it("mergeHybridResults boosts items appearing in both sources", () => {
    const merged = mergeHybridResults({
      vectorWeight: 0.5,
      textWeight: 0.5,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.8,
        },
        {
          id: "b",
          path: "memory/b.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-b",
          vectorScore: 0.9,
        },
      ],
      keyword: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "kw-a",
          textScore: 0.8,
        },
      ],
    });

    // "a" appears in both sources → score should be boosted above "b"
    const a = merged.find((r) => r.id === "a");
    const b = merged.find((r) => r.id === "b");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.score).toBeGreaterThan(b!.score);
  });

  it("mergeHybridResults prefers keyword snippet when ids overlap", () => {
    const merged = mergeHybridResults({
      vectorWeight: 0.5,
      textWeight: 0.5,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.2,
        },
      ],
      keyword: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "kw-a",
          textScore: 1.0,
        },
      ],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.snippet).toBe("kw-a");
  });

  it("mergeHybridResults respects weight ratio", () => {
    // vector-only item vs keyword-only item, with heavy vector weight
    const merged = mergeHybridResults({
      vectorWeight: 0.9,
      textWeight: 0.1,
      vector: [
        {
          id: "vec",
          path: "memory/v.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "v",
          vectorScore: 0.8,
        },
      ],
      keyword: [
        {
          id: "kw",
          path: "memory/k.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "k",
          textScore: 0.9,
        },
      ],
    });

    const vec = merged.find((r) => r.id === "vec");
    const kw = merged.find((r) => r.id === "kw");
    // With 0.9 vector weight, vector-only should score higher than keyword-only
    expect(vec!.score).toBeGreaterThan(kw!.score);
  });

  it("mergeHybridResults scores are in [0, vectorWeight + textWeight]", () => {
    const merged = mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      vector: [
        {
          id: "a",
          path: "a",
          startLine: 1,
          endLine: 2,
          source: "m",
          snippet: "a",
          vectorScore: 0.9,
        },
        {
          id: "b",
          path: "b",
          startLine: 1,
          endLine: 2,
          source: "m",
          snippet: "b",
          vectorScore: 0.5,
        },
      ],
      keyword: [
        { id: "c", path: "c", startLine: 1, endLine: 2, source: "m", snippet: "c", textScore: 0.8 },
      ],
    });

    // All scores positive and bounded by vectorWeight + textWeight
    for (const r of merged) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
    // Sorted descending
    for (let i = 1; i < merged.length; i++) {
      expect(merged[i - 1].score).toBeGreaterThanOrEqual(merged[i].score);
    }
  });
});
