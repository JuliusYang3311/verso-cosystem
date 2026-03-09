import type { DatabaseSync } from "node:sqlite";
import { truncateUtf16Safe } from "../utils.js";
import { cosineSimilarity, parseEmbedding } from "./internal.js";

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

export type SearchSource = string;

export type SearchRowResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: SearchSource;
  /** Epoch ms when this chunk was last indexed. */
  timestamp?: number;
  /** L0 factor tags { factorId: score }. */
  l0Tags?: Record<string, number>;
  /** L1 extracted key sentences as JSON string. */
  l1Sentences?: string;
  /** Embedding vector — present when retrieved via the in-process fallback path. */
  embedding?: number[];
};

export async function searchVector(params: {
  db: DatabaseSync;
  vectorTable: string;
  providerModel: string;
  queryVec: number[];
  limit: number;
  snippetMaxChars: number;
  ensureVectorReady: (dimensions: number) => Promise<boolean>;
  sourceFilterVec: { sql: string; params: SearchSource[] };
  sourceFilterChunks: { sql: string; params: SearchSource[] };
}): Promise<SearchRowResult[]> {
  if (params.queryVec.length === 0 || params.limit <= 0) {
    return [];
  }
  if (await params.ensureVectorReady(params.queryVec.length)) {
    const rows = params.db
      .prepare(
        `SELECT c.id, c.path, c.start_line, c.end_line, c.text,\n` +
          `       c.source, c.updated_at, c.l0_tags, c.l1_sentences,\n` +
          `       vec_distance_cosine(v.embedding, ?) AS dist\n` +
          `  FROM ${params.vectorTable} v\n` +
          `  JOIN chunks c ON c.id = v.id\n` +
          ` WHERE c.model = ?${params.sourceFilterVec.sql}\n` +
          ` ORDER BY dist ASC\n` +
          ` LIMIT ?`,
      )
      .all(
        vectorToBlob(params.queryVec),
        params.providerModel,
        ...params.sourceFilterVec.params,
        params.limit,
      ) as Array<{
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      source: SearchSource;
      updated_at: number;
      l0_tags: string;
      l1_sentences: string;
      dist: number;
    }>;
    return rows.map((row) => {
      let l0Tags: Record<string, number> | undefined;
      try {
        l0Tags = JSON.parse(row.l0_tags || "{}");
      } catch {
        l0Tags = undefined;
      }
      return {
        id: row.id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        score: 1 - row.dist,
        snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
        source: row.source,
        timestamp: row.updated_at,
        l0Tags,
        l1Sentences: row.l1_sentences || undefined,
      };
    });
  }

  const candidates = listChunks({
    db: params.db,
    providerModel: params.providerModel,
    sourceFilter: params.sourceFilterChunks,
  });
  const scored = candidates
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(params.queryVec, chunk.embedding),
    }))
    .filter((entry) => Number.isFinite(entry.score));
  return scored
    .toSorted((a, b) => b.score - a.score)
    .slice(0, params.limit)
    .map((entry) => ({
      id: entry.chunk.id,
      path: entry.chunk.path,
      startLine: entry.chunk.startLine,
      endLine: entry.chunk.endLine,
      score: entry.score,
      snippet: truncateUtf16Safe(entry.chunk.text, params.snippetMaxChars),
      source: entry.chunk.source,
      embedding: entry.chunk.embedding,
    }));
}

export function listChunks(params: {
  db: DatabaseSync;
  providerModel: string;
  sourceFilter: { sql: string; params: SearchSource[] };
}): Array<{
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  embedding: number[];
  source: SearchSource;
}> {
  const rows = params.db
    .prepare(
      `SELECT id, path, start_line, end_line, text, embedding, source\n` +
        `  FROM chunks\n` +
        ` WHERE model = ?${params.sourceFilter.sql}`,
    )
    .all(params.providerModel, ...params.sourceFilter.params) as Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    embedding: string;
    source: SearchSource;
  }>;

  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    text: row.text,
    embedding: parseEmbedding(row.embedding),
    source: row.source,
  }));
}

