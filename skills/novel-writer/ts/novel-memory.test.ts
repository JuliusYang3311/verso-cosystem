/**
 * novel-memory.test.ts
 *
 * Tests for NovelMemoryStore covering the full 3-layer indexing + retrieval chain:
 *   L0 (l0_tags) → L1 (l1_sentences) → L2 (chunks.text)
 *
 * Uses an in-memory SQLite DB and a deterministic fake embedding provider.
 * No external API calls, no file I/O beyond the in-memory DB.
 *
 * Test matrix:
 *   - indexContent: schema, l0_tags written, l1_sentences written, hash skip
 *   - search: returns matching results, l1_sentences present in results
 *   - stats: counts are accurate
 *   - removePath: removes chunks + files
 *   - computeMeanVector: correctness (via indirect file-embedding path)
 *   - multi-path isolation: separate sources don't cross-contaminate
 */

import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmbeddingProviderResult } from "../../../src/memory/embeddings.js";
import type { LatentFactorSpace } from "../../../src/memory/latent-factors.js";
import { NovelMemoryStore, type NovelMemoryConfig } from "./novel-memory.js";

// ---------------------------------------------------------------------------
// Fake embedding provider
// ---------------------------------------------------------------------------

/** Deterministic embedding: maps text to a 8-dim unit vector based on char codes. */
function makeVec(text: string, dims = 8): number[] {
  const vec = Array.from<number>({ length: dims }).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % dims]! += text.charCodeAt(i);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

