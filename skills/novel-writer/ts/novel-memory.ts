/**
 * novel-memory.ts
 * Core memory bridge for novel-writer skill.
 * Creates isolated SQLite DBs with verso's full memory schema
 * (files/chunks/vec/fts/L0/L1/embedding_cache) and exposes
 * index + search operations that reuse verso's primitives.
 */

import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { EmbeddingProvider, EmbeddingProviderResult } from "../../../src/memory/embeddings.js";
import type { EmbeddingContext } from "../../../src/memory/manager-embeddings.js";
import type { SearchRowResult } from "../../../src/memory/manager-search.js";
import type { VectorState } from "../../../src/memory/manager-vectors.js";
import { resolveAgentDir } from "../../../src/agents/agent-scope.js";
import {
  DEFAULT_CONTEXT_PARAMS,
  type ContextParams,
  loadContextParams,
} from "../../../src/agents/dynamic-context.js";
import { loadConfig } from "../../../src/config/io.js";
import { applyDiversityPipeline, type DiverseChunk } from "../../../src/memory/chunk-diversity.js";
import { createEmbeddingProvider } from "../../../src/memory/embeddings.js";
import { buildFtsQuery, mergeHybridResults } from "../../../src/memory/hybrid.js";
import {
  chunkMarkdown,
  generateL0Abstract,
  generateFileL0,
  hashText,
  ensureDir,
} from "../../../src/memory/internal.js";
import { loadFactorSpace, queryToSubqueries } from "../../../src/memory/latent-factors.js";
import {
  createBatchFailureTracker,
  runBatchWithFallback,
} from "../../../src/memory/manager-batch-failure.js";
import {
  embedChunksInBatches,
  embedQueryWithTimeout,
  computeProviderKey,
  withTimeout,
} from "../../../src/memory/manager-embeddings.js";
import { searchVector, searchKeyword } from "../../../src/memory/manager-search.js";
import {
  VECTOR_TABLE,
  FILES_VECTOR_TABLE,
  loadVectorExtension,
  ensureVectorTable,
  ensureFileVectorTable,
  vectorToBlob,
} from "../../../src/memory/manager-vectors.js";
import { ensureMemoryIndexSchema } from "../../../src/memory/memory-schema.js";
import { requireNodeSqlite } from "../../../src/memory/sqlite.js";

const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const META_KEY = "novel_memory_meta_v1";
const SNIPPET_MAX_CHARS = 700;
const VECTOR_LOAD_TIMEOUT_MS = 30_000;

type NovelMemoryMeta = {
  model: string;
  provider: string;
  providerKey: string;
  chunkTokens: number;
  chunkOverlap: number;
  vectorDims?: number;
};

export type NovelMemoryConfig = {
  dbPath: string;
  source: string;
  chunking?: { tokens: number; overlap: number };
  vectorEnabled?: boolean;
  vectorExtensionPath?: string;
  ftsEnabled?: boolean;
  cacheEnabled?: boolean;
};

/** Query settings resolved from verso config, matching main memory's defaults. */
export type NovelQuerySettings = {
  maxResults: number;
  minScore: number;
  hybrid: {
    enabled: boolean;
    vectorWeight: number;
    textWeight: number;
    candidateMultiplier: number;
  };
};

const DEFAULT_QUERY_SETTINGS: NovelQuerySettings = {
  maxResults: 6,
  minScore: 0.35,
  hybrid: {
    enabled: true,
    vectorWeight: 0.7,
    textWeight: 0.3,
    candidateMultiplier: 4,
  },
};

export class NovelMemoryStore {
  private db: DatabaseSync;
  private provider: EmbeddingProvider;
  private providerKey: string;
  private providerResult: EmbeddingProviderResult;
  private vector: VectorState;
  private vectorReady: Promise<boolean> | null = null;
  private fileVectorTableReady = false;
  private fts: { enabled: boolean; available: boolean };
  private filesFts: { available: boolean };
  private cache: { enabled: boolean };
  private source: string;
  private chunking: { tokens: number; overlap: number };
  private batchFailureTracker;
  private querySettings: NovelQuerySettings;