export async function searchKeyword(params: {
  db: DatabaseSync;
  ftsTable: string;
  providerModel: string;
  query: string;
  limit: number;
  snippetMaxChars: number;
  sourceFilter: { sql: string; params: SearchSource[] };
  buildFtsQuery: (raw: string) => string | null;
  bm25RankToScore: (rank: number) => number;
}): Promise<Array<SearchRowResult & { textScore: number }>> {
  if (params.limit <= 0) {
    return [];
  }
  const ftsQuery = params.buildFtsQuery(params.query);
  if (!ftsQuery) {
    return [];
  }

  const rows = params.db
    .prepare(
      `SELECT id, path, source, start_line, end_line, text,\n` +
        `       bm25(${params.ftsTable}) AS rank\n` +
        `  FROM ${params.ftsTable}\n` +
        ` WHERE ${params.ftsTable} MATCH ? AND model = ?${params.sourceFilter.sql}\n` +
        ` ORDER BY rank ASC\n` +
        ` LIMIT ?`,
    )
    .all(ftsQuery, params.providerModel, ...params.sourceFilter.params, params.limit) as Array<{
    id: string;
    path: string;
    source: SearchSource;
    start_line: number;
    end_line: number;
    text: string;
    rank: number;
  }>;

  return rows.map((row) => {
    const textScore = params.bm25RankToScore(row.rank);
    return {
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: textScore,
      textScore,
      snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
      source: row.source,
    };
  });
}

// ---------- L0 tag-based chunk filtering ----------

/**
 * Load all chunk IDs that have a non-zero score for a given factor in their L0 tags.
 * Returns them sorted descending by L0 score for that factor.
 */
export function getChunkIdsForFactor(params: {
  db: DatabaseSync;
  providerModel: string;
  factorId: string;
  sourceFilter: { sql: string; params: SearchSource[] };
}): Array<{ id: string; l0Score: number }> {
  const rows = params.db
    .prepare(
      `SELECT id, l0_tags FROM chunks` +
        ` WHERE model = ?${params.sourceFilter.sql}` +
        ` AND l0_tags != '{}'`,
    )
    .all(params.providerModel, ...params.sourceFilter.params) as Array<{
    id: string;
    l0_tags: string;
  }>;

  const results: Array<{ id: string; l0Score: number }> = [];
  for (const row of rows) {
    try {
      const tags = JSON.parse(row.l0_tags) as Record<string, number>;
      const score = tags[params.factorId];
      if (score !== undefined && score > 0) {
        results.push({ id: row.id, l0Score: score });
      }
    } catch {
      // skip malformed l0_tags
    }
  }
  results.sort((a, b) => b.l0Score - a.l0Score);
  return results;
}

/**
 * Vector search restricted to a specific set of chunk IDs (L0-filtered).
 * Uses an IN clause to limit search to matching chunks.
 */
export async function searchVectorFiltered(params: {
  db: DatabaseSync;
  vectorTable: string;
  providerModel: string;
  queryVec: number[];
  chunkIds: string[];
  limit: number;
  snippetMaxChars: number;
  ensureVectorReady: (dimensions: number) => Promise<boolean>;
  sourceFilterVec: { sql: string; params: SearchSource[] };
  sourceFilterChunks: { sql: string; params: SearchSource[] };
}): Promise<SearchRowResult[]> {
  if (params.queryVec.length === 0 || params.limit <= 0 || params.chunkIds.length === 0) {
    return [];
  }
  if (await params.ensureVectorReady(params.queryVec.length)) {
    // Use IN clause to filter to L0-matching chunks
    const placeholders = params.chunkIds.map(() => "?").join(",");
    const rows = params.db
      .prepare(
        `SELECT c.id, c.path, c.start_line, c.end_line, c.text,\n` +
          `       c.source, c.updated_at, c.l0_tags, c.l1_sentences,\n` +
          `       vec_distance_cosine(v.embedding, ?) AS dist\n` +
          `  FROM ${params.vectorTable} v\n` +
          `  JOIN chunks c ON c.id = v.id\n` +
          ` WHERE c.model = ?${params.sourceFilterVec.sql}\n` +
          `   AND c.id IN (${placeholders})\n` +
          ` ORDER BY dist ASC\n` +
          ` LIMIT ?`,
      )
      .all(
        vectorToBlob(params.queryVec),
        params.providerModel,
        ...params.sourceFilterVec.params,
        ...params.chunkIds,
        params.limit,
      ) as Array<{
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      source: SearchSource;
      updated_at: number;
      l0_tags: string;
      l1_sentences: string;
      dist: number;
    }>;
    return rows.map((row) => {
      let l0Tags: Record<string, number> | undefined;
      try {
        l0Tags = JSON.parse(row.l0_tags || "{}");
      } catch {
        l0Tags = undefined;
      }
      return {
        id: row.id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        score: 1 - row.dist,
        snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
        source: row.source,
        timestamp: row.updated_at,
        l0Tags,
        l1Sentences: row.l1_sentences || undefined,
      };
    });
  }

  // Fallback: in-process cosine over filtered chunks
  const allChunks = listChunks({
    db: params.db,
    providerModel: params.providerModel,
    sourceFilter: params.sourceFilterChunks,
  });
  const idSet = new Set(params.chunkIds);
  const filtered = allChunks.filter((c) => idSet.has(c.id));
  const scored = filtered
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(params.queryVec, chunk.embedding),
    }))
    .filter((entry) => Number.isFinite(entry.score));
  return scored
    .toSorted((a, b) => b.score - a.score)
    .slice(0, params.limit)
    .map((entry) => ({
      id: entry.chunk.id,
      path: entry.chunk.path,
      startLine: entry.chunk.startLine,
      endLine: entry.chunk.endLine,
      score: entry.score,
      snippet: truncateUtf16Safe(entry.chunk.text, params.snippetMaxChars),
      source: entry.chunk.source,
      embedding: entry.chunk.embedding,
    }));
}

