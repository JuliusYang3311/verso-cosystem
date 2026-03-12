import type { DatabaseSync } from "node:sqlite";
import chokidar, { type FSWatcher } from "chokidar";
import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ContextParams } from "../agents/dynamic-context.js";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import type { VersoConfig } from "../config/config.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "./types.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { loadContextParams } from "../agents/dynamic-context.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { DEFAULT_GEMINI_EMBEDDING_MODEL } from "./embeddings-gemini.js";
import { DEFAULT_OPENAI_EMBEDDING_MODEL } from "./embeddings-openai.js";
import { DEFAULT_VOYAGE_EMBEDDING_MODEL } from "./embeddings-voyage.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderResult,
  type GeminiEmbeddingClient,
  type OpenAiEmbeddingClient,
  type VoyageEmbeddingClient,
} from "./embeddings.js";
import { buildFtsQuery, mergeHybridResults } from "./hybrid.js";
import {
  buildFileEntry,
  chunkMarkdown,
  ensureDir,
  hashText,
  isMemoryPath,
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  type MemoryFileEntry,
  runWithConcurrency,
} from "./internal.js";
import {
  loadFactorSpace,
  ensureFactorVectors,
  queryToSubqueries,
  projectChunkToFactors,
  findGapCutoff,
} from "./latent-factors.js";
import {
  BATCH_FAILURE_LIMIT,
  type BatchFailureTracker,
  createBatchFailureTracker,
  runBatchWithFallback,
} from "./manager-batch-failure.js";
import { seedEmbeddingCache, pruneEmbeddingCacheIfNeeded } from "./manager-embedding-cache.js";
import {
  type EmbeddingContext,
  computeProviderKey,
  embedChunksInBatches,
  embedChunksWithBatch,
  embedBatchWithRetry,
  embedQueryWithTimeout,
  withTimeout,
} from "./manager-embeddings.js";
import {
  splitSentences,
  extractL1Sentences,
  type ExtractedSentence,
} from "./manager-l1-extractive.js";
import {
  searchKeyword,
  searchVector,
  searchVectorFiltered,
  getChunkIdsForFactor,
  type SearchRowResult,
} from "./manager-search.js";
import {
  type VectorState,
  VECTOR_TABLE,
  FILES_VECTOR_TABLE,
  vectorToBlob,
  loadVectorExtension,
  ensureVectorTable,
  dropVectorTable,
  ensureFileVectorTable,
} from "./manager-vectors.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { requireNodeSqlite } from "./sqlite.js";

type MemoryIndexMeta = {
  model: string;
  provider: string;
  providerKey?: string;
  chunkTokens: number;
  chunkOverlap: number;
  vectorDims?: number;
};

type MemorySyncProgressState = {
  completed: number;
  total: number;
  label?: string;
  report: (update: MemorySyncProgressUpdate) => void;
};

const META_KEY = "memory_index_meta_v1";
const SNIPPET_MAX_CHARS = 700;
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const EMBEDDING_INDEX_CONCURRENCY = 4;
const VECTOR_LOAD_TIMEOUT_MS = 30_000;

const log = createSubsystemLogger("memory");

const INDEX_CACHE = new Map<string, MemoryIndexManager>();
const INDEX_CACHE_MAX = 20;