  private constructor(params: {
    db: DatabaseSync;
    providerResult: EmbeddingProviderResult;
    config: NovelMemoryConfig;
    ftsAvailable: boolean;
    filesFtsAvailable: boolean;
    querySettings: NovelQuerySettings;
  }) {
    this.db = params.db;
    this.providerResult = params.providerResult;
    this.provider = params.providerResult.provider;
    this.providerKey = computeProviderKey(
      this.provider,
      params.providerResult.openAi,
      params.providerResult.gemini,
    );
    this.source = params.config.source;
    this.chunking = params.config.chunking ?? { tokens: 400, overlap: 80 };
    this.cache = { enabled: params.config.cacheEnabled !== false };
    this.fts = {
      enabled: params.config.ftsEnabled !== false,
      available: params.ftsAvailable,
    };
    this.filesFts = { available: params.filesFtsAvailable };
    this.vector = {
      enabled: params.config.vectorEnabled !== false,
      available: null,
      extensionPath: params.config.vectorExtensionPath,
    };
    this.batchFailureTracker = createBatchFailureTracker(false);
    this.querySettings = params.querySettings;
  }

  static async open(config: NovelMemoryConfig): Promise<NovelMemoryStore> {
    const dir = path.dirname(config.dbPath);
    ensureDir(dir);

    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(config.dbPath, {
      allowExtension: config.vectorEnabled !== false,
    });

    const { ftsAvailable, filesFtsAvailable } = ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: EMBEDDING_CACHE_TABLE,
      ftsTable: FTS_TABLE,
      ftsEnabled: config.ftsEnabled !== false,
    });

    const providerResult = await resolveEmbeddingProvider();
    const querySettings = resolveQuerySettings();

    const store = new NovelMemoryStore({
      db,
      providerResult,
      config,
      ftsAvailable,
      filesFtsAvailable,
      querySettings,
    });

    // Read existing meta for vector dims
    const meta = store.readMeta();
    if (meta?.vectorDims) {
      store.vector.dims = meta.vectorDims;
    }

    return store;
  }

  /**
   * Index a piece of content (style chunk, timeline entry, etc.) as a virtual "file".
   * The content is chunked, embedded, and stored with L0 abstracts.
   */
  async indexContent(params: {
    /** Virtual path identifier (e.g. "style/author-chapter-1" or "timeline/entry-42") */
    virtualPath: string;
    /** The text content to index */
    content: string;
    /** Force re-index even if hash matches */
    force?: boolean;
  }): Promise<{ chunks: number; skipped: boolean }> {
    const contentHash = hashText(params.content);

    // Check if already indexed with same hash
    if (!params.force) {
      const existing = this.db
        .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
        .get(params.virtualPath, this.source) as { hash: string } | undefined;
      if (existing?.hash === contentHash) {
        return { chunks: 0, skipped: true };
      }
    }

    const chunks = chunkMarkdown(params.content, this.chunking).filter(
      (c) => c.text.trim().length > 0,
    );
    if (chunks.length === 0) {
      return { chunks: 0, skipped: false };
    }

    const ctx = this.buildEmbeddingContext();
    const embeddings = await embedChunksInBatches(ctx, chunks);
    const sample = embeddings.find((e) => e.length > 0);
    if (!sample) {
      console.error(
        `[novel-memory] embedChunksInBatches returned no vectors for ${chunks.length} chunks — indexing with FTS only`,
      );
    }
    const vectorReady = sample ? await this.ensureVectorReady(sample.length) : false;
    const now = Date.now();

    // Generate L0 abstracts
    const chunkL0s = chunks.map((c) => generateL0Abstract(c));

    // Clean old data for this path
    if (vectorReady) {
      try {
        this.db
          .prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
          .run(params.virtualPath, this.source);
      } catch {}
    }
    if (this.fts.enabled && this.fts.available) {
      try {
        this.db
          .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
          .run(params.virtualPath, this.source, this.provider.model);
      } catch {}
    }
    this.db
      .prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`)
      .run(params.virtualPath, this.source);

    // Insert chunks
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const embedding = embeddings[i] ?? [];
      const l0 = chunkL0s[i] ?? "";
      const id = hashText(
        `${this.source}:${params.virtualPath}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${this.provider.model}`,
      );

      this.db
        .prepare(
          `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, l0_abstract)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             hash=excluded.hash, model=excluded.model, text=excluded.text,
             embedding=excluded.embedding, updated_at=excluded.updated_at,
             l0_abstract=excluded.l0_abstract`,
        )
        .run(
          id,
          params.virtualPath,
          this.source,
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          this.provider.model,
          chunk.text,
          JSON.stringify(embedding),
          now,
          l0,
        );

      if (vectorReady && embedding.length > 0) {
        try {
          this.db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`).run(id);
        } catch {}
        this.db
          .prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
          .run(id, vectorToBlob(embedding));
      }

      if (this.fts.enabled && this.fts.available) {
        this.db
          .prepare(
            `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            chunk.text,
            id,
            params.virtualPath,
            this.source,
            this.provider.model,
            chunk.startLine,
            chunk.endLine,
          );
      }
    }

    // File-level L0
    const fileL0 = generateFileL0(chunkL0s);
    let fileL0Embedding: number[] = [];
    if (fileL0 && vectorReady && sample) {
      try {
        fileL0Embedding = await embedQueryWithTimeout(ctx, fileL0);
      } catch {}
      if (fileL0Embedding.length > 0) {
        if (!this.fileVectorTableReady) {
          this.fileVectorTableReady = ensureFileVectorTable(this.db, fileL0Embedding.length);
        }
        if (this.fileVectorTableReady) {
          try {
            this.db
              .prepare(`DELETE FROM ${FILES_VECTOR_TABLE} WHERE path = ?`)
              .run(params.virtualPath);
          } catch {}
          try {
            this.db
              .prepare(`INSERT INTO ${FILES_VECTOR_TABLE} (path, embedding) VALUES (?, ?)`)
              .run(params.virtualPath, vectorToBlob(fileL0Embedding));
          } catch {}
        }
      }
    }

    // Write to files_fts
    if (fileL0 && this.filesFts.available) {
      try {
        this.db.prepare(`DELETE FROM files_fts WHERE path = ?`).run(params.virtualPath);
      } catch {}
      try {
        this.db
          .prepare(`INSERT INTO files_fts (l0_abstract, path, source) VALUES (?, ?, ?)`)
          .run(fileL0, params.virtualPath, this.source);
      } catch {}
    }

    // Upsert file record
    this.db
      .prepare(
        `INSERT INTO files (path, source, hash, mtime, size, l0_abstract, l0_embedding) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           source=excluded.source, hash=excluded.hash, mtime=excluded.mtime,
           size=excluded.size, l0_abstract=excluded.l0_abstract, l0_embedding=excluded.l0_embedding`,
      )
      .run(
        params.virtualPath,
        this.source,
        contentHash,
        now,
        params.content.length,
        fileL0,
        JSON.stringify(fileL0Embedding),
      );

    // Write meta
    this.writeMeta({
      model: this.provider.model,
      provider: this.provider.id,
      providerKey: this.providerKey,
      chunkTokens: this.chunking.tokens,
      chunkOverlap: this.chunking.overlap,
      vectorDims: this.vector.dims,
    });

    return { chunks: chunks.length, skipped: false };
  }

  /**
   * Search the index using hierarchical search with hybrid (vector + FTS),
   * latent factor multi-dimensional sub-queries, and greedy MMR diversity selection.
   *
   * Pipeline:
   *   1. Embed query
   *   2. If latent factors enabled: project query → factor space → generate sub-queries
   *   3. Run hierarchical/flat hybrid search per sub-query (or single query if factors disabled)
   *   4. Merge all candidates → dedup → threshold filter → greedy MMR selection
   *   5. Return top results with maximized marginal information gain
   */
  async search(params: { query: string }): Promise<SearchRowResult[]> {
    const query = params.query.trim();
    if (!query) return [];
    const qs = this.querySettings;
    const candidates = Math.min(
      200,
      Math.max(1, Math.floor(qs.maxResults * qs.hybrid.candidateMultiplier)),
    );

    const ctx = this.buildEmbeddingContext();
    let queryVec: number[];
    try {
      queryVec = await embedQueryWithTimeout(ctx, query);
    } catch (err) {
      console.error(
        `[novel-memory] query embedding failed, falling back to FTS-only: ${String(err)}`,
      );
      queryVec = [];
    }
    const hasVector = queryVec.some((v) => v !== 0);

    // Load context params for MMR + latent factor settings
    const ctxParams = await loadContextParams();
    const mmrLambda = ctxParams.mmrLambda ?? 0.6;
    const threshold = ctxParams.baseThreshold;
    const thresholdFloor = ctxParams.thresholdFloor;

    // Determine sub-queries via latent factor projection
    let queries: Array<{ query: string; queryVec: number[]; factorId?: string }> = [
      { query, queryVec },
    ];

    if (ctxParams.latentFactorEnabled && hasVector) {
      try {
        const space = await loadFactorSpace();
        if (space.factors.length > 0) {
          const providerModel = this.provider.model;
          const { subqueries } = queryToSubqueries({
            queryVec,
            queryText: query,
            space,
            providerModel,
            useCase: "novel",
            threshold: ctxParams.factorActivationThreshold ?? 0.35,
            mmrLambda: ctxParams.factorMmrLambda ?? 0.7,
          });
          if (subqueries.length > 0) {
            // Embed sub-queries and run them alongside the original
            const subVecs = await Promise.all(
              subqueries.map((sq) => embedQueryWithTimeout(ctx, sq.subquery).catch(() => queryVec)),
            );
            queries = [
              { query, queryVec },
              ...subqueries.map((sq, i) => ({
                query: sq.subquery,
                queryVec: subVecs[i],
                factorId: sq.factorId,
              })),
            ];
          }
        }
      } catch {
        // Latent factor failure is non-fatal — continue with original query
      }
    }

    // Run searches for all queries in parallel, collect all candidates
    const allCandidates: DiverseChunk[] = [];
    await Promise.all(
      queries.map(async (q) => {
        const results = await this.runSingleSearch(q.query, q.queryVec, candidates, ctxParams);
        for (const r of results) {
          const chunk: DiverseChunk = {
            key: `${r.path}:${r.startLine}`,
            path: r.path,
            startLine: r.startLine,
            endLine: r.endLine,
            snippet: r.snippet,
            score: r.score,
            source: r.source ?? this.source,
            timestamp: r.timestamp,
            factorsUsed: q.factorId ? [{ id: q.factorId, score: r.score }] : undefined,
          };
          allCandidates.push(chunk);
        }
      }),
    );

    if (allCandidates.length === 0) return [];

    // Apply diversity pipeline: dedup → threshold → greedy MMR
    const budgetTokens = qs.maxResults * 200; // generous budget for novel search
    const { chunks: diverseResults } = applyDiversityPipeline({
      chunks: allCandidates,
      budgetTokens,
      threshold,
      thresholdFloor,
      mmrLambda,
    });

    // Convert back to SearchRowResult
    return diverseResults.slice(0, qs.maxResults).map((c) => ({
      id: c.id ?? `${c.path}:${c.startLine}`,
      path: c.path,
      startLine: c.startLine,
      endLine: c.endLine,
      source: c.source,
      snippet: c.snippet,
      score: c.score,
      timestamp: c.timestamp,
      l0Tags: c.l0Tags,
      l1Sentences: c.l1Sentences ? JSON.stringify(c.l1Sentences) : undefined,
    })) as SearchRowResult[];
  }

  /**
   * Run a single hybrid search (hierarchical → flat fallback) for one query.
   * Extracted from the old search() to support multi-query latent factor pipeline.
   */
  private async runSingleSearch(
    query: string,
    queryVec: number[],
    limit: number,
    _ctxParams: ContextParams = DEFAULT_CONTEXT_PARAMS,
  ): Promise<SearchRowResult[]> {
    const hasVector = queryVec.some((v) => v !== 0);
    const sourceFilter = this.buildSourceFilter();
    const sourceFilterAliased = this.buildSourceFilter("c");

    // Vector search
    const vectorResults = hasVector
      ? await searchVector({
          db: this.db,
          vectorTable: VECTOR_TABLE,
          providerModel: this.provider.model,
          queryVec,
          limit,
          snippetMaxChars: SNIPPET_MAX_CHARS,
          ensureVectorReady: async (dims) => this.ensureVectorReady(dims),
          sourceFilterVec: sourceFilterAliased,
          sourceFilterChunks: sourceFilter,
        }).catch(() => [])
      : [];

    if (!this.fts.available) {
      return vectorResults;
    }

    const keywordResults = await searchKeyword({
      db: this.db,
      ftsTable: FTS_TABLE,
      providerModel: this.provider.model,
      query,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      sourceFilter,
      buildFtsQuery: (raw) => buildFtsQuery(raw),
      bm25RankToScore: (rank) => -rank, // negate so softmax ranks correctly
    }).catch(() => []);

    if (keywordResults.length === 0) {
      return vectorResults;
    }

    return mergeHybridResults({
      vector: vectorResults.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: r.score,
        timestamp: r.timestamp,
      })),
      keyword: keywordResults.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        textScore: r.textScore,
      })),
      vectorWeight: this.querySettings.hybrid.vectorWeight,
      textWeight: this.querySettings.hybrid.textWeight,
    }) as SearchRowResult[];
  }

  /** Get stats about the index. */
  stats(): { files: number; chunks: number } {
    const files = (
      this.db.prepare(`SELECT COUNT(*) as c FROM files WHERE source = ?`).get(this.source) as {
        c: number;
      }
    ).c;
    const chunks = (
      this.db.prepare(`SELECT COUNT(*) as c FROM chunks WHERE source = ?`).get(this.source) as {
        c: number;
      }
    ).c;
    return { files, chunks };
  }

  /** Remove all indexed data for a virtual path. */
  removePath(virtualPath: string): void {
    try {
      this.db
        .prepare(
          `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
        )
        .run(virtualPath, this.source);
    } catch {}
    if (this.fts.available) {
      try {
        this.db
          .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ?`)
          .run(virtualPath, this.source);
      } catch {}
    }
    this.db
      .prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`)
      .run(virtualPath, this.source);
    this.db
      .prepare(`DELETE FROM files WHERE path = ? AND source = ?`)
      .run(virtualPath, this.source);
    try {
      this.db.prepare(`DELETE FROM ${FILES_VECTOR_TABLE} WHERE path = ?`).run(virtualPath);
    } catch {}
    try {
      this.db.prepare(`DELETE FROM files_fts WHERE path = ?`).run(virtualPath);
    } catch {}
  }

  close(): void {
    this.db.close();
  }

  // --- Private helpers ---

  private buildSourceFilter(alias?: string): { sql: string; params: string[] } {
    const col = alias ? `${alias}.source` : "source";
    return { sql: ` AND ${col} = ?`, params: [this.source] };
  }

  private buildEmbeddingContext(): EmbeddingContext {
    return {
      db: this.db,
      provider: this.provider,
      providerKey: this.providerKey,
      cache: this.cache,
      cacheTable: EMBEDDING_CACHE_TABLE,
      batch: {
        enabled: false,
        wait: false,
        concurrency: 1,
        pollIntervalMs: 2000,
        timeoutMs: 60_000,
      },
      openAi: this.providerResult.openAi,
      gemini: this.providerResult.gemini,
      voyage: this.providerResult.voyage,
      agentId: "novel-writer",
      runBatchWithFallback: async <T>(p: {
        provider: string;
        run: () => Promise<T>;
        fallback: () => Promise<number[][]>;
      }) => runBatchWithFallback(this.batchFailureTracker, p),
    };
  }

  private async ensureVectorReady(dimensions?: number): Promise<boolean> {
    if (!this.vector.enabled) return false;
    if (!this.vectorReady) {
      this.vectorReady = withTimeout(
        loadVectorExtension(this.db, this.vector),
        VECTOR_LOAD_TIMEOUT_MS,
        `sqlite-vec load timed out`,
      );
    }
    let ready = false;
    try {
      ready = await this.vectorReady;
    } catch {
      this.vector.available = false;
      this.vectorReady = null;
      return false;
    }
    if (ready && typeof dimensions === "number" && dimensions > 0) {
      ensureVectorTable(this.db, this.vector, dimensions);
    }
    return ready;
  }

  private readMeta(): NovelMemoryMeta | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY) as
      | { value: string }
      | undefined;
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value) as NovelMemoryMeta;
    } catch {
      return null;
    }
  }

  private writeMeta(meta: NovelMemoryMeta): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(META_KEY, JSON.stringify(meta));
  }
}