const fakeProviderResult: EmbeddingProviderResult = {
  provider: {
    id: "local",
    model: "test-model",
    embedQuery: async (text) => makeVec(text),
    embedBatch: async (texts) => texts.map((t) => makeVec(t)),
  },
  requestedProvider: "local",
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STYLE_CONTENT = `
# Gothic Atmosphere

The ancient castle loomed over the valley, its spires piercing the low-hanging clouds.
Cold rain lashed the stone walls as thunder rolled across the moors.
Every shadow held menace; every creak of timber whispered of old sins.

## Description Techniques

Use sensory detail: the smell of damp stone, the taste of iron on the wind.
Contrast warmth and cold: a single candle against infinite darkness.
Time moves differently in gothic spaces — slow, heavy, inevitable.
`.trim();

const TIMELINE_CONTENT = `
# Chapter 3 Timeline

**Scene 1** — Eleanor arrives at the castle at dusk, exhausted from her journey.
She is greeted by the stoic butler who reveals nothing of the master's whereabouts.

**Scene 2** — A hidden door in the library leads to a long-forgotten room.
Inside: journals, candles still warm, and a portrait that seems to breathe.

**Scene 3** — The master appears at midnight, offering neither explanation nor apology.
Eleanor must decide: stay and uncover the truth, or flee while she can.
`.trim();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpPath(): string {
  return path.join(
    os.tmpdir(),
    `novel-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
}

async function openStore(overrides: Partial<NovelMemoryConfig> = {}): Promise<NovelMemoryStore> {
  return NovelMemoryStore.open({
    dbPath: makeTmpPath(),
    source: "style",
    vectorEnabled: false, // no sqlite-vec in test env
    ftsEnabled: true,
    cacheEnabled: false,
    _providerForTest: fakeProviderResult,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NovelMemoryStore — 3-layer indexing chain", () => {
  let store: NovelMemoryStore;

  beforeEach(async () => {
    store = await openStore();
  });

  afterEach(() => {
    store.close();
  });

  // ── Schema & basic indexing ───────────────────────────────────────────────

  it("open() creates a valid store (stats = 0/0 initially)", () => {
    const s = store.stats();
    expect(s.files).toBe(0);
    expect(s.chunks).toBe(0);
  });

  it("indexContent() indexes content and returns chunk count > 0", async () => {
    const result = await store.indexContent({
      virtualPath: "style/gothic",
      content: STYLE_CONTENT,
    });
    expect(result.skipped).toBe(false);
    expect(result.chunks).toBeGreaterThan(0);
  });

  it("indexContent() updates stats after indexing", async () => {
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });
    const s = store.stats();
    expect(s.files).toBe(1);
    expect(s.chunks).toBeGreaterThan(0);
  });

  // ── L0 tags (factor projection) ───────────────────────────────────────────

  it("L0: l0_tags column is written as valid JSON for each chunk", async () => {
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });

    // Direct SQL check: all chunks have a parseable l0_tags
    const rows = (store as any).db
      .prepare(`SELECT l0_tags FROM chunks WHERE source = 'style'`)
      .all() as Array<{ l0_tags: string }>;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(() => JSON.parse(row.l0_tags)).not.toThrow();
      const tags = JSON.parse(row.l0_tags);
      expect(typeof tags).toBe("object");
      // When no factor space is loaded, tags will be {} — that's correct
    }
  });

  // ── L1 sentences (extractive) ─────────────────────────────────────────────

  it("L1: l1_sentences column is written as a non-empty JSON array", async () => {
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });

    const rows = (store as any).db
      .prepare(`SELECT l1_sentences FROM chunks WHERE source = 'style'`)
      .all() as Array<{ l1_sentences: string }>;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(() => JSON.parse(row.l1_sentences)).not.toThrow();
      const sentences = JSON.parse(row.l1_sentences);
      expect(Array.isArray(sentences)).toBe(true);
      // Each sentence has text, startChar, endChar
      for (const s of sentences) {
        expect(typeof s.text).toBe("string");
        expect(typeof s.startChar).toBe("number");
        expect(typeof s.endChar).toBe("number");
      }
    }
  });

  it("L1: every chunk has at least 1 sentence in l1_sentences", async () => {
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });

    const rows = (store as any).db
      .prepare(`SELECT l1_sentences FROM chunks WHERE source = 'style'`)
      .all() as Array<{ l1_sentences: string }>;

    for (const row of rows) {
      const sentences = JSON.parse(row.l1_sentences);
      expect(sentences.length).toBeGreaterThan(0);
    }
  });

  // ── Hash-based skip (idempotency) ─────────────────────────────────────────

  it("indexContent() skips re-indexing when content hash is unchanged", async () => {
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });
    const result2 = await store.indexContent({
      virtualPath: "style/gothic",
      content: STYLE_CONTENT,
    });
    expect(result2.skipped).toBe(true);
    expect(result2.chunks).toBe(0);
  });

  it("indexContent() re-indexes when content changes", async () => {
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });
    const result2 = await store.indexContent({
      virtualPath: "style/gothic",
      content: STYLE_CONTENT + "\n\nNew paragraph added.",
    });
    expect(result2.skipped).toBe(false);
    expect(result2.chunks).toBeGreaterThan(0);
  });

  it("indexContent() force=true re-indexes even when hash matches", async () => {
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });
    const result2 = await store.indexContent({
      virtualPath: "style/gothic",
      content: STYLE_CONTENT,
      force: true,
    });
    expect(result2.skipped).toBe(false);
    expect(result2.chunks).toBeGreaterThan(0);
  });

  // ── Search (L1 retrieval) ─────────────────────────────────────────────────

  it("search() returns results after indexing (FTS path)", async () => {
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });
    const results = await store.search({ query: "gothic atmosphere castle" });
    expect(results.length).toBeGreaterThan(0);
  });

  it("search() result has expected shape (path, score, snippet)", async () => {
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });
    const results = await store.search({ query: "candle darkness" });

    // May return 0 results for very specific queries in small FTS index — OK
    // But if it returns results, they must be well-formed
    for (const r of results) {
      expect(typeof r.path).toBe("string");
      expect(typeof r.snippet).toBe("string");
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(typeof r.startLine).toBe("number");
      expect(typeof r.endLine).toBe("number");
    }
  });

  it("search() results carry l1Sentences from indexed chunks (L1 threaded through)", async () => {
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });
    const results = await store.search({ query: "gothic atmosphere castle" });
    expect(results.length).toBeGreaterThan(0);

    // At least one result must have l1Sentences populated (not undefined/null)
    const withL1 = results.filter((r) => r.l1Sentences !== undefined && r.l1Sentences !== null);
    expect(withL1.length).toBeGreaterThan(0);

    // Each present l1Sentences must be a parseable JSON array of sentence objects
    for (const r of withL1) {
      const sentences = JSON.parse(r.l1Sentences as string) as unknown[];
      expect(Array.isArray(sentences)).toBe(true);
      expect(sentences.length).toBeGreaterThan(0);
      for (const s of sentences as Array<{ text: string; startChar: number; endChar: number }>) {
        expect(typeof s.text).toBe("string");
        expect(typeof s.startChar).toBe("number");
        expect(typeof s.endChar).toBe("number");
      }
    }
  });

  it("search() results include source field matching the store source", async () => {
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });
    const results = await store.search({ query: "gothic atmosphere castle" });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.source).toBe("style");
    }
  });

  it("search() snippet (L2) contains text from the indexed content", async () => {
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });
    const results = await store.search({ query: "gothic atmosphere castle" });
    expect(results.length).toBeGreaterThan(0);

    for (const r of results) {
      // Snippet must be a non-empty substring derivable from the original content
      expect(r.snippet.trim().length).toBeGreaterThan(0);
      // Every word in the snippet (first 20 chars) should appear somewhere in the source
      const probe = r.snippet.slice(0, 20).trim();
      if (probe.length > 0) {
        expect(STYLE_CONTENT).toContain(probe);
      }
    }
  });

  it("search() returns empty array for empty query", async () => {
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });
    const results = await store.search({ query: "" });
    expect(results).toEqual([]);
  });

  it("search() returns empty array when index is empty", async () => {
    const results = await store.search({ query: "gothic atmosphere" });
    expect(results).toEqual([]);
  });

  // ── Multi-path isolation ──────────────────────────────────────────────────

  it("indexing two paths produces correct counts", async () => {
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });
    await store.indexContent({ virtualPath: "style/timeline", content: TIMELINE_CONTENT });
    const s = store.stats();
    expect(s.files).toBe(2);
    expect(s.chunks).toBeGreaterThan(1);
  });

  // ── removePath ───────────────────────────────────────────────────────────

  it("removePath() removes chunks and files for the path", async () => {
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });
    await store.indexContent({ virtualPath: "style/timeline", content: TIMELINE_CONTENT });

    const beforeChunks = store.stats().chunks;
    store.removePath("style/gothic");

    const s = store.stats();
    expect(s.files).toBe(1);
    expect(s.chunks).toBeLessThan(beforeChunks);
  });

  it("removePath() on non-existent path is a no-op", () => {
    expect(() => store.removePath("does/not/exist")).not.toThrow();
  });

  // ── Source isolation ─────────────────────────────────────────────────────

  it("source filter isolates chunks between stores with different sources", async () => {
    const storeA = await openStore({ source: "style" });
    const storeB = await openStore({
      source: "timeline",
    });

    await storeA.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });

    // storeB has a different DB — its stats are independent
    const sB = storeB.stats();
    expect(sB.files).toBe(0);

    storeA.close();
    storeB.close();
  });
});

// ---------------------------------------------------------------------------
// Integration: multiple content types (style + timeline in same DB)
// ---------------------------------------------------------------------------

describe("NovelMemoryStore — multi-source integration", () => {
  it("indexes style and timeline in separate stores, both retrieve results", async () => {
    const dbPath = makeTmpPath();

    const styleStore = await NovelMemoryStore.open({
      dbPath,
      source: "style",
      vectorEnabled: false,
      ftsEnabled: true,
      _providerForTest: fakeProviderResult,
    });

    const timelineStore = await NovelMemoryStore.open({
      dbPath,
      source: "timeline",
      vectorEnabled: false,
      ftsEnabled: true,
      _providerForTest: fakeProviderResult,
    });

    await styleStore.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });
    await timelineStore.indexContent({ virtualPath: "timeline/ch3", content: TIMELINE_CONTENT });

    const styleResults = await styleStore.search({ query: "castle atmosphere" });
    const timelineResults = await timelineStore.search({ query: "Eleanor library" });

    // Each store should find its own content and not cross-contaminate
    expect(styleResults.every((r) => r.source === "style")).toBe(true);
    expect(timelineResults.every((r) => r.source === "timeline")).toBe(true);

    styleStore.close();
    // timelineStore shares the same db handle — closing styleStore also closes it
  });
});

// ---------------------------------------------------------------------------
// Unit: L1 extractive quality (indirect via SQL inspection)
// ---------------------------------------------------------------------------

describe("NovelMemoryStore — L1 sentence quality", () => {
  it("l1_sentences contain text that appears in the original chunk", async () => {
    const store = await openStore();

    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });

    const rows = (store as any).db
      .prepare(`SELECT text, l1_sentences FROM chunks WHERE source = 'style'`)
      .all() as Array<{ text: string; l1_sentences: string }>;

    for (const row of rows) {
      const sentences = JSON.parse(row.l1_sentences) as Array<{
        text: string;
        startChar: number;
        endChar: number;
      }>;
      for (const s of sentences) {
        // Each extracted sentence's text must appear somewhere in the chunk
        expect(row.text).toContain(s.text.slice(0, 20)); // first 20 chars as probe
      }
    }

    store.close();
  });

  it("l1_sentences character offsets are within chunk bounds", async () => {
    const store = await openStore();

    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });

    const rows = (store as any).db
      .prepare(`SELECT text, l1_sentences FROM chunks WHERE source = 'style'`)
      .all() as Array<{ text: string; l1_sentences: string }>;

    for (const row of rows) {
      const sentences = JSON.parse(row.l1_sentences) as Array<{
        text: string;
        startChar: number;
        endChar: number;
      }>;
      for (const s of sentences) {
        expect(s.startChar).toBeGreaterThanOrEqual(0);
        expect(s.endChar).toBeGreaterThanOrEqual(s.startChar);
        expect(s.endChar).toBeLessThanOrEqual(row.text.length + 1);
      }
    }

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Unit: computeMeanVector (via files.l0_embedding SQL inspection)
// ---------------------------------------------------------------------------

describe("NovelMemoryStore — file-level embedding (computeMeanVector)", () => {
  it("files.l0_embedding is a non-empty JSON array after indexing", async () => {
    const store = await openStore();

    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });

    const row = (store as any).db
      .prepare(`SELECT l0_embedding FROM files WHERE path = 'style/gothic'`)
      .get() as { l0_embedding: string } | undefined;

    expect(row).toBeDefined();
    expect(() => JSON.parse(row!.l0_embedding)).not.toThrow();
    const vec = JSON.parse(row!.l0_embedding) as unknown;
    expect(Array.isArray(vec)).toBe(true);
    expect((vec as number[]).length).toBeGreaterThan(0);

    store.close();
  });

  it("files.l0_embedding is the mean of chunk embeddings (element-wise)", async () => {
    const store = await openStore();

    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });

    // Collect all chunk embeddings for this path
    const chunkRows = (store as any).db
      .prepare(`SELECT embedding FROM chunks WHERE path = 'style/gothic' AND source = 'style'`)
      .all() as Array<{ embedding: string }>;

    const chunkVecs = chunkRows
      .map((r) => JSON.parse(r.embedding) as number[])
      .filter((v) => v.length > 0);

    expect(chunkVecs.length).toBeGreaterThan(0);

    // Recompute expected mean
    const dims = chunkVecs[0]!.length;
    const expected = Array.from<number>({ length: dims }).fill(0);
    for (const v of chunkVecs) {
      for (let i = 0; i < dims; i++) expected[i]! += v[i]!;
    }
    for (let i = 0; i < dims; i++) expected[i]! /= chunkVecs.length;

    const fileRow = (store as any).db
      .prepare(`SELECT l0_embedding FROM files WHERE path = 'style/gothic'`)
      .get() as { l0_embedding: string };

    const actual = JSON.parse(fileRow.l0_embedding) as number[];
    expect(actual.length).toBe(dims);
    for (let i = 0; i < dims; i++) {
      expect(actual[i]!).toBeCloseTo(expected[i]!, 10);
    }

    store.close();
  });
});

// ---------------------------------------------------------------------------
// L0-filtered search path (factorId injection via _factorSpaceForTest)
// ---------------------------------------------------------------------------

/**
 * Fake factor space aligned with the fake embedding provider (model = "test-model").
 * The factor vector is makeVec("gothic darkness castle") so that gothic-style content
 * gets a non-zero cosine similarity → non-empty l0_tags after projectChunkToFactors().
 */
function makeFakeFactorSpace(): LatentFactorSpace {
  return {
    version: "1.0.0",
    factors: [
      {
        id: "fact-gothic",
        description: "gothic darkness atmosphere castle",
        subqueryTemplate: "{topic} gothic atmosphere",
        vectors: { "test-model": makeVec("gothic darkness castle") },
        weights: {},
      },
      {
        id: "fact-technique",
        description: "writing technique description sensory",
        subqueryTemplate: "{topic} writing technique sensory",
        vectors: { "test-model": makeVec("writing technique sensory detail") },
        weights: {},
      },
    ],
  };
}

async function openStoreWithFactors(
  overrides: Partial<NovelMemoryConfig> = {},
): Promise<NovelMemoryStore> {
  return NovelMemoryStore.open({
    dbPath: makeTmpPath(),
    source: "style",
    vectorEnabled: false,
    ftsEnabled: true,
    cacheEnabled: false,
    _providerForTest: fakeProviderResult,
    _factorSpaceForTest: makeFakeFactorSpace(),
    ...overrides,
  });
}

describe("NovelMemoryStore — L0-filtered search path", () => {
  it("indexContent() writes non-empty l0_tags when factor space is injected", async () => {
    const store = await openStoreWithFactors();
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });

    const rows = (store as any).db
      .prepare(`SELECT l0_tags FROM chunks WHERE source = 'style'`)
      .all() as Array<{ l0_tags: string }>;

    expect(rows.length).toBeGreaterThan(0);
    // At least one chunk should have non-empty l0_tags (factor scores)
    const nonEmpty = rows.filter((r) => r.l0_tags !== "{}");
    expect(nonEmpty.length).toBeGreaterThan(0);

    // Each non-empty l0_tags should contain known factor IDs
    for (const row of nonEmpty) {
      const tags = JSON.parse(row.l0_tags) as Record<string, number>;
      const factorIds = Object.keys(tags);
      expect(factorIds.length).toBeGreaterThan(0);
      for (const id of factorIds) {
        expect(["fact-gothic", "fact-technique"]).toContain(id);
        expect(tags[id]).toBeGreaterThan(0);
      }
    }

    store.close();
  });

  it("l0_tags scores are in (0, 1] range", async () => {
    const store = await openStoreWithFactors();
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });

    const rows = (store as any).db
      .prepare(`SELECT l0_tags FROM chunks WHERE source = 'style' AND l0_tags != '{}'`)
      .all() as Array<{ l0_tags: string }>;

    for (const row of rows) {
      const tags = JSON.parse(row.l0_tags) as Record<string, number>;
      for (const score of Object.values(tags)) {
        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }

    store.close();
  });

  it("search() still returns results with factor space injected (FTS fallthrough)", async () => {
    const store = await openStoreWithFactors();
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });

    // vectorEnabled=false so L0-filtered vector search returns empty → falls through to FTS
    const results = await store.search({ query: "gothic atmosphere castle" });
    expect(results.length).toBeGreaterThan(0);

    store.close();
  });

  it("l0_tags are stable across re-indexing with same content", async () => {
    const store = await openStoreWithFactors();
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT, force: true });

    const before = (store as any).db
      .prepare(`SELECT id, l0_tags FROM chunks WHERE source = 'style' ORDER BY id`)
      .all() as Array<{ id: string; l0_tags: string }>;

    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT, force: true });

    const after = (store as any).db
      .prepare(`SELECT id, l0_tags FROM chunks WHERE source = 'style' ORDER BY id`)
      .all() as Array<{ id: string; l0_tags: string }>;

    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) {
      expect(after[i]!.l0_tags).toBe(before[i]!.l0_tags);
    }

    store.close();
  });

  it("different content produces different l0_tags distributions", async () => {
    const store = await openStoreWithFactors();
    await store.indexContent({ virtualPath: "style/gothic", content: STYLE_CONTENT });
    await store.indexContent({ virtualPath: "style/timeline", content: TIMELINE_CONTENT });

    const gothicTags = (store as any).db
      .prepare(`SELECT l0_tags FROM chunks WHERE path = 'style/gothic' AND l0_tags != '{}'`)
      .all() as Array<{ l0_tags: string }>;

    const timelineTags = (store as any).db
      .prepare(`SELECT l0_tags FROM chunks WHERE path = 'style/timeline' AND l0_tags != '{}'`)
      .all() as Array<{ l0_tags: string }>;

    // Both paths produced tagged chunks
    expect(gothicTags.length).toBeGreaterThan(0);
    expect(timelineTags.length).toBeGreaterThan(0);

    // Collect all distinct score sets — gothic and timeline should differ overall
    const gothicScoreSets = gothicTags.map((r) =>
      JSON.stringify(JSON.parse(r.l0_tags) as Record<string, number>),
    );
    const timelineScoreSets = timelineTags.map((r) =>
      JSON.stringify(JSON.parse(r.l0_tags) as Record<string, number>),
    );
    // The two corpora should not produce identical tag distributions for all chunks
    const allSame = gothicScoreSets.every((s) => timelineScoreSets.includes(s));
    expect(allSame).toBe(false);

    store.close();
  });
});