// ---------- File-level search functions (for hierarchical search) ----------

export type FileSearchResult = {
  path: string;
  source: SearchSource;
  score: number;
  l0Abstract: string;
};

/**
 * Vector search at file level using files_vec table.
 */
export async function searchVectorFiles(params: {
  db: DatabaseSync;
  filesVectorTable: string;
  queryVec: number[];
  limit?: number;
  ensureFileVectorReady: (dimensions: number) => Promise<boolean>;
}): Promise<FileSearchResult[]> {
  if (params.queryVec.length === 0) {
    return [];
  }
  if (params.limit !== undefined && params.limit <= 0) {
    return [];
  }
  if (!(await params.ensureFileVectorReady(params.queryVec.length))) {
    return [];
  }
  try {
    const sql =
      `SELECT f.path, f.source, f.l0_abstract,\n` +
      `       vec_distance_cosine(v.embedding, ?) AS dist\n` +
      `  FROM ${params.filesVectorTable} v\n` +
      `  JOIN files f ON f.path = v.path\n` +
      ` ORDER BY dist ASC` +
      (params.limit !== undefined ? `\n LIMIT ?` : "");
    const args =
      params.limit !== undefined
        ? [vectorToBlob(params.queryVec), params.limit]
        : [vectorToBlob(params.queryVec)];
    const rows = params.db.prepare(sql).all(...args) as Array<{
      path: string;
      source: SearchSource;
      l0_abstract: string;
      dist: number;
    }>;
    return rows.map((row) => ({
      path: row.path,
      source: row.source,
      score: 1 - row.dist,
      l0Abstract: row.l0_abstract || "",
    }));
  } catch {
    return [];
  }
}

/**
 * Keyword search at file level using files_fts table.
 */
export function searchKeywordFiles(params: {
  db: DatabaseSync;
  filesFtsTable: string;
  query: string;
  limit?: number;
  buildFtsQuery: (raw: string) => string | null;
  bm25RankToScore: (rank: number) => number;
}): FileSearchResult[] {
  if (params.limit !== undefined && params.limit <= 0) {
    return [];
  }
  const ftsQuery = params.buildFtsQuery(params.query);
  if (!ftsQuery) {
    return [];
  }
  try {
    const sql =
      `SELECT path, source, l0_abstract,\n` +
      `       bm25(${params.filesFtsTable}) AS rank\n` +
      `  FROM ${params.filesFtsTable}\n` +
      ` WHERE ${params.filesFtsTable} MATCH ?\n` +
      ` ORDER BY rank ASC` +
      (params.limit !== undefined ? `\n LIMIT ?` : "");
    const args = params.limit !== undefined ? [ftsQuery, params.limit] : [ftsQuery];
    const rows = params.db.prepare(sql).all(...args) as Array<{
      path: string;
      source: SearchSource;
      l0_abstract: string;
      rank: number;
    }>;
    return rows.map((row) => ({
      path: row.path,
      source: row.source,
      score: params.bm25RankToScore(row.rank),
      l0Abstract: row.l0_abstract || "",
    }));
  } catch {
    return [];
  }
}