// --- Embedding provider resolution ---

async function resolveEmbeddingProvider(): Promise<EmbeddingProviderResult> {
  const cfg = loadVersoConfig();

  // Try to get provider settings from verso config
  const memSearch = cfg?.agents?.defaults?.memorySearch;
  const provider = memSearch?.provider ?? "auto";
  const model = memSearch?.model ?? "";
  // Default fallback to "local" instead of "none" — with "auto" + "none",
  // all remote providers fail silently when config is empty, leaving no provider.
  const fallback = memSearch?.fallback ?? "local";
  const remote = memSearch?.remote;
  const local = memSearch?.local;

  // Resolve agentDir the same way the main memory manager does —
  // without this, auth resolution falls back to the default agent dir
  // and custom provider keys (OAuth, newapi, etc.) are not found.
  const agentDir = resolveAgentDir(cfg, "main");

  return createEmbeddingProvider({
    config: cfg,
    agentDir,
    provider: provider as any,
    model,
    fallback: fallback as any,
    remote,
    local,
  });
}

function resolveQuerySettings(): NovelQuerySettings {
  const cfg = loadVersoConfig();
  const q = cfg?.agents?.defaults?.memorySearch?.query;
  const h = q?.hybrid;
  return {
    maxResults: q?.maxResults ?? DEFAULT_QUERY_SETTINGS.maxResults,
    minScore: q?.minScore ?? DEFAULT_QUERY_SETTINGS.minScore,
    hybrid: {
      enabled: h?.enabled ?? DEFAULT_QUERY_SETTINGS.hybrid.enabled,
      vectorWeight: h?.vectorWeight ?? DEFAULT_QUERY_SETTINGS.hybrid.vectorWeight,
      textWeight: h?.textWeight ?? DEFAULT_QUERY_SETTINGS.hybrid.textWeight,
      candidateMultiplier:
        h?.candidateMultiplier ?? DEFAULT_QUERY_SETTINGS.hybrid.candidateMultiplier,
    },
  };
}

function loadVersoConfig() {
  try {
    return loadConfig();
  } catch {
    return {} as any;
  }
}
