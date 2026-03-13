/**
 * novel-memory.ts
 * Core memory bridge for novel-writer skill.
 *
 * 3-layer architecture (mirrors main memory system):
 *   L0 (l0_tags):      factor projection scores per chunk — coarse pre-filter at query time
 *   L1 (l1_sentences): extractive key sentences (MMR + gap detection) — context injection
 *   L2 (chunks.text):  full chunk text — read on demand via direct SQL
 *
 * Indexing pipeline:
 *   content → chunkMarkdown()
 *     → embed chunks
 *     → L0: projectChunkToFactors()  → l0_tags { factorId: score }
 *     → L1: splitSentences() + embedBatch + extractL1Sentences() → l1_sentences
 *     → INSERT INTO chunks (l0_tags, l1_sentences, ...)
 *     → file-level vector = mean(chunk embeddings) → FILES_VECTOR_TABLE
 *
 * Search pipeline:
 *   query → embed
 *     → if latent factors: queryToSubqueries()
 *         → per factor: getChunkIdsForFactor() (L0 filter) + searchVectorFiltered()
 *     → else: searchVector() (unfiltered)
 *     → merge + dedup → applyDiversityPipeline (MMR)
 */

import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { EmbeddingProvider, EmbeddingProviderResult } from "../../../src/memory/embeddings.js";
import type { EmbeddingContext } from "../../../src/memory/manager-embeddings.js";
import type { SearchRowResult } from "../../../src/memory/manager-search.js";
import type { VectorState } from "../../../src/memory/manager-vectors.js";
import type {
  ChunkUtilizationStats,
  L1Sentence,
  UtilizationEvent,
} from "../../../src/memory/types.js";
import { resolveAgentDir } from "../../../src/agents/agent-scope.js";
import { loadContextParams } from "../../../src/agents/dynamic-context.js";
import { loadConfig } from "../../../src/config/io.js";
import { applyDiversityPipeline, type DiverseChunk } from "../../../src/memory/chunk-diversity.js";
import { createEmbeddingProvider } from "../../../src/memory/embeddings.js";
import { buildFtsQuery, mergeHybridResults } from "../../../src/memory/hybrid.js";
import { chunkMarkdown, hashText, ensureDir } from "../../../src/memory/internal.js";
import {
  type LatentFactorSpace,
  loadFactorSpace,
  projectChunkToFactors,
  queryToSubqueries,
} from "../../../src/memory/latent-factors.js";
import {
  createBatchFailureTracker,
  runBatchWithFallback,
} from "../../../src/memory/manager-batch-failure.js";
import {
  embedBatchWithRetry,
  embedChunksInBatches,
  embedQueryWithTimeout,
  computeProviderKey,
  withTimeout,
} from "../../../src/memory/manager-embeddings.js";
import { extractL1Sentences, splitSentences } from "../../../src/memory/manager-l1-extractive.js";
import {
  getChunkIdsForFactor,
  searchKeyword,
  searchVector,
  searchVectorFiltered,
} from "../../../src/memory/manager-search.js";
import {
  FILES_VECTOR_TABLE,
  VECTOR_TABLE,
  ensureFileVectorTable,
  ensureVectorTable,
  loadVectorExtension,
  vectorToBlob,
} from "../../../src/memory/manager-vectors.js";
import { ensureMemoryIndexSchema } from "../../../src/memory/memory-schema.js";
import { requireNodeSqlite } from "../../../src/memory/sqlite.js";
import {
  recordUtilization as recordUtilizationSQL,
  getChunkUtilizationStats as getChunkUtilizationStatsSQL,
  getSessionUtilizationRate as getSessionUtilizationRateSQL,
  computeAdaptiveThreshold,
} from "../../../src/memory/utilization.js";

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
  /**
   * Injected provider result for tests — bypasses resolveEmbeddingProvider().
   * Do not use in production.
   */
  _providerForTest?: EmbeddingProviderResult;
  /**
   * Injected factor space for tests — bypasses loadFactorSpace() in both
   * indexContent() and search(). Allows testing the L0-filtered search path
   * without a factor space file on disk.
   * Do not use in production.
   */
  _factorSpaceForTest?: LatentFactorSpace;
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
  private source: string;
  private chunking: { tokens: number; overlap: number };
  private batchFailureTracker;
  private querySettings: NovelQuerySettings;
  private _testFactorSpace: LatentFactorSpace | undefined;

  private constructor(params: {
    db: DatabaseSync;
    providerResult: EmbeddingProviderResult;
    config: NovelMemoryConfig;
    ftsAvailable: boolean;
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
    this.fts = {
      enabled: params.config.ftsEnabled !== false,
      available: params.ftsAvailable,
    };
    this.vector = {
      enabled: params.config.vectorEnabled !== false,
      available: null,
      extensionPath: params.config.vectorExtensionPath,
    };
    this.batchFailureTracker = createBatchFailureTracker(false);
    this.querySettings = params.querySettings;
    this._testFactorSpace = params.config._factorSpaceForTest;
  }

  static async open(config: NovelMemoryConfig): Promise<NovelMemoryStore> {
    const dir = path.dirname(config.dbPath);
    ensureDir(dir);

    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(config.dbPath, {
      allowExtension: config.vectorEnabled !== false,
    });

    const { ftsAvailable } = ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: EMBEDDING_CACHE_TABLE,
      ftsTable: FTS_TABLE,
      ftsEnabled: config.ftsEnabled !== false,
    });

    const providerResult = config._providerForTest ?? (await resolveEmbeddingProvider());
    const querySettings = resolveQuerySettings();

    const store = new NovelMemoryStore({
      db,
      providerResult,
      config,
      ftsAvailable,
      querySettings,
    });

    const meta = store.readMeta();
    if (meta?.vectorDims) {
      store.vector.dims = meta.vectorDims;
    }

    return store;
  }

  /**
   * Index a piece of content (style chunk, timeline entry, etc.) as a virtual "file".
   *
   * Produces:
   *   - l0_tags: factor projection scores (empty {} when no factor space)
   *   - l1_sentences: MMR-selected key sentences (fallback: first 3 sentences)
   *   - l0_embedding on files: mean of chunk embeddings (for file-level vector search)
   */
  async indexContent(params: {
    virtualPath: string;
    content: string;
    force?: boolean;
  }): Promise<{ chunks: number; skipped: boolean }> {
    const contentHash = hashText(params.content);

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

    // 1. Embed chunks
    const embeddings = await embedChunksInBatches(ctx, chunks);
    const sample = embeddings.find((e) => e.length > 0);
    if (!sample) {
      console.error(`[novel-memory] no chunk embeddings for ${params.virtualPath} — FTS only`);
    }
    const vectorReady = sample ? await this.ensureVectorReady(sample.length) : false;
    const now = Date.now();

    // 2. Load factor space for L0 tags (non-fatal — graceful empty fallback)
    let factorSpace: LatentFactorSpace | null = null;
    try {
      const space = this._testFactorSpace ?? (await loadFactorSpace());
      if (space.factors.length > 0) factorSpace = space;
    } catch {
      // no factor space available — l0_tags will be {}
    }

    // 3. Batch-embed all sentences across all chunks in one call (minimises round-trips)
    const chunkSentences = chunks.map((c) => splitSentences(c.text));
    const allSentenceTexts = chunkSentences.flatMap((ss) => ss.map((s) => s.text));
    const sentenceOffsets: number[] = [];
    let runningOffset = 0;
    for (const ss of chunkSentences) {
      sentenceOffsets.push(runningOffset);
      runningOffset += ss.length;
    }
    let allSentenceEmbeddings: number[][] = [];
    if (allSentenceTexts.length > 0) {
      try {
        allSentenceEmbeddings = await embedBatchWithRetry(ctx, allSentenceTexts);
      } catch {
        // non-fatal — l1_sentences will fall back to first 3 sentences
      }
    }

    // 4. Clean old data for this path
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

    // 5. Insert chunks with L0 tags + L1 sentences
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const embedding = embeddings[i] ?? [];

      // L0: factor projection tags { factorId: score }
      const l0Tags =
        factorSpace && embedding.length > 0
          ? projectChunkToFactors(embedding, factorSpace, this.provider.model)
          : {};

      // L1: MMR-selected key sentences
      const sentences = chunkSentences[i] ?? [];
      const off = sentenceOffsets[i] ?? 0;
      const sentEmbs = allSentenceEmbeddings.slice(off, off + sentences.length);
      const centroid = embedding.length > 0 ? embedding : (sentEmbs[0] ?? []);
      const l1Selected =
        sentences.length > 0 && sentEmbs.length === sentences.length
          ? extractL1Sentences(sentences, sentEmbs, centroid)
          : sentences.slice(0, 3);

      const id = hashText(
        `${this.source}:${params.virtualPath}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${this.provider.model}`,
      );

      this.db
        .prepare(
          `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, l0_tags, l1_sentences)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             hash=excluded.hash, model=excluded.model, text=excluded.text,
             embedding=excluded.embedding, updated_at=excluded.updated_at,
             l0_tags=excluded.l0_tags, l1_sentences=excluded.l1_sentences`,
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
          JSON.stringify(l0Tags),
          JSON.stringify(l1Selected),
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

    // 6. File-level vector = mean of chunk embeddings (replaces text-abstract approach)
    const validEmbeddings = embeddings.filter((e) => e.length > 0);
    const fileEmbedding = computeMeanVector(validEmbeddings);

    if (fileEmbedding.length > 0 && vectorReady) {
      if (!this.fileVectorTableReady) {
        this.fileVectorTableReady = ensureFileVectorTable(this.db, fileEmbedding.length);
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
            .run(params.virtualPath, vectorToBlob(fileEmbedding));
        } catch {}
      }
    }

    // Upsert file record (l0_embedding = mean of chunk embeddings; no l0_abstract)
    this.db
      .prepare(
        `INSERT INTO files (path, source, hash, mtime, size, l0_embedding) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           source=excluded.source, hash=excluded.hash, mtime=excluded.mtime,
           size=excluded.size, l0_embedding=excluded.l0_embedding`,
      )
      .run(
        params.virtualPath,
        this.source,
        contentHash,
        now,
        params.content.length,
        JSON.stringify(fileEmbedding),
      );

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
   * Search the index using hybrid (vector + FTS), latent factor sub-queries,
   * and greedy MMR diversity selection.
   *
   * When latent factors are active, each factor sub-query uses L0 pre-filtering
   * (getChunkIdsForFactor → searchVectorFiltered) before fine vector search.
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
      console.error(`[novel-memory] query embed failed, falling back to FTS: ${String(err)}`);
      queryVec = [];
    }
    const hasVector = queryVec.some((v) => v !== 0);

    const ctxParams = await loadContextParams();
    const mmrLambda = ctxParams.mmrLambda ?? 0.6;
    const thresholdFloor = ctxParams.thresholdFloor;

    // Adaptive threshold: raise when utilization is low
    let threshold = ctxParams.baseThreshold;
    if (ctxParams.utilizationThresholdBoost) {
      try {
        // Use a generic session rate across all novel-writer sessions
        const utilRate = this.getSessionUtilizationRate("");
        if (utilRate !== null) {
          threshold = computeAdaptiveThreshold(
            ctxParams.baseThreshold,
            utilRate,
            ctxParams.utilizationThresholdBoost,
          );
        }
      } catch {
        // Non-fatal — use base threshold
      }
    }

    let queries: Array<{ query: string; queryVec: number[]; factorId?: string }> = [
      { query, queryVec },
    ];

    if (ctxParams.latentFactorEnabled && hasVector) {
      try {
        const space = this._testFactorSpace ?? (await loadFactorSpace());
        if (space.factors.length > 0) {
          const { subqueries } = queryToSubqueries({
            queryVec,
            queryText: query,
            space,
            providerModel: this.provider.model,
            useCase: "novel",
            threshold: ctxParams.factorActivationThreshold ?? 0.35,
            mmrLambda: ctxParams.factorMmrLambda ?? 0.7,
          });
          if (subqueries.length > 0) {
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
        // latent factor failure is non-fatal
      }
    }

    const allCandidates: DiverseChunk[] = [];
    await Promise.all(
      queries.map(async (q) => {
        const results = await this.runSingleSearch(q.query, q.queryVec, candidates, q.factorId);
        for (const r of results) {
          allCandidates.push({
            key: `${r.path}:${r.startLine}`,
            path: r.path,
            startLine: r.startLine,
            endLine: r.endLine,
            snippet: r.snippet,
            score: r.score,
            source: r.source ?? this.source,
            timestamp: r.timestamp,
            l1Sentences: r.l1Sentences ? (JSON.parse(r.l1Sentences) as L1Sentence[]) : undefined,
            factorsUsed: q.factorId ? [{ id: q.factorId, score: r.score }] : undefined,
          });
        }
      }),
    );

    if (allCandidates.length === 0) return [];

    const { chunks: diverseResults } = applyDiversityPipeline({
      chunks: allCandidates,
      budgetTokens: qs.maxResults * 200,
      threshold,
      thresholdFloor,
      mmrLambda,
    });

    // Apply utilization prior: boost well-utilized chunks, penalize ignored ones
    let finalResults = diverseResults;
    if (ctxParams.utilizationPriorEnabled !== false) {
      const strength = ctxParams.utilizationPriorStrength ?? 0.3;
      const minSamples = ctxParams.utilizationMinSamples ?? 3;
      if (strength > 0) {
        finalResults = diverseResults.map((c) => {
          const chunkId = c.id ?? `${c.path}:${c.startLine}`;
          const stats = this.getChunkUtilizationStats(chunkId);
          if (!stats || stats.injectCount < minSamples) return c;
          const multiplier = 1.0 + strength * (stats.utilizationRate - 0.5);
          return { ...c, score: c.score * multiplier };
        });
        finalResults.sort((a, b) => b.score - a.score);
      }
    }

    return finalResults.slice(0, qs.maxResults).map((c) => ({
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
  }

  // --- Utilization tracking (feedback loop integration) ---

  /** Record utilization events for injected chunks. */
  recordUtilization(events: UtilizationEvent[]): void {
    recordUtilizationSQL(this.db, events);
  }

  /** Get aggregate utilization stats for a chunk. */
  getChunkUtilizationStats(chunkId: string): ChunkUtilizationStats | null {
    return getChunkUtilizationStatsSQL(this.db, chunkId);
  }

  /** Get session-level utilization rate. */
  getSessionUtilizationRate(sessionId: string, windowMs?: number): number | null {
    return getSessionUtilizationRateSQL(this.db, sessionId, windowMs);
  }

  close(): void {
    this.db.close();
  }

  // --- Private helpers ---

  /**
   * Run one hybrid search.
   *
   * When factorId is set, restricts vector search to L0-matching chunks via
   * getChunkIdsForFactor + searchVectorFiltered. Falls through to unfiltered
   * search when the factor has no matching chunks in the index.
   */
  private async runSingleSearch(
    query: string,
    queryVec: number[],
    limit: number,
    factorId: string | undefined,
  ): Promise<SearchRowResult[]> {
    const hasVector = queryVec.some((v) => v !== 0);
    const sourceFilter = this.buildSourceFilter();
    const sourceFilterAliased = this.buildSourceFilter("c");

    // L0-filtered path: use factor tags as pre-filter when factorId is known
    if (factorId && hasVector) {
      const l0Matches = getChunkIdsForFactor({
        db: this.db,
        providerModel: this.provider.model,
        factorId,
        sourceFilter,
      });
      if (l0Matches.length > 0) {
        const vectorResults = await searchVectorFiltered({
          db: this.db,
          vectorTable: VECTOR_TABLE,
          providerModel: this.provider.model,
          queryVec,
          chunkIds: l0Matches.map((m) => m.id),
          limit,
          snippetMaxChars: SNIPPET_MAX_CHARS,
          ensureVectorReady: async (dims) => this.ensureVectorReady(dims),
          sourceFilterVec: sourceFilterAliased,
          sourceFilterChunks: sourceFilter,
        }).catch(() => []);
        if (vectorResults.length > 0) return vectorResults;
        // fallthrough: no L0-filtered results → unfiltered
      }
    }

    // Unfiltered vector search
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

    if (!this.fts.available) return vectorResults;

    const keywordResults = await searchKeyword({
      db: this.db,
      ftsTable: FTS_TABLE,
      providerModel: this.provider.model,
      query,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      sourceFilter,
      buildFtsQuery: (raw) => buildFtsQuery(raw),
      bm25RankToScore: (rank) => -rank,
    }).catch(() => []);

    if (keywordResults.length === 0) return vectorResults;

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
        l1Sentences: r.l1Sentences,
      })),
      keyword: keywordResults.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        textScore: r.textScore,
        l1Sentences: r.l1Sentences,
      })),
      vectorWeight: this.querySettings.hybrid.vectorWeight,
      textWeight: this.querySettings.hybrid.textWeight,
    }) as SearchRowResult[];
  }

  private buildSourceFilter(alias?: string): { sql: string; params: string[] } {
    const col = alias ? `${alias}.source` : "source";
    return { sql: ` AND ${col} = ?`, params: [this.source] };
  }

  private buildEmbeddingContext(): EmbeddingContext {
    return {
      db: this.db,
      provider: this.provider,
      providerKey: this.providerKey,
      cache: { enabled: true },
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

// --- Private utilities ---

/** Compute element-wise mean of a set of equal-length vectors. */
function computeMeanVector(vecs: number[][]): number[] {
  if (vecs.length === 0) return [];
  const dims = vecs[0]!.length;
  if (dims === 0) return [];
  const mean = Array.from<number>({ length: dims }).fill(0);
  for (const v of vecs) {
    for (let i = 0; i < dims; i++) mean[i]! += v[i]!;
  }
  for (let i = 0; i < dims; i++) mean[i]! /= vecs.length;
  return mean;
}

// --- Provider & config resolution ---

async function resolveEmbeddingProvider(): Promise<EmbeddingProviderResult> {
  const cfg = loadVersoConfig();
  const memSearch = cfg?.agents?.defaults?.memorySearch;
  const provider = memSearch?.provider ?? "auto";
  const model = memSearch?.model ?? "";
  const fallback = memSearch?.fallback ?? "local";
  const remote = memSearch?.remote;
  const local = memSearch?.local;
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
