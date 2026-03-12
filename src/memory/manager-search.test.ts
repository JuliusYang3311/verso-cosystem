/**
 * manager-search.test.ts
 *
 * Unit tests for the L0-filtered search functions:
 *   - getChunkIdsForFactor: SQL query against l0_tags, sorted by score, source-filtered
 *
 * Uses an in-memory SQLite DB (no file I/O, no embedding calls).
 * searchVectorFiltered requires sqlite-vec and is covered by manual/e2e tests.
 */

import { describe, expect, it } from "vitest";
import { getChunkIdsForFactor } from "./manager-search.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { requireNodeSqlite } from "./sqlite.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MODEL = "test-model";
const SOURCE = "memory";

function openDb() {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

type InsertChunkParams = {
  id: string;
  source?: string;
  l0Tags: Record<string, number>;
};

function insertChunk(
  db: ReturnType<typeof openDb>,
  { id, source = SOURCE, l0Tags }: InsertChunkParams,
) {
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, l0_tags)
     VALUES (?, ?, ?, 0, 1, ?, ?, ?, '[]', 0, ?)`,
  ).run(id, `path/${id}`, source, id, MODEL, `text for ${id}`, JSON.stringify(l0Tags));
}

const noFilter = { sql: "", params: [] as string[] };
const sourceFilter = { sql: ` AND source = ?`, params: [SOURCE] };

// ---------------------------------------------------------------------------
// getChunkIdsForFactor
// ---------------------------------------------------------------------------

describe("getChunkIdsForFactor", () => {
  it("returns chunks that have a positive score for the given factor", () => {
    const db = openDb();
    insertChunk(db, { id: "c1", l0Tags: { "fact-a": 0.9, "fact-b": 0.1 } });
    insertChunk(db, { id: "c2", l0Tags: { "fact-a": 0.5 } });
    insertChunk(db, { id: "c3", l0Tags: { "fact-b": 0.8 } }); // no fact-a

    const results = getChunkIdsForFactor({
      db,
      providerModel: MODEL,
      factorId: "fact-a",
      sourceFilter: noFilter,
    });

    const ids = results.map((r) => r.id);
    expect(ids).toContain("c1");
    expect(ids).toContain("c2");
    expect(ids).not.toContain("c3");
  });

  it("returns l0Score matching the stored tag value", () => {
    const db = openDb();
    insertChunk(db, { id: "c1", l0Tags: { "fact-a": 0.9 } });

    const results = getChunkIdsForFactor({
      db,
      providerModel: MODEL,
      factorId: "fact-a",
      sourceFilter: noFilter,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.l0Score).toBeCloseTo(0.9, 5);
  });

  it("returns results sorted descending by l0Score", () => {
    const db = openDb();
    insertChunk(db, { id: "c1", l0Tags: { "fact-a": 0.3 } });
    insertChunk(db, { id: "c2", l0Tags: { "fact-a": 0.9 } });
    insertChunk(db, { id: "c3", l0Tags: { "fact-a": 0.6 } });

    const results = getChunkIdsForFactor({
      db,
      providerModel: MODEL,
      factorId: "fact-a",
      sourceFilter: noFilter,
    });

    expect(results.map((r) => r.id)).toEqual(["c2", "c3", "c1"]);
    // Scores are non-increasing
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.l0Score).toBeLessThanOrEqual(results[i - 1]!.l0Score);
    }
  });

  it("ignores chunks with zero score for the factor", () => {
    const db = openDb();
    insertChunk(db, { id: "c1", l0Tags: { "fact-a": 0 } });
    insertChunk(db, { id: "c2", l0Tags: { "fact-a": 0.5 } });

    const results = getChunkIdsForFactor({
      db,
      providerModel: MODEL,
      factorId: "fact-a",
      sourceFilter: noFilter,
    });

    const ids = results.map((r) => r.id);
    expect(ids).not.toContain("c1");
    expect(ids).toContain("c2");
  });

  it("ignores chunks whose l0_tags do not include the factor at all", () => {
    const db = openDb();
    insertChunk(db, { id: "c1", l0Tags: { "fact-b": 0.8 } });
    insertChunk(db, { id: "c2", l0Tags: {} });

    const results = getChunkIdsForFactor({
      db,
      providerModel: MODEL,
      factorId: "fact-a",
      sourceFilter: noFilter,
    });

    expect(results).toHaveLength(0);
  });

  it("returns empty array when index is empty", () => {
    const db = openDb();
    const results = getChunkIdsForFactor({
      db,
      providerModel: MODEL,
      factorId: "fact-a",
      sourceFilter: noFilter,
    });
    expect(results).toEqual([]);
  });

  it("respects sourceFilter — excludes chunks from other sources", () => {
    const db = openDb();
    insertChunk(db, { id: "c1", source: SOURCE, l0Tags: { "fact-a": 0.8 } });
    insertChunk(db, { id: "c2", source: "sessions", l0Tags: { "fact-a": 0.9 } });

    const results = getChunkIdsForFactor({
      db,
      providerModel: MODEL,
      factorId: "fact-a",
      sourceFilter,
    });

    const ids = results.map((r) => r.id);
    expect(ids).toContain("c1");
    expect(ids).not.toContain("c2");
  });

  it("respects providerModel — excludes chunks indexed by a different model", () => {
    const db = openDb();
    insertChunk(db, { id: "c1", l0Tags: { "fact-a": 0.8 } }); // model = "test-model"
    // Insert a chunk with a different model
    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, l0_tags)
       VALUES (?, ?, ?, 0, 1, ?, ?, ?, '[]', 0, ?)`,
    ).run(
      "c2",
      "path/c2",
      SOURCE,
      "c2",
      "other-model",
      "text for c2",
      JSON.stringify({ "fact-a": 0.9 }),
    );

    const results = getChunkIdsForFactor({
      db,
      providerModel: MODEL,
      factorId: "fact-a",
      sourceFilter: noFilter,
    });

    const ids = results.map((r) => r.id);
    expect(ids).toContain("c1");
    expect(ids).not.toContain("c2");
  });

  it("skips chunks with malformed l0_tags (not valid JSON)", () => {
    const db = openDb();
    // Insert a chunk with malformed l0_tags via raw SQL
    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, l0_tags)
       VALUES (?, ?, ?, 0, 1, ?, ?, ?, '[]', 0, ?)`,
    ).run("bad", "path/bad", SOURCE, "bad", MODEL, "text", "NOT_VALID_JSON");
    insertChunk(db, { id: "good", l0Tags: { "fact-a": 0.7 } });

    const results = getChunkIdsForFactor({
      db,
      providerModel: MODEL,
      factorId: "fact-a",
      sourceFilter: noFilter,
    });

    const ids = results.map((r) => r.id);
    expect(ids).toContain("good");
    expect(ids).not.toContain("bad");
  });

  it("handles multiple factors in l0_tags — only matches by the requested factorId", () => {
    const db = openDb();
    insertChunk(db, { id: "c1", l0Tags: { "fact-a": 0.8, "fact-b": 0.2, "fact-c": 0.5 } });

    const resultsA = getChunkIdsForFactor({
      db,
      providerModel: MODEL,
      factorId: "fact-a",
      sourceFilter: noFilter,
    });
    const resultsB = getChunkIdsForFactor({
      db,
      providerModel: MODEL,
      factorId: "fact-b",
      sourceFilter: noFilter,
    });
    const resultsC = getChunkIdsForFactor({
      db,
      providerModel: MODEL,
      factorId: "fact-c",
      sourceFilter: noFilter,
    });

    expect(resultsA[0]!.l0Score).toBeCloseTo(0.8, 5);
    expect(resultsB[0]!.l0Score).toBeCloseTo(0.2, 5);
    expect(resultsC[0]!.l0Score).toBeCloseTo(0.5, 5);
  });
});