export class MemoryIndexManager implements MemorySearchManager {
  private readonly cacheKey: string;
  private readonly cfg: VersoConfig;
  private readonly agentId: string;
  private readonly workspaceDir: string;
  private readonly settings: ResolvedMemorySearchConfig;
  private readonly customSessionsDir?: string;
  private provider: EmbeddingProvider;
  private readonly requestedProvider:
    | "openai"
    | "local"
    | "gemini"
    | "anthropic"
    | "voyage"
    | "auto";
  private fallbackFrom?: "openai" | "local" | "gemini" | "anthropic" | "voyage";
  private fallbackReason?: string;
  private openAi?: OpenAiEmbeddingClient;
  private gemini?: GeminiEmbeddingClient;
  private voyage?: VoyageEmbeddingClient;
  private batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  private batchFailureTracker: BatchFailureTracker;
  private db: DatabaseSync;
  /** Reference to the original DB during atomic reindex, for L1 cache lookups. */
  private l1CacheDb: DatabaseSync | null = null;
  private readonly sources: Set<MemorySource>;
  private providerKey: string;
  private readonly cache: { enabled: boolean; maxEntries?: number };
  private readonly vector: VectorState;
  private readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  };
  private readonly filesFts: {
    available: boolean;
  };
  private fileVectorTableReady = false;
  private vectorReady: Promise<boolean> | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private dirty = false;
  /** In-memory buffers for direct session turn indexing (no file I/O). */
  private sessionBuffers = new Map<string, { bytes: number; turns: number; chunks: string[] }>();
  private syncing: Promise<void> | null = null;

  static async get(params: {
    cfg: VersoConfig;
    agentId: string;
  }): Promise<MemoryIndexManager | null> {
    const { cfg, agentId } = params;
    const settings = resolveMemorySearchConfig(cfg, agentId);
    if (!settings) {
      return null;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const key = `${agentId}:${workspaceDir}:${JSON.stringify(settings)}`;
    const existing = INDEX_CACHE.get(key);
    if (existing) {
      return existing;
    }
    const providerResult = await createEmbeddingProvider({
      config: cfg,
      agentDir: resolveAgentDir(cfg, agentId),
      provider: settings.provider,
      remote: settings.remote,
      model: settings.model,
      fallback: settings.fallback,
      local: settings.local,
    });
    const manager = new MemoryIndexManager({
      cacheKey: key,
      cfg,
      agentId,
      workspaceDir,
      settings,
      providerResult,
    });
    // Evict oldest cached manager if at limit
    if (INDEX_CACHE.size >= INDEX_CACHE_MAX) {
      const oldestKey = INDEX_CACHE.keys().next().value as string;
      const oldest = INDEX_CACHE.get(oldestKey);
      INDEX_CACHE.delete(oldestKey);
      if (oldest) {
        log.warn("memory: INDEX_CACHE at limit, evicting oldest", { key: oldestKey });
        try {
          void oldest.close();
        } catch {
          // close may throw if already closed; safe to ignore
        }
      }
    }
    INDEX_CACHE.set(key, manager);
    return manager;
  }

  /**
   * Create an isolated MemoryIndexManager that is NOT added to the global cache.
   * Caller is responsible for calling close() when done.
   *
   * Used by orchestration to create temporary, independent memory engines
   * with the full feature set (embedding, latent factors, MMR, three-layer
   * memory, hybrid search) but isolated from the main agent's memory.
   *
   * Modeled after novel-writer's NovelMemoryStore.open() pattern:
   * independent DB, independent provider, independent lifecycle.
   */
  static async createIsolated(params: {
    cfg: VersoConfig;
    agentId: string;
    workspaceDir: string;
    /** Custom DB file path. Overrides the default `workspaceDir/memory.sqlite`. */
    dbPath?: string;
    providerResult?: EmbeddingProviderResult;
    sources?: Array<"memory" | "sessions">;
    customSessionsDir?: string;
  }): Promise<MemoryIndexManager | null> {
    const { cfg, agentId, workspaceDir } = params;
    const settings = resolveMemorySearchConfig(cfg, agentId);
    if (!settings) {
      return null;
    }
    // Override store path so the SQLite DB lives inside the isolated workspace
    // instead of the shared ~/.verso/memory/<agentId>.sqlite
    const isolatedSettings = {
      ...settings,
      sources: params.sources ?? settings.sources,
      store: {
        ...settings.store,
        path: params.dbPath ?? path.join(workspaceDir, "memory.sqlite"),
      },
      // Disable filesystem sync for isolated instances — they use indexContent()
      // (virtual content, no files on disk). Sync would scan the workspace,
      // find no files, and DELETE all virtually-indexed chunks.
      sync: {
        ...settings.sync,
        onSearch: false,
        onSessionStart: false,
        watchInterval: 0,
      },
    };
    const providerResult =
      params.providerResult ??
      (await createEmbeddingProvider({
        config: cfg,
        agentDir: resolveAgentDir(cfg, agentId),
        provider: settings.provider,
        remote: settings.remote,
        model: settings.model,
        fallback: settings.fallback,
        local: settings.local,
      }));
    const key = `isolated:${workspaceDir}:${Date.now()}`;
    // Not added to INDEX_CACHE — caller owns the lifecycle
    return new MemoryIndexManager({
      cacheKey: key,
      cfg,
      agentId,
      workspaceDir,
      settings: isolatedSettings,
      providerResult,
      customSessionsDir: params.customSessionsDir,
    });
  }

  private constructor(params: {
    cacheKey: string;
    cfg: VersoConfig;
    agentId: string;
    workspaceDir: string;
    settings: ResolvedMemorySearchConfig;
    providerResult: EmbeddingProviderResult;
    customSessionsDir?: string;
  }) {
    this.cacheKey = params.cacheKey;
    this.cfg = params.cfg;
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;
    this.settings = params.settings;
    this.customSessionsDir = params.customSessionsDir;
    this.provider = params.providerResult.provider;
    this.requestedProvider = params.providerResult.requestedProvider;
    this.fallbackFrom = params.providerResult.fallbackFrom;
    this.fallbackReason = params.providerResult.fallbackReason;
    this.openAi = params.providerResult.openAi;
    this.gemini = params.providerResult.gemini;
    this.voyage = params.providerResult.voyage;
    this.sources = new Set(params.settings.sources);
    this.db = this.openDatabase();
    this.providerKey = computeProviderKey(this.provider, this.openAi, this.gemini);
    this.cache = {
      enabled: params.settings.cache.enabled,
      maxEntries: params.settings.cache.maxEntries,
    };
    this.fts = { enabled: params.settings.query.hybrid.enabled, available: false };
    this.filesFts = { available: false };
    this.ensureSchema();
    this.vector = {
      enabled: params.settings.store.vector.enabled,
      available: null,
      extensionPath: params.settings.store.vector.extensionPath,
    };
    const meta = this.readMeta();
    if (meta?.vectorDims) {
      this.vector.dims = meta.vectorDims;
    }
    this.ensureWatcher();
    this.ensureIntervalSync();
    this.dirty = this.sources.has("memory");
    this.batch = this.resolveBatchConfig();
    this.batchFailureTracker = createBatchFailureTracker(this.batch.enabled);
  }

  private async loadContextParams(): Promise<Partial<ContextParams>> {
    try {
      const { getContextParamsPath } = await import("../evolver/gep/paths.js");
      const filePath = getContextParamsPath();
      if (fsSync.existsSync(filePath)) {
        const content = await fs.readFile(filePath, "utf-8");
        return JSON.parse(content) as Partial<ContextParams>;
      }
      return {};
    } catch {
      return {};
    }
  }

  async warmSession(_sessionKey?: string): Promise<void> {
    if (!this.settings.sync.onSessionStart) {
      return;
    }
    void this.sync({ reason: "session-start" }).catch((err) => {
      log.warn(`memory sync failed (session-start): ${String(err)}`);
    });
  }

  async search(
    query: string,
    opts?: {
      minScore?: number;
      sessionKey?: string;
    },
  ): Promise<MemorySearchResult[]> {
    void this.warmSession(opts?.sessionKey);
    if (this.settings.sync.onSearch && this.dirty) {
      void this.sync({ reason: "search" }).catch((err) => {
        log.warn(`memory sync failed (search): ${String(err)}`);
      });
    }
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }
    const hybrid = this.settings.query.hybrid;
    const candidates = 50;

    const ctx = this.buildEmbeddingContext();
    const queryVec = await embedQueryWithTimeout(ctx, cleaned);
    const hasVector = queryVec.some((v) => v !== 0);

    // Load context params (evolver-tunable via context_params.json)
    // Priority: user config > evolver context_params > hardcoded defaults
    const contextParams = await this.loadContextParams();
    const hybridVectorWeight = hybrid.vectorWeight ?? contextParams.hybridVectorWeight ?? 0.7;
    const hybridTextWeight = hybrid.textWeight ?? 1 - hybridVectorWeight;
    const minScore =
      opts?.minScore ?? this.settings.query.minScore ?? contextParams.hybridMinScore ?? 0;

    const sourceFilterVec = this.buildSourceFilter("c");
    const sourceFilterChunks = this.buildSourceFilter();

    // L0 tag-based multi-factor search
    if (hasVector) {
      try {
        // Project query onto factor space and build sub-queries
        let space = await loadFactorSpace();
        if (space.factors.length > 0) {
          await ensureFactorVectors(space, this.provider.model, "memory", (texts) =>
            ctx.provider.embedBatch(texts),
          ).catch(() => {});
          space = await loadFactorSpace();
        }
        const latentFactorEnabled = contextParams.latentFactorEnabled ?? true;
        const { subqueries } = latentFactorEnabled
          ? queryToSubqueries({
              queryVec,
              queryText: cleaned,
              space,
              providerModel: this.provider.model,
              useCase: "memory",
              threshold: contextParams.factorActivationThreshold ?? 1 / space.factors.length,
              mmrLambda: contextParams.factorMmrLambda ?? 0.7,
            })
          : { subqueries: [] };

        // Embed all sub-query texts in a single batch
        const subQueryTexts = subqueries.map((s) => s.subquery);
        const subQueryVecs = await ctx.provider
          .embedBatch(subQueryTexts)
          .catch(() => [] as number[][]);

        // Build per-factor search inputs
        const searchInputs: Array<{ queryVec: number[]; queryText: string; factorId: string }> = [
          { queryVec, queryText: cleaned, factorId: "_primary" },
          ...subqueries
            .map((s, i) => ({
              queryVec: subQueryVecs[i] ?? [],
              queryText: s.subquery,
              factorId: s.factorId,
            }))
            .filter((s) => s.queryVec.length > 0),
        ];

        const perFactorLimit = candidates;
        const baseSearchParams = {
          db: this.db,
          vectorTable: VECTOR_TABLE,
          providerModel: this.provider.model,
          snippetMaxChars: SNIPPET_MAX_CHARS,
          ensureVectorReady: async (dims: number) => await this.ensureVectorReady(dims),
          sourceFilterVec,
          sourceFilterChunks,
        };

        // Run all factor searches in parallel
        // Primary query: unfiltered vector search
        // Factor sub-queries: L0 tag filtered via gap detection
        const allResults = await Promise.allSettled(
          searchInputs.map((input) => {
            if (input.factorId === "_primary") {
              // Primary query — search all chunks, no L0 filter
              return searchVector({
                ...baseSearchParams,
                queryVec: input.queryVec,
                limit: perFactorLimit,
              });
            }
            // Factor sub-query — L0 tag filtering
            const l0Candidates = getChunkIdsForFactor({
              db: this.db,
              providerModel: this.provider.model,
              factorId: input.factorId,
              sourceFilter: sourceFilterChunks,
            });
            if (l0Candidates.length === 0) {
              // No chunks match this factor — skip entirely
              return Promise.resolve([] as SearchRowResult[]);
            }
            // Gap detection on L0 scores to select matching chunks
            const l0Scores = l0Candidates.map((c) => c.l0Score);
            const cutoff = findGapCutoff(l0Scores);
            const filteredIds = l0Candidates.slice(0, cutoff).map((c) => c.id);
            if (filteredIds.length === 0) {
              return Promise.resolve([] as SearchRowResult[]);
            }
            return searchVectorFiltered({
              ...baseSearchParams,
              queryVec: input.queryVec,
              chunkIds: filteredIds,
              limit: perFactorLimit,
            });
          }),
        );

        // Merge: deduplicate by chunk ID, keep highest score
        const chunkMap = new Map<string, SearchRowResult>();
        const factorResultCounts = new Map<string, number>();
        for (let ri = 0; ri < allResults.length; ri++) {
          const result = allResults[ri];
          if (result.status !== "fulfilled") continue;
          const fid = searchInputs[ri].factorId;
          factorResultCounts.set(fid, (factorResultCounts.get(fid) ?? 0) + result.value.length);
          for (const row of result.value) {
            const existing = chunkMap.get(row.id);
            if (!existing || row.score > existing.score) {
              chunkMap.set(row.id, row);
            }
          }
        }
        const results = [...chunkMap.values()].toSorted((a, b) => b.score - a.score);

        // Emit factor hit/miss signals for online weight learning
        try {
          const { emitFactorHit, emitFactorMiss } = await import("../evolver/dimension-hooks.js");
          for (const input of searchInputs) {
            if (input.factorId === "_primary") continue;
            const count = factorResultCounts.get(input.factorId) ?? 0;
            if (count > 0) {
              const avgScore =
                results.length > 0 ? results.reduce((s, r) => s + r.score, 0) / results.length : 0;
              emitFactorHit(
                input.factorId,
                cleaned.slice(0, 80),
                avgScore,
                this.provider.model,
                "memory",
              );
            } else {
              emitFactorMiss(input.factorId, cleaned.slice(0, 80), this.provider.model, "memory");
            }
          }
        } catch {
          // dimension-hooks not available — skip signal emission
        }

        // Apply keyword boost if hybrid enabled
        if (hybrid.enabled) {
          const keywordResults = await this.searchKeyword(cleaned, candidates).catch(() => []);
          if (keywordResults.length > 0) {
            const merged = this.mergeHybridResults({
              vector: results.map(
                (r) => this.toMemorySearchResult(r) as MemorySearchResult & { id: string },
              ),
              keyword: keywordResults,
              vectorWeight: hybridVectorWeight,
              textWeight: hybridTextWeight,
            });
            return merged.filter((entry) => entry.score >= minScore);
          }
        }

        return results
          .map((r) => this.toMemorySearchResult(r))
          .filter((entry) => entry.score >= minScore);
      } catch (err) {
        log.debug(`L0 tag search failed, falling back: ${String(err)}`);
        // Fall through to flat search on error
      }
    }

    // Fallback: flat chunk search (only reached on error or no vector)
    const vectorResults = hasVector
      ? await this.searchVector(queryVec, candidates).catch(() => [])
      : [];

    if (!hybrid.enabled) {
      return vectorResults.filter((entry: MemorySearchResult) => entry.score >= minScore);
    }

    const keywordResults = hybrid.enabled
      ? await this.searchKeyword(cleaned, candidates).catch(() => [])
      : [];

    const merged = this.mergeHybridResults({
      vector: vectorResults,
      keyword: keywordResults,
      vectorWeight: hybridVectorWeight,
      textWeight: hybridTextWeight,
    });

    return merged.filter((entry) => entry.score >= minScore);
  }

  private async searchVector(
    queryVec: number[],
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string }>> {
    const results = await searchVector({
      db: this.db,
      vectorTable: VECTOR_TABLE,
      providerModel: this.provider.model,
      queryVec,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      ensureVectorReady: async (dimensions) => await this.ensureVectorReady(dimensions),
      sourceFilterVec: this.buildSourceFilter("c"),
      sourceFilterChunks: this.buildSourceFilter(),
    });
    return results.map(
      (entry) => this.toMemorySearchResult(entry) as MemorySearchResult & { id: string },
    );
  }

  private buildFtsQuery(raw: string): string | null {
    return buildFtsQuery(raw);
  }

  private async searchKeyword(
    query: string,
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string; textScore: number }>> {
    if (!this.fts.enabled || !this.fts.available) {
      return [];
    }
    const sourceFilter = this.buildSourceFilter();
    const results = await searchKeyword({
      db: this.db,
      ftsTable: FTS_TABLE,
      providerModel: this.provider.model,
      query,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      sourceFilter,
      buildFtsQuery: (raw) => this.buildFtsQuery(raw),
      bm25RankToScore: (rank) => -rank, // negate so softmax ranks correctly (more negative BM25 = larger value)
    });
    return results.map(
      (entry) =>
        ({
          ...this.toMemorySearchResult(entry),
          textScore: entry.textScore,
        }) as MemorySearchResult & { id: string; textScore: number },
    );
  }

  private mergeHybridResults(params: {
    vector: Array<MemorySearchResult & { id: string }>;
    keyword: Array<MemorySearchResult & { id: string; textScore: number }>;
    vectorWeight: number;
    textWeight: number;
  }): MemorySearchResult[] {
    // Build metadata lookup: vector results provide l0Tags + l1Sentences;
    // keyword results now also provide l1Sentences (via FTS→chunks JOIN).
    // Vector metadata takes precedence when a chunk appears in both sources.
    const metaMap = new Map<
      string,
      { l0Tags?: Record<string, number>; l1Sentences?: import("./types.js").L1Sentence[] }
    >();
    for (const r of params.keyword) {
      if (r.l1Sentences) {
        metaMap.set(r.id, { l1Sentences: r.l1Sentences });
      }
    }
    for (const r of params.vector) {
      if (r.l0Tags || r.l1Sentences) {
        metaMap.set(r.id, { l0Tags: r.l0Tags, l1Sentences: r.l1Sentences });
      }
    }

    const merged = mergeHybridResults({
      vector: params.vector.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: r.score,
        timestamp: r.timestamp,
      })),
      keyword: params.keyword.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        textScore: r.textScore,
      })),
      vectorWeight: params.vectorWeight,
      textWeight: params.textWeight,
    });
    return merged.map((entry) => {
      const meta = metaMap.get(entry.id);
      return {
        ...entry,
        l0Tags: meta?.l0Tags,
        l1Sentences: meta?.l1Sentences,
      } as MemorySearchResult;
    });
  }

  /** Convert SearchRowResult to MemorySearchResult, building L1 snippet from sentences. */
  private toMemorySearchResult(r: SearchRowResult): MemorySearchResult {
    let l1Sentences: import("./types.js").L1Sentence[] | undefined;
    if (r.l1Sentences) {
      try {
        l1Sentences = JSON.parse(r.l1Sentences);
      } catch {
        /* ignore */
      }
    }
    // Build snippet from L1 sentences if available, otherwise use L2 text
    const snippet =
      l1Sentences && l1Sentences.length > 0 ? l1Sentences.map((s) => s.text).join(" ") : r.snippet;
    return {
      id: r.id,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      score: r.score,
      snippet,
      source: r.source as import("./types.js").MemorySource,
      timestamp: r.timestamp,
      l0Tags: r.l0Tags,
      l1Sentences,
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    if (this.syncing) {
      return this.syncing;
    }
    this.syncing = this.runSync(params).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  async readChunk(chunkId: string): Promise<{
    id: string;
    text: string;
    path: string;
    startLine: number;
    endLine: number;
  } | null> {
    const id = chunkId.startsWith("chunk:") ? chunkId.slice(6) : chunkId;
    const row = this.db
      .prepare(`SELECT id, text, path, start_line, end_line FROM chunks WHERE id = ?`)
      .get(id) as
      | { id: string; text: string; path: string; start_line: number; end_line: number }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      text: row.text,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
    };
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const rawPath = params.relPath.trim();
    if (!rawPath) {
      throw new Error("path required");
    }
    const absPath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this.workspaceDir, rawPath);
    const relPath = path.relative(this.workspaceDir, absPath).replace(/\\/g, "/");
    const inWorkspace =
      relPath.length > 0 && !relPath.startsWith("..") && !path.isAbsolute(relPath);
    const allowedWorkspace = inWorkspace && isMemoryPath(relPath);
    let allowedAdditional = false;
    if (!allowedWorkspace && this.settings.extraPaths.length > 0) {
      const additionalPaths = normalizeExtraMemoryPaths(
        this.workspaceDir,
        this.settings.extraPaths,
      );
      for (const additionalPath of additionalPaths) {
        try {
          const stat = await fs.lstat(additionalPath);
          if (stat.isSymbolicLink()) {
            continue;
          }
          if (stat.isDirectory()) {
            if (absPath === additionalPath || absPath.startsWith(`${additionalPath}${path.sep}`)) {
              allowedAdditional = true;
              break;
            }
            continue;
          }
          if (stat.isFile()) {
            if (absPath === additionalPath && absPath.endsWith(".md")) {
              allowedAdditional = true;
              break;
            }
          }
        } catch {}
      }
    }
    if (!allowedWorkspace && !allowedAdditional) {
      throw new Error("path required");
    }
    if (!absPath.endsWith(".md")) {
      throw new Error("path required");
    }
    const stat = await fs.lstat(absPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("path required");
    }
    const content = await fs.readFile(absPath, "utf-8");
    if (!params.from && !params.lines) {
      return { text: content, path: relPath };
    }
    const lines = content.split("\n");
    const start = Math.max(1, params.from ?? 1);
    const count = Math.max(1, params.lines ?? lines.length);
    const slice = lines.slice(start - 1, start - 1 + count);
    return { text: slice.join("\n"), path: relPath };
  }

  status(): MemoryProviderStatus {
    const sourceFilter = this.buildSourceFilter();
    const files = this.db
      .prepare(`SELECT COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params) as {
      c: number;
    };
    const chunks = this.db
      .prepare(`SELECT COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params) as {
      c: number;
    };
    const sourceCounts = (() => {
      const sources = Array.from(this.sources);
      if (sources.length === 0) {
        return [];
      }
      const bySource = new Map<MemorySource, { files: number; chunks: number }>();
      for (const source of sources) {
        bySource.set(source, { files: 0, chunks: 0 });
      }
      const fileRows = this.db
        .prepare(
          `SELECT source, COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql} GROUP BY source`,
        )
        .all(...sourceFilter.params) as Array<{ source: MemorySource; c: number }>;
      for (const row of fileRows) {
        const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
        entry.files = row.c ?? 0;
        bySource.set(row.source, entry);
      }
      const chunkRows = this.db
        .prepare(
          `SELECT source, COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql} GROUP BY source`,
        )
        .all(...sourceFilter.params) as Array<{ source: MemorySource; c: number }>;
      for (const row of chunkRows) {
        const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
        entry.chunks = row.c ?? 0;
        bySource.set(row.source, entry);
      }
      return sources.map((source) => Object.assign({ source }, bySource.get(source)!));
    })();
    return {
      backend: "builtin",
      files: files?.c ?? 0,
      chunks: chunks?.c ?? 0,
      dirty: this.dirty,
      workspaceDir: this.workspaceDir,
      dbPath: this.settings.store.path,
      provider: this.provider.id,
      model: this.provider.model,
      requestedProvider: this.requestedProvider,
      sources: Array.from(this.sources),
      extraPaths: this.settings.extraPaths,
      sourceCounts,
      cache: this.cache.enabled
        ? {
            enabled: true,
            entries:
              (
                this.db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get() as
                  | { c: number }
                  | undefined
              )?.c ?? 0,
            maxEntries: this.cache.maxEntries,
          }
        : { enabled: false, maxEntries: this.cache.maxEntries },
      fts: {
        enabled: this.fts.enabled,
        available: this.fts.available,
        error: this.fts.loadError,
      },
      fallback: this.fallbackReason
        ? { from: this.fallbackFrom ?? "local", reason: this.fallbackReason }
        : undefined,
      vector: {
        enabled: this.vector.enabled,
        available: this.vector.available ?? undefined,
        extensionPath: this.vector.extensionPath,
        loadError: this.vector.loadError,
        dims: this.vector.dims,
      },
      batch: {
        enabled: this.batchFailureTracker.batchEnabled,
        failures: this.batchFailureTracker.count,
        limit: BATCH_FAILURE_LIMIT,
        wait: this.batch.wait,
        concurrency: this.batch.concurrency,
        pollIntervalMs: this.batch.pollIntervalMs,
        timeoutMs: this.batch.timeoutMs,
        lastError: this.batchFailureTracker.lastError,
        lastProvider: this.batchFailureTracker.lastProvider,
      },
    };
  }

  async probeVectorAvailability(): Promise<boolean> {
    if (!this.vector.enabled) {
      return false;
    }
    return this.ensureVectorReady();
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.provider.embedBatch(texts);
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    try {
      const ctx = this.buildEmbeddingContext();
      await embedBatchWithRetry(ctx, ["ping"]);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  /**
   * Index arbitrary text content directly into SQL — no file on disk needed.
   * Constructs a virtual file entry and delegates to the internal indexFile pipeline
   * (chunking → embedding → L0 tags → L1 sentences → SQL insert).
   */
  async indexContent(params: {
    path: string;
    content: string;
    source?: MemorySource;
  }): Promise<void> {
    const { content, source = "memory" } = params;
    if (!content.trim()) return;
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
    const entry: MemoryFileEntry = {
      path: params.path,
      absPath: params.path, // virtual — content provided directly
      mtimeMs: Date.now(),
      size: Buffer.byteLength(content, "utf-8"),
      hash,
    };
    await this.indexFile(entry, { source, content });
  }

  /**
   * Index a session turn directly into SQL — no file I/O.
   * Accumulates user + assistant text in an in-memory buffer per session.
   * Flushes to indexContent() when deltaBytes or deltaMessages threshold is met.
   */
  async indexSessionTurn(params: {
    sessionId: string;
    userText: string;
    assistantText: string;
  }): Promise<void> {
    const { sessionId, userText, assistantText } = params;
    const thresholds = this.settings.sync.sessions;
    if (!thresholds) return;

    const chunk = [
      userText.trim() ? `User: ${userText.trim()}` : "",
      assistantText.trim() ? `Assistant: ${assistantText.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    if (!chunk) return;

    let buf = this.sessionBuffers.get(sessionId);
    if (!buf) {
      buf = { bytes: 0, turns: 0, chunks: [] };
      this.sessionBuffers.set(sessionId, buf);
    }
    buf.chunks.push(chunk);
    buf.bytes += Buffer.byteLength(chunk, "utf-8");
    buf.turns += 1;

    const shouldFlush = buf.bytes >= thresholds.deltaBytes || buf.turns >= thresholds.deltaMessages;
    if (!shouldFlush) return;

    const content = buf.chunks.join("\n\n---\n\n");
    this.sessionBuffers.delete(sessionId);

    await this.indexContent({ path: `sessions/${sessionId}`, content, source: "sessions" });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.db.close();
    INDEX_CACHE.delete(this.cacheKey);
  }

  // --- Vector lifecycle (delegates to manager-vectors.ts) ---

  private async ensureVectorReady(dimensions?: number): Promise<boolean> {
    if (!this.vector.enabled) {
      return false;
    }
    if (!this.vectorReady) {
      this.vectorReady = withTimeout(
        loadVectorExtension(this.db, this.vector),
        VECTOR_LOAD_TIMEOUT_MS,
        `sqlite-vec load timed out after ${Math.round(VECTOR_LOAD_TIMEOUT_MS / 1000)}s`,
      );
    }
    let ready = false;
    try {
      ready = await this.vectorReady;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.vector.available = false;
      this.vector.loadError = message;
      this.vectorReady = null;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
    if (ready && typeof dimensions === "number" && dimensions > 0) {
      ensureVectorTable(this.db, this.vector, dimensions);
    }
    return ready;
  }

  // --- Source filter ---

  private buildSourceFilter(alias?: string): { sql: string; params: MemorySource[] } {
    const sources = Array.from(this.sources);
    if (sources.length === 0) {
      return { sql: "", params: [] };
    }
    const column = alias ? `${alias}.source` : "source";
    const placeholders = sources.map(() => "?").join(", ");
    return { sql: ` AND ${column} IN (${placeholders})`, params: sources };
  }

  // --- Database lifecycle ---

  private openDatabase(): DatabaseSync {
    const dbPath = resolveUserPath(this.settings.store.path);
    return this.openDatabaseAtPath(dbPath);
  }

  private openDatabaseAtPath(dbPath: string): DatabaseSync {
    const dir = path.dirname(dbPath);
    ensureDir(dir);
    const { DatabaseSync } = requireNodeSqlite();
    return new DatabaseSync(dbPath, { allowExtension: this.settings.store.vector.enabled });
  }

  private async swapIndexFiles(targetPath: string, tempPath: string): Promise<void> {
    const backupPath = `${targetPath}.backup-${randomUUID()}`;
    await this.moveIndexFiles(targetPath, backupPath);
    try {
      await this.moveIndexFiles(tempPath, targetPath);
    } catch (err) {
      await this.moveIndexFiles(backupPath, targetPath);
      throw err;
    }
    await this.removeIndexFiles(backupPath);
  }

  private async moveIndexFiles(sourceBase: string, targetBase: string): Promise<void> {
    const suffixes = ["", "-wal", "-shm"];
    for (const suffix of suffixes) {
      const source = `${sourceBase}${suffix}`;
      const target = `${targetBase}${suffix}`;
      try {
        await fs.rename(source, target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
    }
  }

  private async removeIndexFiles(basePath: string): Promise<void> {
    const suffixes = ["", "-wal", "-shm"];
    await Promise.all(suffixes.map((suffix) => fs.rm(`${basePath}${suffix}`, { force: true })));
  }

  private ensureSchema() {
    const result = ensureMemoryIndexSchema({
      db: this.db,
      embeddingCacheTable: EMBEDDING_CACHE_TABLE,
      ftsTable: FTS_TABLE,
      ftsEnabled: this.fts.enabled,
    });
    this.fts.available = result.ftsAvailable;
    this.filesFts.available = result.filesFtsAvailable;
    if (result.ftsError) {
      this.fts.loadError = result.ftsError;
      log.warn(`fts unavailable: ${result.ftsError}`);
    }
  }

  // --- File system watchers ---

  private ensureWatcher() {
    if (!this.sources.has("memory") || !this.settings.sync.watch || this.watcher) {
      return;
    }
    const additionalPaths = normalizeExtraMemoryPaths(this.workspaceDir, this.settings.extraPaths)
      .map((entry) => {
        try {
          const stat = fsSync.lstatSync(entry);
          return stat.isSymbolicLink() ? null : entry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is string => Boolean(entry));
    const watchPaths = new Set<string>([
      path.join(this.workspaceDir, "MEMORY.md"),
      path.join(this.workspaceDir, "memory.md"),
      path.join(this.workspaceDir, "memory"),
      ...additionalPaths,
    ]);
    this.watcher = chokidar.watch(Array.from(watchPaths), {
      ignoreInitial: true,
      ignored: [
        // Only .md files are indexed — skip everything else to avoid FD exhaustion
        /(^|[/\\])\../, // dotfiles
        /\.sqlite3?$/,
        /\.db$/,
        /\.jsonl?$/,
        /\.bin$/,
        /\.pkl$/,
        /\.vec$/,
        /\.wal$/,
        /\.shm$/,
        /-journal$/,
        /node_modules/,
        (filePath: string) => {
          // Allow directories (chokidar needs to traverse them) and .md files
          try {
            const stat = fsSync.lstatSync(filePath);
            if (stat.isDirectory()) {
              return false;
            }
          } catch {
            return false;
          }
          return !filePath.endsWith(".md");
        },
      ],
      awaitWriteFinish: {
        stabilityThreshold: this.settings.sync.watchDebounceMs,
        pollInterval: 500,
      },
    });
    const markDirty = () => {
      this.dirty = true;
      this.scheduleWatchSync();
    };
    this.watcher.on("add", markDirty);
    this.watcher.on("change", markDirty);
    this.watcher.on("unlink", markDirty);
  }

  private ensureIntervalSync() {
    const minutes = this.settings.sync.intervalMinutes;
    if (!minutes || minutes <= 0 || this.intervalTimer) {
      return;
    }
    const ms = minutes * 60 * 1000;
    this.intervalTimer = setInterval(() => {
      void this.sync({ reason: "interval" }).catch((err) => {
        log.warn(`memory sync failed (interval): ${String(err)}`);
      });
    }, ms);
  }

  private scheduleWatchSync() {
    if (!this.sources.has("memory") || !this.settings.sync.watch) {
      return;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.sync({ reason: "watch" }).catch((err) => {
        log.warn(`memory sync failed (watch): ${String(err)}`);
      });
    }, this.settings.sync.watchDebounceMs);
  }

  // --- Sync orchestration ---

  private async syncMemoryFiles(params: {
    needsFullReindex: boolean;
    progress?: MemorySyncProgressState;
  }) {
    const files = await listMemoryFiles(this.workspaceDir, this.settings.extraPaths);
    const fileEntries = await runWithConcurrency(
      files.map((file) => async () => buildFileEntry(file, this.workspaceDir)),
      this.getIndexConcurrency(),
    );
    log.debug("memory sync: indexing memory files", {
      files: fileEntries.length,
      needsFullReindex: params.needsFullReindex,
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
    });
    const activePaths = new Set(fileEntries.map((entry) => entry.path));
    if (params.progress) {
      params.progress.total += fileEntries.length;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
        label: this.batch.enabled ? "Indexing memory files (batch)..." : "Indexing memory files…",
      });
    }

    const tasks = fileEntries.map((entry) => async () => {
      const record = this.db
        .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
        .get(entry.path, "memory") as { hash: string } | undefined;
      if (!params.needsFullReindex && record?.hash === entry.hash) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        return;
      }
      await this.indexFile(entry, { source: "memory" });
      if (params.progress) {
        params.progress.completed += 1;
        params.progress.report({
          completed: params.progress.completed,
          total: params.progress.total,
        });
      }
    });
    await runWithConcurrency(tasks, this.getIndexConcurrency());

    const staleRows = this.db
      .prepare(`SELECT path FROM files WHERE source = ?`)
      .all("memory") as Array<{ path: string }>;
    for (const stale of staleRows) {
      if (activePaths.has(stale.path)) {
        continue;
      }
      this.db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`).run(stale.path, "memory");
      try {
        this.db
          .prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
          .run(stale.path, "memory");
      } catch {}
      this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(stale.path, "memory");
      if (this.fts.enabled && this.fts.available) {
        try {
          this.db
            .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
            .run(stale.path, "memory", this.provider.model);
        } catch {}
      }
    }
  }

  private createSyncProgress(
    onProgress: (update: MemorySyncProgressUpdate) => void,
  ): MemorySyncProgressState {
    const state: MemorySyncProgressState = {
      completed: 0,
      total: 0,
      label: undefined,
      report: (update) => {
        if (update.label) {
          state.label = update.label;
        }
        const label =
          update.total > 0 && state.label
            ? `${state.label} ${update.completed}/${update.total}`
            : state.label;
        onProgress({
          completed: update.completed,
          total: update.total,
          label,
        });
      },
    };
    return state;
  }

  private async runSync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) {
    const progress = params?.progress ? this.createSyncProgress(params.progress) : undefined;
    if (progress) {
      progress.report({
        completed: progress.completed,
        total: progress.total,
        label: "Loading vector extension…",
      });
    }
    const vectorReady = await this.ensureVectorReady();
    const meta = this.readMeta();
    const needsFullReindex =
      params?.force ||
      !meta ||
      meta.model !== this.provider.model ||
      meta.provider !== this.provider.id ||
      meta.providerKey !== this.providerKey ||
      meta.chunkTokens !== this.settings.chunking.tokens ||
      meta.chunkOverlap !== this.settings.chunking.overlap ||
      (vectorReady && !meta?.vectorDims);
    try {
      if (needsFullReindex) {
        await this.runSafeReindex({
          reason: params?.reason,
          force: params?.force,
          progress: progress ?? undefined,
        });
        return;
      }

      const shouldSyncMemory =
        this.sources.has("memory") && (params?.force || needsFullReindex || this.dirty);

      if (shouldSyncMemory) {
        await this.syncMemoryFiles({ needsFullReindex, progress: progress ?? undefined });
        this.dirty = false;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const activated =
        this.shouldFallbackOnError(reason) && (await this.activateFallbackProvider(reason));
      if (activated) {
        await this.runSafeReindex({
          reason: params?.reason ?? "fallback",
          force: true,
          progress: progress ?? undefined,
        });
        return;
      }
      throw err;
    }
  }

  private shouldFallbackOnError(message: string): boolean {
    return /embedding|embeddings|batch/i.test(message);
  }

  private resolveBatchConfig(): {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  } {
    const batch = this.settings.remote?.batch;
    const enabled = Boolean(
      batch?.enabled &&
      ((this.openAi && this.provider.id === "openai") ||
        (this.gemini && this.provider.id === "gemini") ||
        (this.voyage && this.provider.id === "voyage")),
    );
    return {
      enabled,
      wait: batch?.wait ?? true,
      concurrency: Math.max(1, batch?.concurrency ?? 2),
      pollIntervalMs: batch?.pollIntervalMs ?? 2000,
      timeoutMs: (batch?.timeoutMinutes ?? 60) * 60 * 1000,
    };
  }

  private async activateFallbackProvider(reason: string): Promise<boolean> {
    const fallback = this.settings.fallback;
    if (!fallback || fallback === "none" || fallback === this.provider.id) {
      return false;
    }
    if (this.fallbackFrom) {
      return false;
    }
    const fallbackFrom = this.provider.id as "openai" | "gemini" | "anthropic" | "local" | "voyage";

    const fallbackModel =
      fallback === "gemini"
        ? DEFAULT_GEMINI_EMBEDDING_MODEL
        : fallback === "openai"
          ? DEFAULT_OPENAI_EMBEDDING_MODEL
          : fallback === "voyage"
            ? DEFAULT_VOYAGE_EMBEDDING_MODEL
            : this.settings.model;

    const fallbackResult = await createEmbeddingProvider({
      config: this.cfg,
      agentDir: resolveAgentDir(this.cfg, this.agentId),
      provider: fallback,
      remote: this.settings.remote,
      model: fallbackModel,
      fallback: "none",
      local: this.settings.local,
    });

    this.fallbackFrom = fallbackFrom;
    this.fallbackReason = reason;
    this.provider = fallbackResult.provider;
    this.openAi = fallbackResult.openAi;
    this.gemini = fallbackResult.gemini;
    this.voyage = fallbackResult.voyage;
    this.providerKey = computeProviderKey(this.provider, this.openAi, this.gemini);
    this.batch = this.resolveBatchConfig();
    this.batchFailureTracker = createBatchFailureTracker(this.batch.enabled);
    log.warn(`memory embeddings: switched to fallback provider (${fallback})`, { reason });
    return true;
  }

  private async runSafeReindex(params: {
    reason?: string;
    force?: boolean;
    progress?: MemorySyncProgressState;
  }): Promise<void> {
    const dbPath = resolveUserPath(this.settings.store.path);
    const tempDbPath = `${dbPath}.tmp-${randomUUID()}`;
    const tempDb = this.openDatabaseAtPath(tempDbPath);

    const originalDb = this.db;
    let originalDbClosed = false;
    const originalState = {
      ftsAvailable: this.fts.available,
      ftsError: this.fts.loadError,
      vectorAvailable: this.vector.available,
      vectorLoadError: this.vector.loadError,
      vectorDims: this.vector.dims,
      vectorReady: this.vectorReady,
    };

    const restoreOriginalState = () => {
      if (originalDbClosed) {
        this.db = this.openDatabaseAtPath(dbPath);
      } else {
        this.db = originalDb;
      }
      this.fts.available = originalState.ftsAvailable;
      this.fts.loadError = originalState.ftsError;
      this.vector.available = originalDbClosed ? null : originalState.vectorAvailable;
      this.vector.loadError = originalState.vectorLoadError;
      this.vector.dims = originalState.vectorDims;
      this.vectorReady = originalDbClosed ? null : originalState.vectorReady;
    };

    this.db = tempDb;
    this.l1CacheDb = originalDb;
    this.vectorReady = null;
    this.vector.available = null;
    this.vector.loadError = undefined;
    this.vector.dims = undefined;
    this.fts.available = false;
    this.fts.loadError = undefined;
    this.ensureSchema();

    let nextMeta: MemoryIndexMeta | null = null;

    try {
      seedEmbeddingCache({
        db: this.db,
        sourceDb: originalDb,
        cache: this.cache,
        cacheTable: EMBEDDING_CACHE_TABLE,
      });
      if (this.sources.has("memory")) {
        await this.syncMemoryFiles({ needsFullReindex: true, progress: params.progress });
        this.dirty = false;
      }

      nextMeta = {
        model: this.provider.model,
        provider: this.provider.id,
        providerKey: this.providerKey,
        chunkTokens: this.settings.chunking.tokens,
        chunkOverlap: this.settings.chunking.overlap,
      };
      if (this.vector.available && this.vector.dims) {
        nextMeta.vectorDims = this.vector.dims;
      }

      this.writeMeta(nextMeta);
      pruneEmbeddingCacheIfNeeded({
        db: this.db,
        cache: this.cache,
        cacheTable: EMBEDDING_CACHE_TABLE,
      });

      this.l1CacheDb = null;
      this.db.close();
      originalDb.close();
      originalDbClosed = true;

      await this.swapIndexFiles(dbPath, tempDbPath);

      this.db = this.openDatabaseAtPath(dbPath);
      this.vectorReady = null;
      this.vector.available = null;
      this.vector.loadError = undefined;
      this.ensureSchema();
      this.vector.dims = nextMeta.vectorDims;
    } catch (err) {
      this.l1CacheDb = null;
      try {
        this.db.close();
      } catch {}
      await this.removeIndexFiles(tempDbPath);
      restoreOriginalState();
      throw err;
    }
  }

  private resetIndex() {
    this.db.exec(`DELETE FROM files`);
    this.db.exec(`DELETE FROM chunks`);
    if (this.fts.enabled && this.fts.available) {
      try {
        this.db.exec(`DELETE FROM ${FTS_TABLE}`);
      } catch {}
    }
    dropVectorTable(this.db);
    this.vector.dims = undefined;
    this.sessionBuffers.clear();
  }

  private readMeta(): MemoryIndexMeta | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY) as
      | { value: string }
      | undefined;
    if (!row?.value) {
      return null;
    }
    try {
      return JSON.parse(row.value) as MemoryIndexMeta;
    } catch {
      return null;
    }
  }

  private writeMeta(meta: MemoryIndexMeta) {
    const value = JSON.stringify(meta);
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(META_KEY, value);
  }

  // --- Embedding context builder ---

  private buildEmbeddingContext(): EmbeddingContext {
    return {
      db: this.db,
      provider: this.provider,
      providerKey: this.providerKey,
      cache: this.cache,
      cacheTable: EMBEDDING_CACHE_TABLE,
      batch: this.batch,
      openAi: this.openAi,
      gemini: this.gemini,
      voyage: this.voyage,
      agentId: this.agentId,
      runBatchWithFallback: <T>(p: {
        provider: string;
        run: () => Promise<T>;
        fallback: () => Promise<number[][]>;
      }) => runBatchWithFallback(this.batchFailureTracker, p),
    };
  }

  private getIndexConcurrency(): number {
    return this.batchFailureTracker.batchEnabled
      ? this.batch.concurrency
      : EMBEDDING_INDEX_CONCURRENCY;
  }

  private async indexFile(
    entry: MemoryFileEntry,
    options: { source: MemorySource; content?: string },
  ) {
    const content = options.content ?? (await fs.readFile(entry.absPath, "utf-8"));
    const chunks = chunkMarkdown(content, this.settings.chunking).filter(
      (chunk) => chunk.text.trim().length > 0,
    );
    const ctx = this.buildEmbeddingContext();
    const embeddings = this.batchFailureTracker.batchEnabled
      ? await embedChunksWithBatch(ctx, chunks, entry, options.source)
      : await embedChunksInBatches(ctx, chunks);
    const sample = embeddings.find((embedding) => embedding.length > 0);
    const vectorReady = sample ? await this.ensureVectorReady(sample.length) : false;
    const now = Date.now();

    // Generate L0 tags (factor projection) for each chunk
    let factorSpace: Awaited<ReturnType<typeof loadFactorSpace>> | null = null;
    try {
      factorSpace = await loadFactorSpace();
      if (factorSpace.factors.length === 0) {
        factorSpace = null;
      }
    } catch {
      factorSpace = null;
    }
    const chunkL0Tags: Record<string, number>[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const embedding = embeddings[i];
      if (factorSpace && embedding && embedding.length > 0) {
        chunkL0Tags.push(projectChunkToFactors(embedding, factorSpace, this.provider.model));
      } else {
        chunkL0Tags.push({});
      }
    }

    // Generate L1 extractive summaries for each chunk
    // L1 ref points to chunk ID in SQL (L2 is chunks.text), resolved after ID generation
    // Reuse existing L1 data when the chunk hash hasn't changed (avoids redundant sentence embeddings)
    const chunkL1Sentences: ExtractedSentence[][] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i] ?? [];
      // Check if this chunk already has L1 data in the DB (same content hash → same L1 result)
      // During atomic reindex, l1CacheDb points to the original DB with existing data
      const chunkId = hashText(
        `${options.source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${this.provider.model}`,
      );
      const lookupDb = this.l1CacheDb ?? this.db;
      try {
        const existing = lookupDb
          .prepare(`SELECT l1_sentences FROM chunks WHERE id = ? AND hash = ?`)
          .get(chunkId, chunk.hash) as { l1_sentences: string } | undefined;
        if (existing?.l1_sentences) {
          const parsed = JSON.parse(existing.l1_sentences) as ExtractedSentence[];
          if (parsed.length > 0) {
            chunkL1Sentences.push(parsed);
            continue;
          }
        }
      } catch {
        /* fall through to regeneration */
      }
      const sentences = splitSentences(chunk.text);
      if (sentences.length <= 1 || embedding.length === 0) {
        chunkL1Sentences.push(sentences);
        continue;
      }
      let sentenceEmbeddings: number[][];
      try {
        sentenceEmbeddings = await ctx.provider.embedBatch(sentences.map((s) => s.text));
      } catch {
        chunkL1Sentences.push(sentences);
        continue;
      }
      const selected = extractL1Sentences(sentences, sentenceEmbeddings, embedding);
      chunkL1Sentences.push(selected);
    }

    // Information gain filter: skip chunks that are near-duplicates of existing chunks
    // in the same source (cross-file dedup). Only when sqlite-vec is available.
    const contextParams = await loadContextParams();
    const redundancyThreshold = contextParams.redundancyThreshold ?? 0.95;
    const distanceThreshold = 1 - redundancyThreshold; // cosine distance
    const nonRedundantIndices: number[] = [];
    if (vectorReady) {
      for (let i = 0; i < chunks.length; i++) {
        const embedding = embeddings[i];
        if (!embedding || embedding.length === 0) {
          nonRedundantIndices.push(i);
          continue;
        }
        try {
          const nearest = this.db
            .prepare(
              `SELECT vec_distance_cosine(v.embedding, ?) AS dist` +
                ` FROM ${VECTOR_TABLE} v` +
                ` JOIN chunks c ON c.id = v.id` +
                ` WHERE c.source = ? AND c.path != ?` +
                ` ORDER BY dist ASC LIMIT 1`,
            )
            .get(vectorToBlob(embedding), options.source, entry.path) as
            | { dist: number }
            | undefined;
          if (!nearest || nearest.dist >= distanceThreshold) {
            nonRedundantIndices.push(i);
          }
          // else: redundant chunk, skip
        } catch {
          nonRedundantIndices.push(i); // ANN failure → conservatively keep
        }
      }
    } else {
      for (let i = 0; i < chunks.length; i++) {
        nonRedundantIndices.push(i);
      }
    }

    const igChunks = nonRedundantIndices.map((i) => chunks[i]);
    const igEmbeddings = nonRedundantIndices.map((i) => embeddings[i]);
    const igL0Tags = nonRedundantIndices.map((i) => chunkL0Tags[i]);
    const igL1Sentences = nonRedundantIndices.map((i) => chunkL1Sentences[i]);

    if (vectorReady) {
      try {
        this.db
          .prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
          .run(entry.path, options.source);
      } catch {}
    }
    if (this.fts.enabled && this.fts.available) {
      try {
        this.db
          .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
          .run(entry.path, options.source, this.provider.model);
      } catch {}
    }
    this.db
      .prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`)
      .run(entry.path, options.source);
    for (let i = 0; i < igChunks.length; i++) {
      const chunk = igChunks[i];
      const embedding = igEmbeddings[i] ?? [];
      const l0Tags = igL0Tags[i] ?? {};
      const l1Sents = igL1Sentences[i] ?? [];
      const id = hashText(
        `${options.source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${this.provider.model}`,
      );
      this.db
        .prepare(
          `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, l0_tags, l1_sentences)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             hash=excluded.hash,
             model=excluded.model,
             text=excluded.text,
             embedding=excluded.embedding,
             updated_at=excluded.updated_at,
             l0_tags=excluded.l0_tags,
             l1_sentences=excluded.l1_sentences`,
        )
        .run(
          id,
          entry.path,
          options.source,
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          this.provider.model,
          chunk.text,
          JSON.stringify(embedding),
          now,
          JSON.stringify(l0Tags),
          JSON.stringify(l1Sents),
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
            `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line)\n` +
              ` VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            chunk.text,
            id,
            entry.path,
            options.source,
            this.provider.model,
            chunk.startLine,
            chunk.endLine,
          );
      }
    }

    // Generate file-level L0 abstract from L1 sentences (for hierarchical search compatibility)
    const fileL0 = igL1Sentences
      .flatMap((sents) => sents.map((s) => s.text))
      .join("; ")
      .slice(0, 600);

    // Embed file-level L0 and write to files_vec
    let fileL0Embedding: number[] = [];
    if (fileL0 && vectorReady && sample) {
      try {
        fileL0Embedding = await embedQueryWithTimeout(ctx, fileL0);
      } catch {
        // Non-fatal: file-level embedding failure doesn't block indexing
      }
      if (fileL0Embedding.length > 0) {
        // Ensure file vector table exists
        if (!this.fileVectorTableReady) {
          this.fileVectorTableReady = ensureFileVectorTable(this.db, fileL0Embedding.length);
        }
        if (this.fileVectorTableReady) {
          try {
            this.db.prepare(`DELETE FROM ${FILES_VECTOR_TABLE} WHERE path = ?`).run(entry.path);
          } catch {}
          try {
            this.db
              .prepare(`INSERT INTO ${FILES_VECTOR_TABLE} (path, embedding) VALUES (?, ?)`)
              .run(entry.path, vectorToBlob(fileL0Embedding));
          } catch {}
        }
      }
    }

    // Write to files_fts
    if (fileL0 && this.filesFts.available) {
      try {
        this.db.prepare(`DELETE FROM files_fts WHERE path = ?`).run(entry.path);
      } catch {}
      try {
        this.db
          .prepare(`INSERT INTO files_fts (l0_abstract, path, source) VALUES (?, ?, ?)`)
          .run(fileL0, entry.path, options.source);
      } catch {}
    }

    this.db
      .prepare(
        `INSERT INTO files (path, source, hash, mtime, size, l0_abstract, l0_embedding) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           source=excluded.source,
           hash=excluded.hash,
           mtime=excluded.mtime,
           size=excluded.size,
           l0_abstract=excluded.l0_abstract,
           l0_embedding=excluded.l0_embedding`,
      )
      .run(
        entry.path,
        options.source,
        entry.hash,
        entry.mtimeMs,
        entry.size,
        fileL0,
        JSON.stringify(fileL0Embedding),
      );
  }
}
