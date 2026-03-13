import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ConsolidationCandidate, ConsolidationPipeline } from "./chunk-consolidation.js";
import {
  applyMerges,
  findMergeCandidates,
  loadConsolidationCandidates,
  tryMerge,
} from "./chunk-consolidation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a normalized embedding vector of given dimension. */
function makeEmbedding(seed: number, dims = 8): number[] {
  const vec = Array.from({ length: dims }, (_, i) => Math.sin(seed + i));
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

/** Create a candidate with sensible defaults. */
function makeCandidate(overrides: Partial<ConsolidationCandidate> = {}): ConsolidationCandidate {
  return {
    id: "chunk-1",
    path: "memory/notes.md",
    source: "memory",
    startLine: 1,
    endLine: 10,
    text: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10",
    hash: "abc123",
    model: "text-embedding-3-small",
    embedding: makeEmbedding(1),
    l0Tags: { f1: 0.8 },
    l1Sentences: [{ text: "Line 1", startChar: 0, endChar: 6 }],
    updatedAt: 1000,
    ...overrides,
  };
}

/** Create a DB with the chunks table for testing. */
function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE chunks (
      id          TEXT PRIMARY KEY,
      path        TEXT NOT NULL,
      source      TEXT NOT NULL,
      start_line  INTEGER NOT NULL,
      end_line    INTEGER NOT NULL,
      text        TEXT NOT NULL,
      hash        TEXT NOT NULL,
      model       TEXT NOT NULL DEFAULT '',
      embedding   TEXT NOT NULL DEFAULT '[]',
      l0_tags     TEXT NOT NULL DEFAULT '{}',
      l1_sentences TEXT NOT NULL DEFAULT '[]',
      updated_at  INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function insertCandidate(db: DatabaseSync, c: ConsolidationCandidate): void {
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding, l0_tags, l1_sentences, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.id,
    c.path,
    c.source,
    c.startLine,
    c.endLine,
    c.text,
    c.hash,
    c.model,
    JSON.stringify(c.embedding),
    JSON.stringify(c.l0Tags),
    JSON.stringify(c.l1Sentences),
    c.updatedAt,
  );
}

/** Minimal pipeline that echoes inputs without real embedding. */
function makeMockPipeline(overrides: Partial<ConsolidationPipeline> = {}): ConsolidationPipeline & {
  deleted: string[];
  upserted: ConsolidationCandidate[];
} {
  const deleted: string[] = [];
  const upserted: ConsolidationCandidate[] = [];
  return {
    deleted,
    upserted,
    hashText: (text) => `hash-${text.length}`,
    embedText: async () => makeEmbedding(42),
    extractL1: async (text) => [{ text: text.slice(0, 20), startChar: 0, endChar: 20 }],
    projectL0: () => ({ f1: 0.5 }),
    onDelete: (id) => deleted.push(id),
    onUpsert: (chunk) => upserted.push(chunk),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// tryMerge
// ---------------------------------------------------------------------------

describe("tryMerge", () => {
  const opts = { similarityThreshold: 0.9, maxMergedChars: 6400 };

  it("merges two identical-embedding chunks from the same path", () => {
    const emb = makeEmbedding(1);
    const a = makeCandidate({ id: "a", startLine: 1, endLine: 5, embedding: emb });
    const b = makeCandidate({ id: "b", startLine: 6, endLine: 10, embedding: emb });
    const plan = tryMerge(a, b, opts);
    expect(plan).not.toBeNull();
    expect(plan!.consumed).toEqual(["a", "b"]);
    expect(plan!.merged.startLine).toBe(1);
    expect(plan!.merged.endLine).toBe(10);
  });

  it("returns null when paths differ", () => {
    const emb = makeEmbedding(1);
    const a = makeCandidate({ id: "a", path: "a.md", embedding: emb });
    const b = makeCandidate({ id: "b", path: "b.md", embedding: emb });
    expect(tryMerge(a, b, opts)).toBeNull();
  });

  it("returns null when sources differ", () => {
    const emb = makeEmbedding(1);
    const a = makeCandidate({ id: "a", source: "memory", embedding: emb });
    const b = makeCandidate({ id: "b", source: "sessions", embedding: emb });
    expect(tryMerge(a, b, opts)).toBeNull();
  });

  it("returns null when models differ", () => {
    const emb = makeEmbedding(1);
    const a = makeCandidate({ id: "a", model: "model-a", embedding: emb });
    const b = makeCandidate({ id: "b", model: "model-b", embedding: emb });
    expect(tryMerge(a, b, opts)).toBeNull();
  });

  it("returns null when similarity is below threshold", () => {
    const a = makeCandidate({ id: "a", embedding: makeEmbedding(1) });
    const b = makeCandidate({ id: "b", embedding: makeEmbedding(100) }); // very different
    expect(tryMerge(a, b, opts)).toBeNull();
  });

  it("returns null when merged text exceeds maxMergedChars", () => {
    const emb = makeEmbedding(1);
    const longText = "x".repeat(4000);
    const a = makeCandidate({
      id: "a",
      text: longText,
      embedding: emb,
      startLine: 1,
      endLine: 100,
    });
    const b = makeCandidate({
      id: "b",
      text: longText,
      embedding: emb,
      startLine: 200,
      endLine: 300,
    });
    expect(tryMerge(a, b, { similarityThreshold: 0.9, maxMergedChars: 6400 })).toBeNull();
  });

  it("deduplicates overlapping lines", () => {
    const emb = makeEmbedding(1);
    const a = makeCandidate({
      id: "a",
      startLine: 1,
      endLine: 5,
      text: "L1\nL2\nL3\nL4\nL5",
      embedding: emb,
    });
    const b = makeCandidate({
      id: "b",
      startLine: 3,
      endLine: 8,
      text: "L3\nL4\nL5\nL6\nL7\nL8",
      embedding: emb,
    });
    const plan = tryMerge(a, b, opts);
    expect(plan).not.toBeNull();
    // L3, L4, L5 should not be duplicated
    const lines = plan!.merged.text.split("\n");
    expect(lines).toEqual(["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"]);
  });

  it("joins non-overlapping chunks with blank line separator", () => {
    const emb = makeEmbedding(1);
    const a = makeCandidate({
      id: "a",
      startLine: 1,
      endLine: 3,
      text: "A1\nA2\nA3",
      embedding: emb,
    });
    const b = makeCandidate({
      id: "b",
      startLine: 10,
      endLine: 12,
      text: "B1\nB2\nB3",
      embedding: emb,
    });
    const plan = tryMerge(a, b, opts);
    expect(plan).not.toBeNull();
    expect(plan!.merged.text).toBe("A1\nA2\nA3\n\nB1\nB2\nB3");
  });

  it("uses the earlier chunk's ID for the merged result", () => {
    const emb = makeEmbedding(1);
    const a = makeCandidate({ id: "later", startLine: 10, endLine: 20, embedding: emb });
    const b = makeCandidate({ id: "earlier", startLine: 1, endLine: 5, embedding: emb });
    const plan = tryMerge(a, b, opts);
    expect(plan!.merged.id).toBe("earlier");
  });

  it("uses max updatedAt from both chunks", () => {
    const emb = makeEmbedding(1);
    const a = makeCandidate({ id: "a", updatedAt: 100, embedding: emb });
    const b = makeCandidate({ id: "b", updatedAt: 200, embedding: emb });
    const plan = tryMerge(a, b, opts);
    expect(plan!.merged.updatedAt).toBe(200);
  });

  it("leaves embedding/l0/l1 as placeholders", () => {
    const emb = makeEmbedding(1);
    const a = makeCandidate({ id: "a", embedding: emb });
    const b = makeCandidate({ id: "b", embedding: emb });
    const plan = tryMerge(a, b, opts);
    expect(plan!.merged.embedding).toEqual([]);
    expect(plan!.merged.l0Tags).toEqual({});
    expect(plan!.merged.l1Sentences).toEqual([]);
    expect(plan!.merged.hash).toBe("");
  });
});

// ---------------------------------------------------------------------------
// findMergeCandidates
// ---------------------------------------------------------------------------

describe("findMergeCandidates", () => {
  it("returns empty for single chunk", () => {
    const plans = findMergeCandidates([makeCandidate()]);
    expect(plans).toEqual([]);
  });

  it("pairs similar chunks from the same path", () => {
    const emb = makeEmbedding(1);
    const chunks = [
      makeCandidate({ id: "a", startLine: 1, endLine: 5, embedding: emb }),
      makeCandidate({ id: "b", startLine: 6, endLine: 10, embedding: emb }),
    ];
    const plans = findMergeCandidates(chunks);
    expect(plans).toHaveLength(1);
    expect(plans[0].consumed).toContain("a");
    expect(plans[0].consumed).toContain("b");
  });

  it("does not pair chunks from different paths", () => {
    const emb = makeEmbedding(1);
    const chunks = [
      makeCandidate({ id: "a", path: "a.md", embedding: emb }),
      makeCandidate({ id: "b", path: "b.md", embedding: emb }),
    ];
    expect(findMergeCandidates(chunks)).toEqual([]);
  });

  it("greedy: once consumed, a chunk is not re-paired", () => {
    const emb = makeEmbedding(1);
    const chunks = [
      makeCandidate({ id: "a", startLine: 1, endLine: 3, embedding: emb }),
      makeCandidate({ id: "b", startLine: 4, endLine: 6, embedding: emb }),
      makeCandidate({ id: "c", startLine: 7, endLine: 9, embedding: emb }),
    ];
    const plans = findMergeCandidates(chunks);
    // a pairs with b, then c is left alone (or a pairs with b, c unpaired)
    expect(plans).toHaveLength(1);
    const consumed = new Set(plans.flatMap((p) => p.consumed));
    // Only 2 chunks consumed, 1 remains
    expect(consumed.size).toBe(2);
  });

  it("respects custom similarityThreshold", () => {
    const a = makeCandidate({ id: "a", embedding: makeEmbedding(1) });
    const b = makeCandidate({ id: "b", embedding: makeEmbedding(1.1) }); // slightly different
    // With threshold=1.0 (exact match only), these shouldn't pair
    const strict = findMergeCandidates([a, b], { similarityThreshold: 1.0 });
    expect(strict).toEqual([]);
    // With threshold=0.5 (lenient), they should pair
    const lenient = findMergeCandidates([a, b], { similarityThreshold: 0.5 });
    expect(lenient).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// loadConsolidationCandidates
// ---------------------------------------------------------------------------

describe("loadConsolidationCandidates", () => {
  it("loads candidates from the database", () => {
    const db = createTestDb();
    insertCandidate(db, makeCandidate({ id: "c1" }));
    insertCandidate(db, makeCandidate({ id: "c2", startLine: 11, endLine: 20 }));
    const candidates = loadConsolidationCandidates(db);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].id).toBe("c1");
    expect(candidates[1].id).toBe("c2");
  });

  it("filters by source", () => {
    const db = createTestDb();
    insertCandidate(db, makeCandidate({ id: "c1", source: "memory" }));
    insertCandidate(db, makeCandidate({ id: "c2", source: "sessions" }));
    const candidates = loadConsolidationCandidates(db, { source: "memory" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe("c1");
  });

  it("filters by path", () => {
    const db = createTestDb();
    insertCandidate(db, makeCandidate({ id: "c1", path: "a.md" }));
    insertCandidate(db, makeCandidate({ id: "c2", path: "b.md" }));
    const candidates = loadConsolidationCandidates(db, { path: "a.md" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe("c1");
  });

  it("skips rows with empty embeddings", () => {
    const db = createTestDb();
    insertCandidate(db, makeCandidate({ id: "c1" }));
    // Insert one with empty embedding
    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding, l0_tags, l1_sentences, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("c2", "x.md", "memory", 1, 5, "text", "h", "model", "[]", "{}", "[]", 0);
    const candidates = loadConsolidationCandidates(db);
    expect(candidates).toHaveLength(1);
  });

  it("skips rows with malformed embedding JSON", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding, l0_tags, l1_sentences, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("c1", "x.md", "memory", 1, 5, "text", "h", "model", "not-json", "{}", "[]", 0);
    const candidates = loadConsolidationCandidates(db);
    expect(candidates).toHaveLength(0);
  });

  it("gracefully handles malformed l0_tags and l1_sentences", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding, l0_tags, l1_sentences, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "c1",
      "x.md",
      "memory",
      1,
      5,
      "text",
      "h",
      "model",
      JSON.stringify([0.1, 0.2]),
      "bad",
      "bad",
      0,
    );
    const candidates = loadConsolidationCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].l0Tags).toEqual({});
    expect(candidates[0].l1Sentences).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// applyMerges
// ---------------------------------------------------------------------------

describe("applyMerges", () => {
  it("returns zero stats for empty plans", async () => {
    const db = createTestDb();
    const pipeline = makeMockPipeline();
    const stats = await applyMerges(db, [], pipeline);
    expect(stats).toEqual({ candidatesPaired: 0, merged: 0, skipped: 0 });
  });

  it("hydrates, deletes consumed, and upserts merged chunk", async () => {
    const db = createTestDb();
    const emb = makeEmbedding(1);
    const a = makeCandidate({ id: "a", startLine: 1, endLine: 5, text: "AAA", embedding: emb });
    const b = makeCandidate({ id: "b", startLine: 6, endLine: 10, text: "BBB", embedding: emb });
    insertCandidate(db, a);
    insertCandidate(db, b);

    const plan = tryMerge(a, b, { similarityThreshold: 0.5, maxMergedChars: 6400 })!;
    const pipeline = makeMockPipeline();
    const stats = await applyMerges(db, [plan], pipeline);

    expect(stats.merged).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(stats.candidatesPaired).toBe(1);

    // Consumed chunk 'b' should be deleted, 'a' kept (as merged)
    expect(pipeline.deleted).toContain("b");
    expect(pipeline.deleted).not.toContain("a"); // merged.id = "a"

    // Merged chunk should be upserted
    expect(pipeline.upserted).toHaveLength(1);
    expect(pipeline.upserted[0].id).toBe("a");
    expect(pipeline.upserted[0].hash).toBe(`hash-${plan.merged.text.length}`);
    expect(pipeline.upserted[0].embedding.length).toBeGreaterThan(0);
    expect(pipeline.upserted[0].l1Sentences.length).toBeGreaterThan(0);
    expect(pipeline.upserted[0].l0Tags).toEqual({ f1: 0.5 });

    // DB: 'b' should be gone, 'a' should have merged text
    const rows = db.prepare("SELECT id, text FROM chunks ORDER BY id").all() as Array<{
      id: string;
      text: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("a");
    expect(rows[0].text).toBe(plan.merged.text);
  });

  it("skips plan when embedText returns empty", async () => {
    const db = createTestDb();
    const emb = makeEmbedding(1);
    const a = makeCandidate({ id: "a", embedding: emb });
    const b = makeCandidate({ id: "b", embedding: emb });
    insertCandidate(db, a);
    insertCandidate(db, b);

    const plan = tryMerge(a, b, { similarityThreshold: 0.5, maxMergedChars: 6400 })!;
    const pipeline = makeMockPipeline({
      embedText: async () => [], // simulate embedding failure
    });
    const stats = await applyMerges(db, [plan], pipeline);

    expect(stats.merged).toBe(0);
    expect(stats.skipped).toBe(1);
    // Neither chunk should be deleted
    expect(pipeline.deleted).toHaveLength(0);
  });

  it("skips plan when pipeline throws and continues to next", async () => {
    const db = createTestDb();
    const emb = makeEmbedding(1);
    const a = makeCandidate({ id: "a", startLine: 1, endLine: 5, embedding: emb });
    const b = makeCandidate({ id: "b", startLine: 6, endLine: 10, embedding: emb });
    const c = makeCandidate({
      id: "c",
      startLine: 11,
      endLine: 15,
      path: "other.md",
      embedding: emb,
    });
    const d = makeCandidate({
      id: "d",
      startLine: 16,
      endLine: 20,
      path: "other.md",
      embedding: emb,
    });
    insertCandidate(db, a);
    insertCandidate(db, b);
    insertCandidate(db, c);
    insertCandidate(db, d);

    const plan1 = tryMerge(a, b, { similarityThreshold: 0.5, maxMergedChars: 6400 })!;
    const plan2 = tryMerge(c, d, { similarityThreshold: 0.5, maxMergedChars: 6400 })!;

    let callCount = 0;
    const pipeline = makeMockPipeline({
      embedText: async () => {
        callCount++;
        if (callCount === 1) throw new Error("embedding service down");
        return makeEmbedding(99);
      },
    });

    const stats = await applyMerges(db, [plan1, plan2], pipeline);
    expect(stats.merged).toBe(1);
    expect(stats.skipped).toBe(1);
  });

  it("persists correct metadata in SQL", async () => {
    const db = createTestDb();
    const emb = makeEmbedding(1);
    const a = makeCandidate({
      id: "a",
      startLine: 1,
      endLine: 5,
      text: "AAA",
      path: "test.md",
      source: "memory",
      model: "test-model",
      updatedAt: 500,
      embedding: emb,
    });
    const b = makeCandidate({
      id: "b",
      startLine: 6,
      endLine: 10,
      text: "BBB",
      path: "test.md",
      source: "memory",
      model: "test-model",
      updatedAt: 700,
      embedding: emb,
    });
    insertCandidate(db, a);
    insertCandidate(db, b);

    const plan = tryMerge(a, b, { similarityThreshold: 0.5, maxMergedChars: 6400 })!;
    await applyMerges(db, [plan], makeMockPipeline());

    const row = db.prepare("SELECT * FROM chunks WHERE id = ?").get("a") as Record<string, unknown>;
    expect(row.path).toBe("test.md");
    expect(row.source).toBe("memory");
    expect(row.model).toBe("test-model");
    expect(row.start_line).toBe(1);
    expect(row.end_line).toBe(10);
    expect(row.updated_at).toBe(700);
    // Embedding should be valid JSON array
    const storedEmb = JSON.parse(row.embedding as string);
    expect(Array.isArray(storedEmb)).toBe(true);
    expect(storedEmb.length).toBeGreaterThan(0);
    // L0 tags should be valid JSON
    const storedL0 = JSON.parse(row.l0_tags as string);
    expect(storedL0).toEqual({ f1: 0.5 });
  });
});

// ---------------------------------------------------------------------------
// End-to-end: load → find → apply
// ---------------------------------------------------------------------------

describe("consolidation end-to-end", () => {
  it("load → find → apply pipeline produces correct result", async () => {
    const db = createTestDb();
    const emb = makeEmbedding(1);
    insertCandidate(
      db,
      makeCandidate({
        id: "e2e-a",
        startLine: 1,
        endLine: 5,
        text: "Hello world line one\nLine two",
        embedding: emb,
      }),
    );
    insertCandidate(
      db,
      makeCandidate({
        id: "e2e-b",
        startLine: 6,
        endLine: 10,
        text: "Line six\nLine seven",
        embedding: emb,
      }),
    );

    // Load
    const candidates = loadConsolidationCandidates(db);
    expect(candidates).toHaveLength(2);

    // Find
    const plans = findMergeCandidates(candidates, { similarityThreshold: 0.5 });
    expect(plans).toHaveLength(1);

    // Apply
    const pipeline = makeMockPipeline();
    const stats = await applyMerges(db, plans, pipeline);
    expect(stats.merged).toBe(1);

    // Verify DB state
    const remaining = db.prepare("SELECT id FROM chunks").all() as Array<{ id: string }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("e2e-a"); // first chunk ID survives
  });
});
