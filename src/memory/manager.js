import chokidar from "chokidar";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { loadContextParams } from "../agents/dynamic-context.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { resolveUserPath } from "../utils.js";
import { DEFAULT_GEMINI_EMBEDDING_MODEL } from "./embeddings-gemini.js";
import { DEFAULT_OPENAI_EMBEDDING_MODEL } from "./embeddings-openai.js";
import { DEFAULT_VOYAGE_EMBEDDING_MODEL } from "./embeddings-voyage.js";
import { createEmbeddingProvider } from "./embeddings.js";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./hybrid.js";
import {
  buildFileEntry,
  chunkMarkdown,
  ensureDir,
  generateFileL0,
  generateL0Abstract,
  hashText,
  isMemoryPath,
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  runWithConcurrency,
} from "./internal.js";
import { loadFactorSpace, ensureFactorVectors, queryToSubqueries } from "./latent-factors.js";
import {
  BATCH_FAILURE_LIMIT,
  createBatchFailureTracker,
  runBatchWithFallback,
} from "./manager-batch-failure.js";
import { seedEmbeddingCache, pruneEmbeddingCacheIfNeeded } from "./manager-embedding-cache.js";
import {
  computeProviderKey,
  embedChunksInBatches,
  embedChunksWithBatch,
  embedBatchWithRetry,
  embedQueryWithTimeout,
  withTimeout,
} from "./manager-embeddings.js";
import { searchHierarchical } from "./manager-hierarchical-search.js";
import { searchKeyword, searchVector } from "./manager-search.js";
import { resetSessionDelta, processSessionDeltaBatch } from "./manager-session-delta.js";
import {
  listSessionFiles,
  sessionPathForFile,
  buildSessionEntry,
  isSessionFileForAgent,
} from "./manager-session-files.js";
import {
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
const META_KEY = "memory_index_meta_v1";
const SNIPPET_MAX_CHARS = 700;
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const SESSION_DIRTY_DEBOUNCE_MS = 5000;
const EMBEDDING_INDEX_CONCURRENCY = 4;
const VECTOR_LOAD_TIMEOUT_MS = 30_000;
const log = createSubsystemLogger("memory");
const INDEX_CACHE = new Map();
const INDEX_CACHE_MAX = 20;
export class MemoryIndexManager {
  cacheKey;
  cfg;
  agentId;
  workspaceDir;
  settings;
  customSessionsDir;
  provider;
  requestedProvider;
  fallbackFrom;
  fallbackReason;
  openAi;
  gemini;
  voyage;
  batch;
  batchFailureTracker;
  db;
  sources;
  providerKey;
  cache;
  vector;
  fts;
  filesFts;
  fileVectorTableReady = false;
  vectorReady = null;
  watcher = null;
  watchTimer = null;
  sessionWatchTimer = null;
  sessionUnsubscribe = null;
  intervalTimer = null;
  closed = false;
  dirty = false;
  sessionsDirty = false;
  sessionsDirtyFiles = new Set();
  sessionPendingFiles = new Set();
  sessionDeltas = new Map();
  sessionWarm = new Set();
  syncing = null;
  static async get(params) {
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
      const oldestKey = INDEX_CACHE.keys().next().value;
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
  static async createIsolated(params) {
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
        path: path.join(workspaceDir, "memory.sqlite"),
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
  constructor(params) {
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
    this.ensureSessionListener();
    this.ensureIntervalSync();
    this.dirty = this.sources.has("memory");
    this.batch = this.resolveBatchConfig();
    this.batchFailureTracker = createBatchFailureTracker(this.batch.enabled);
  }
  async loadContextParams() {
    try {
      const paramsPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../evolver/assets/gep/context_params.json",
      );
      const content = await fs.readFile(paramsPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return {};
    }
  }
  async warmSession(sessionKey) {
    if (!this.settings.sync.onSessionStart) {
      return;
    }
    const key = sessionKey?.trim() || "";
    if (key && this.sessionWarm.has(key)) {
      return;
    }
    void this.sync({ reason: "session-start" }).catch((err) => {
      log.warn(`memory sync failed (session-start): ${String(err)}`);
    });
    if (key) {
      this.sessionWarm.add(key);
    }
  }
  async search(query, opts) {
    void this.warmSession(opts?.sessionKey);
    if (this.settings.sync.onSearch && (this.dirty || this.sessionsDirty)) {
      void this.sync({ reason: "search" }).catch((err) => {
        log.warn(`memory sync failed (search): ${String(err)}`);
      });
    }
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }
    const minScore = opts?.minScore ?? this.settings.query.minScore;
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const hybrid = this.settings.query.hybrid;
    const candidates = Math.min(
      200,
      Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
    );
    const ctx = this.buildEmbeddingContext();
    const queryVec = await embedQueryWithTimeout(ctx, cleaned);
    const hasVector = queryVec.some((v) => v !== 0);
    // Load context params for hierarchical search settings
    const contextParams = await this.loadContextParams();
    // Build shared hierarchical search params (reused across factor sub-queries)
    const baseHierarchicalParams = {
      db: this.db,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      providerModel: this.provider.model,
      vectorTable: VECTOR_TABLE,
      filesVectorTable: FILES_VECTOR_TABLE,
      filesFtsTable: "files_fts",
      ftsAvailable: this.fts.available,
      filesFtsAvailable: this.filesFts.available,
      contextParams: contextParams,
      ensureVectorReady: async (dims) => await this.ensureVectorReady(dims),
      ensureFileVectorReady: async (dims) => {
        const ready = await this.ensureVectorReady(dims);
        if (ready && !this.fileVectorTableReady) {
          this.fileVectorTableReady = ensureFileVectorTable(this.db, dims);
        }
        return ready && this.fileVectorTableReady;
      },
      sourceFilterVec: this.buildSourceFilter("c"),
      sourceFilterChunks: this.buildSourceFilter(),
    };
    // Use hierarchical search (file-level pre-filter → chunk-level search)
    if (hasVector) {
      try {
        // Project query onto factor space and build sub-queries
        let space = await loadFactorSpace();
        // Ensure factor vectors are computed before projection; reload to get fresh vectors.
        if (hasVector && space.factors.length > 0) {
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
        // Embed all sub-query texts in a single batch, in parallel with the
        // original query vector (which is already computed above).
        const subQueryTexts = subqueries.map((s) => s.subquery);
        const subQueryVecs = await ctx.provider.embedBatch(subQueryTexts).catch(() => []);
        // Build per-factor search inputs: original query + factor sub-queries
        // Each entry is { queryVec, queryText } for one hierarchical search pass.
        const searchInputs = [
          { queryVec, queryText: cleaned, factorId: "_primary" },
          ...subqueries
            .map((s, i) => ({
              queryVec: subQueryVecs[i] ?? [],
              queryText: s.subquery,
              factorId: s.factorId,
            }))
            .filter((s) => s.queryVec.length > 0),
        ];
        // Run all factor searches in parallel
        const perFactorLimit = Math.ceil(candidates / searchInputs.length);
        const allResults = await Promise.allSettled(
          searchInputs.map((input) =>
            searchHierarchical({
              ...baseHierarchicalParams,
              queryVec: input.queryVec,
              query: input.queryText,
              limit: perFactorLimit,
            }),
          ),
        );
        // Merge: deduplicate by (path, startLine), keep highest score per chunk
        const chunkMap = new Map();
        for (const result of allResults) {
          if (result.status !== "fulfilled") {
            continue;
          }
          for (const row of result.value) {
            const key = `${row.path}:${row.startLine}`;
            const existing = chunkMap.get(key);
            if (!existing || row.score > existing.score) {
              chunkMap.set(key, row);
            }
          }
        }
        const results = [...chunkMap.values()].toSorted((a, b) => b.score - a.score);
        // Apply keyword boost if hybrid enabled
        if (hybrid.enabled) {
          const keywordResults = await this.searchKeyword(cleaned, candidates).catch(() => []);
          if (keywordResults.length > 0) {
            const merged = this.mergeHybridResults({
              vector: results.map((r) => ({ ...r, id: r.id })),
              keyword: keywordResults,
              vectorWeight: hybrid.vectorWeight,
              textWeight: hybrid.textWeight,
            });
            return merged.filter((entry) => entry.score >= minScore).slice(0, maxResults);
          }
        }
        return results
          .map((r) => ({
            path: r.path,
            startLine: r.startLine,
            endLine: r.endLine,
            score: r.score,
            snippet: r.snippet,
            source: r.source,
            timestamp: r.timestamp,
            l0Abstract: r.l0Abstract,
            l1Overview: r.l1Overview,
          }))
          .filter((entry) => entry.score >= minScore)
          .slice(0, maxResults);
      } catch (err) {
        log.debug(`hierarchical search failed, falling back: ${String(err)}`);
        // Fall through to flat search on error
      }
    }
    // Fallback: flat chunk search (only reached on error or no vector)
    const vectorResults = hasVector
      ? await this.searchVector(queryVec, candidates).catch(() => [])
      : [];
    if (!hybrid.enabled) {
      return vectorResults.filter((entry) => entry.score >= minScore).slice(0, maxResults);
    }
    const keywordResults = hybrid.enabled
      ? await this.searchKeyword(cleaned, candidates).catch(() => [])
      : [];
    const merged = this.mergeHybridResults({
      vector: vectorResults,
      keyword: keywordResults,
      vectorWeight: hybrid.vectorWeight,
      textWeight: hybrid.textWeight,
    });
    return merged.filter((entry) => entry.score >= minScore).slice(0, maxResults);
  }
  async searchVector(queryVec, limit) {
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
    return results.map((entry) => entry);
  }
  buildFtsQuery(raw) {
    return buildFtsQuery(raw);
  }
  async searchKeyword(query, limit) {
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
      bm25RankToScore,
    });
    return results.map((entry) => entry);
  }
  mergeHybridResults(params) {
    // Build L0/L1 lookup from vector results (keyword search doesn't provide them)
    const l0l1Map = new Map();
    for (const r of params.vector) {
      if (r.l0Abstract || r.l1Overview) {
        l0l1Map.set(`${r.path}:${r.startLine}:${r.endLine}`, {
          l0Abstract: r.l0Abstract,
          l1Overview: r.l1Overview,
        });
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
      const key = `${entry.path}:${entry.startLine}:${entry.endLine}`;
      const l0l1 = l0l1Map.get(key);
      return {
        ...entry,
        l0Abstract: l0l1?.l0Abstract,
        l1Overview: l0l1?.l1Overview,
      };
    });
  }
  async sync(params) {
    if (this.syncing) {
      return this.syncing;
    }
    this.syncing = this.runSync(params).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }
  async readFile(params) {
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
  status() {
    const sourceFilter = this.buildSourceFilter();
    const files = this.db
      .prepare(`SELECT COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params);
    const chunks = this.db
      .prepare(`SELECT COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params);
    const sourceCounts = (() => {
      const sources = Array.from(this.sources);
      if (sources.length === 0) {
        return [];
      }
      const bySource = new Map();
      for (const source of sources) {
        bySource.set(source, { files: 0, chunks: 0 });
      }
      const fileRows = this.db
        .prepare(
          `SELECT source, COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql} GROUP BY source`,
        )
        .all(...sourceFilter.params);
      for (const row of fileRows) {
        const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
        entry.files = row.c ?? 0;
        bySource.set(row.source, entry);
      }
      const chunkRows = this.db
        .prepare(
          `SELECT source, COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql} GROUP BY source`,
        )
        .all(...sourceFilter.params);
      for (const row of chunkRows) {
        const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
        entry.chunks = row.c ?? 0;
        bySource.set(row.source, entry);
      }
      return sources.map((source) => Object.assign({ source }, bySource.get(source)));
    })();
    return {
      backend: "builtin",
      files: files?.c ?? 0,
      chunks: chunks?.c ?? 0,
      dirty: this.dirty || this.sessionsDirty,
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
              this.db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get()?.c ?? 0,
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
  async probeVectorAvailability() {
    if (!this.vector.enabled) {
      return false;
    }
    return this.ensureVectorReady();
  }
  async embedBatch(texts) {
    return this.provider.embedBatch(texts);
  }
  async probeEmbeddingAvailability() {
    try {
      const ctx = this.buildEmbeddingContext();
      await embedBatchWithRetry(ctx, ["ping"]);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }
  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.sessionWatchTimer) {
      clearTimeout(this.sessionWatchTimer);
      this.sessionWatchTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.sessionUnsubscribe) {
      this.sessionUnsubscribe();
      this.sessionUnsubscribe = null;
    }
    this.db.close();
    INDEX_CACHE.delete(this.cacheKey);
  }
  // --- Vector lifecycle (delegates to manager-vectors.ts) ---
  async ensureVectorReady(dimensions) {
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
      ready = await Promise.resolve(this.vectorReady);
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
  buildSourceFilter(alias) {
    const sources = Array.from(this.sources);
    if (sources.length === 0) {
      return { sql: "", params: [] };
    }
    const column = alias ? `${alias}.source` : "source";
    const placeholders = sources.map(() => "?").join(", ");
    return { sql: ` AND ${column} IN (${placeholders})`, params: sources };
  }
  // --- Database lifecycle ---
  openDatabase() {
    const dbPath = resolveUserPath(this.settings.store.path);
    return this.openDatabaseAtPath(dbPath);
  }
  openDatabaseAtPath(dbPath) {
    const dir = path.dirname(dbPath);
    ensureDir(dir);
    const { DatabaseSync } = requireNodeSqlite();
    return new DatabaseSync(dbPath, { allowExtension: this.settings.store.vector.enabled });
  }
  async swapIndexFiles(targetPath, tempPath) {
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
  async moveIndexFiles(sourceBase, targetBase) {
    const suffixes = ["", "-wal", "-shm"];
    for (const suffix of suffixes) {
      const source = `${sourceBase}${suffix}`;
      const target = `${targetBase}${suffix}`;
      try {
        await fs.rename(source, target);
      } catch (err) {
        if (err.code !== "ENOENT") {
          throw err;
        }
      }
    }
  }
  async removeIndexFiles(basePath) {
    const suffixes = ["", "-wal", "-shm"];
    await Promise.all(suffixes.map((suffix) => fs.rm(`${basePath}${suffix}`, { force: true })));
  }
  ensureSchema() {
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
  ensureWatcher() {
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
      .filter((entry) => Boolean(entry));
    const watchPaths = new Set([
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
        (filePath) => {
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
  ensureSessionListener() {
    if (!this.sources.has("sessions") || this.sessionUnsubscribe) {
      return;
    }
    this.sessionUnsubscribe = onSessionTranscriptUpdate((update) => {
      if (this.closed) {
        return;
      }
      const sessionFile = update.sessionFile;
      if (!isSessionFileForAgent(sessionFile, this.agentId)) {
        return;
      }
      this.scheduleSessionDirty(sessionFile);
    });
  }
  // --- Session delta tracking (delegates to manager-session-delta.ts) ---
  scheduleSessionDirty(sessionFile) {
    this.sessionPendingFiles.add(sessionFile);
    if (this.sessionWatchTimer) {
      return;
    }
    this.sessionWatchTimer = setTimeout(() => {
      this.sessionWatchTimer = null;
      void processSessionDeltaBatch({
        pendingFiles: this.sessionPendingFiles,
        thresholds: this.settings.sync.sessions,
        deltas: this.sessionDeltas,
        dirtyFiles: this.sessionsDirtyFiles,
        sync: async (reason) => {
          this.sessionsDirty = true;
          await this.sync({ reason });
        },
      }).catch((err) => {
        log.warn(`memory session delta failed: ${String(err)}`);
      });
    }, SESSION_DIRTY_DEBOUNCE_MS);
  }
  ensureIntervalSync() {
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
  scheduleWatchSync() {
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
  shouldSyncSessions(params, needsFullReindex = false) {
    if (!this.sources.has("sessions")) {
      return false;
    }
    if (params?.force) {
      return true;
    }
    const reason = params?.reason;
    if (reason === "session-start" || reason === "watch") {
      return false;
    }
    if (needsFullReindex) {
      return true;
    }
    return this.sessionsDirty && this.sessionsDirtyFiles.size > 0;
  }
  // --- Sync orchestration ---
  async syncMemoryFiles(params) {
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
        .get(entry.path, "memory");
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
    const staleRows = this.db.prepare(`SELECT path FROM files WHERE source = ?`).all("memory");
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
  async syncSessionFiles(params) {
    const files = await listSessionFiles(this.agentId, this.customSessionsDir);
    const activePaths = new Set(files.map((file) => sessionPathForFile(file)));
    const indexAll = params.needsFullReindex || this.sessionsDirtyFiles.size === 0;
    log.debug("memory sync: indexing session files", {
      files: files.length,
      indexAll,
      dirtyFiles: this.sessionsDirtyFiles.size,
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
    });
    if (params.progress) {
      params.progress.total += files.length;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
        label: this.batch.enabled ? "Indexing session files (batch)..." : "Indexing session files…",
      });
    }
    const tasks = files.map((absPath) => async () => {
      if (!indexAll && !this.sessionsDirtyFiles.has(absPath)) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        return;
      }
      const entry = await buildSessionEntry(absPath);
      if (!entry) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        return;
      }
      const record = this.db
        .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
        .get(entry.path, "sessions");
      if (!params.needsFullReindex && record?.hash === entry.hash) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        resetSessionDelta(absPath, entry.size, this.sessionDeltas);
        return;
      }
      await this.indexFile(entry, { source: "sessions", content: entry.content });
      resetSessionDelta(absPath, entry.size, this.sessionDeltas);
      if (params.progress) {
        params.progress.completed += 1;
        params.progress.report({
          completed: params.progress.completed,
          total: params.progress.total,
        });
      }
    });
    await runWithConcurrency(tasks, this.getIndexConcurrency());
    const staleRows = this.db.prepare(`SELECT path FROM files WHERE source = ?`).all("sessions");
    for (const stale of staleRows) {
      if (activePaths.has(stale.path)) {
        continue;
      }
      this.db
        .prepare(`DELETE FROM files WHERE path = ? AND source = ?`)
        .run(stale.path, "sessions");
      try {
        this.db
          .prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
          .run(stale.path, "sessions");
      } catch {}
      this.db
        .prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`)
        .run(stale.path, "sessions");
      if (this.fts.enabled && this.fts.available) {
        try {
          this.db
            .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
            .run(stale.path, "sessions", this.provider.model);
        } catch {}
      }
    }
  }
  createSyncProgress(onProgress) {
    const state = {
      completed: 0,
      total: 0,
      /** @type {string | undefined} */
      label: undefined,
      report: (update) => {
        if (update.label) {
          state.label = update.label;
        }
        const label =
          update.total > 0 && state.label
            ? `${state.label ?? ""} ${update.completed}/${update.total}`
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
  async runSync(params) {
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
      const shouldSyncSessions = this.shouldSyncSessions(params, needsFullReindex);
      if (shouldSyncMemory) {
        await this.syncMemoryFiles({ needsFullReindex, progress: progress ?? undefined });
        this.dirty = false;
      }
      if (shouldSyncSessions) {
        await this.syncSessionFiles({ needsFullReindex, progress: progress ?? undefined });
        this.sessionsDirty = false;
        this.sessionsDirtyFiles.clear();
      } else if (this.sessionsDirtyFiles.size > 0) {
        this.sessionsDirty = true;
      } else {
        this.sessionsDirty = false;
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
  shouldFallbackOnError(message) {
    return /embedding|embeddings|batch/i.test(message);
  }
  resolveBatchConfig() {
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
  async activateFallbackProvider(reason) {
    const fallback = this.settings.fallback;
    if (!fallback || fallback === "none" || fallback === this.provider.id) {
      return false;
    }
    if (this.fallbackFrom) {
      return false;
    }
    const fallbackFrom = this.provider.id;
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
  async runSafeReindex(params) {
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
    this.vectorReady = null;
    this.vector.available = null;
    this.vector.loadError = undefined;
    this.vector.dims = undefined;
    this.fts.available = false;
    this.fts.loadError = undefined;
    this.ensureSchema();
    let nextMeta = null;
    try {
      seedEmbeddingCache({
        db: this.db,
        sourceDb: originalDb,
        cache: this.cache,
        cacheTable: EMBEDDING_CACHE_TABLE,
      });
      const shouldSyncMemory = this.sources.has("memory");
      const shouldSyncSessions = this.shouldSyncSessions(
        { reason: params.reason, force: params.force },
        true,
      );
      if (shouldSyncMemory) {
        await this.syncMemoryFiles({ needsFullReindex: true, progress: params.progress });
        this.dirty = false;
      }
      if (shouldSyncSessions) {
        await this.syncSessionFiles({ needsFullReindex: true, progress: params.progress });
        this.sessionsDirty = false;
        this.sessionsDirtyFiles.clear();
      } else if (this.sessionsDirtyFiles.size > 0) {
        this.sessionsDirty = true;
      } else {
        this.sessionsDirty = false;
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
      try {
        this.db.close();
      } catch {}
      await this.removeIndexFiles(tempDbPath);
      restoreOriginalState();
      throw err;
    }
  }
  resetIndex() {
    this.db.exec(`DELETE FROM files`);
    this.db.exec(`DELETE FROM chunks`);
    if (this.fts.enabled && this.fts.available) {
      try {
        this.db.exec(`DELETE FROM ${FTS_TABLE}`);
      } catch {}
    }
    dropVectorTable(this.db);
    this.vector.dims = undefined;
    this.sessionsDirtyFiles.clear();
  }
  readMeta() {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY);
    if (!row?.value) {
      return null;
    }
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }
  writeMeta(meta) {
    const value = JSON.stringify(meta);
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(META_KEY, value);
  }
  // --- Embedding context builder ---
  buildEmbeddingContext() {
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
      runBatchWithFallback: (p) => runBatchWithFallback(this.batchFailureTracker, p),
    };
  }
  getIndexConcurrency() {
    return this.batchFailureTracker.batchEnabled
      ? this.batch.concurrency
      : EMBEDDING_INDEX_CONCURRENCY;
  }
  async indexFile(entry, options) {
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
    // Generate L0 abstracts for each chunk
    const chunkL0s = [];
    for (const chunk of chunks) {
      chunkL0s.push(generateL0Abstract(chunk));
    }
    // Information gain filter: skip chunks that are near-duplicates of existing chunks
    // in the same source (cross-file dedup). Only when sqlite-vec is available.
    const contextParams = await loadContextParams();
    const redundancyThreshold = contextParams.redundancyThreshold ?? 0.95;
    const distanceThreshold = 1 - redundancyThreshold; // cosine distance
    const nonRedundantIndices = [];
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
            .get(vectorToBlob(embedding), options.source, entry.path);
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
    const igL0s = nonRedundantIndices.map((i) => chunkL0s[i]);
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
      const l0 = igL0s[i] ?? "";
      const id = hashText(
        `${options.source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${this.provider.model}`,
      );
      this.db
        .prepare(`INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, l0_abstract)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             hash=excluded.hash,
             model=excluded.model,
             text=excluded.text,
             embedding=excluded.embedding,
             updated_at=excluded.updated_at,
             l0_abstract=excluded.l0_abstract`)
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
    // Generate file-level L0 abstract (from non-redundant chunks only)
    const fileL0 = generateFileL0(igL0s);
    // Embed file-level L0 and write to files_vec
    let fileL0Embedding = [];
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
      .prepare(`INSERT INTO files (path, source, hash, mtime, size, l0_abstract, l0_embedding) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           source=excluded.source,
           hash=excluded.hash,
           mtime=excluded.mtime,
           size=excluded.size,
           l0_abstract=excluded.l0_abstract,
           l0_embedding=excluded.l0_embedding`)
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
