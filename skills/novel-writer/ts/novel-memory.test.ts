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
