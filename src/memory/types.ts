export type MemorySource = "memory" | "sessions";

export type L1Sentence = {
  text: string;
  startChar: number;
  endChar: number;
};

export type MemorySearchResult = {
  /** Chunk ID in SQL (use with readChunk to get L2 full text). */
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  /** L1 extractive summary (key sentences joined). Injected into context. */
  snippet: string;
  source: MemorySource;
  citation?: string;
  /** Epoch ms when this chunk was last indexed. Used for time decay in dynamic context. */
  timestamp?: number;
  /** L0 factor tags { factorId: score }. */
  l0Tags?: Record<string, number>;
  /** L1 extracted key sentences. */
  l1Sentences?: L1Sentence[];
};

export type MemoryEmbeddingProbeResult = {
  ok: boolean;
  error?: string;
};

export type MemorySyncProgressUpdate = {
  completed: number;
  total: number;
  label?: string;
};

export type MemoryProviderStatus = {
  backend: "builtin" | "qmd";
  provider: string;
  model?: string;
  requestedProvider?: string;
  files?: number;
  chunks?: number;
  dirty?: boolean;
  workspaceDir?: string;
  dbPath?: string;
  extraPaths?: string[];
  sources?: MemorySource[];
  sourceCounts?: Array<{ source: MemorySource; files: number; chunks: number }>;
  cache?: { enabled: boolean; entries?: number; maxEntries?: number };
  fts?: { enabled: boolean; available: boolean; error?: string };
  fallback?: { from: string; reason?: string };
  vector?: {
    enabled: boolean;
    available?: boolean;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  batch?: {
    enabled: boolean;
    failures: number;
    limit: number;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
    lastError?: string;
    lastProvider?: string;
  };
  custom?: Record<string, unknown>;
};

export interface MemorySearchManager {
  search(
    query: string,
    opts?: { minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]>;
  /** Read L2 full text by chunk ID from SQL. */
  readChunk(
    chunkId: string,
  ): Promise<{ id: string; text: string; path: string; startLine: number; endLine: number } | null>;
  /** Read file content (legacy, kept for backward compatibility). */
  readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }>;
  status(): MemoryProviderStatus;
  sync?(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorAvailability(): Promise<boolean>;
  embedBatch?(texts: string[]): Promise<number[][]>;
  close?(): Promise<void>;
}
