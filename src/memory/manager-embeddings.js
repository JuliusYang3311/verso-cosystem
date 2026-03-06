/**
 * manager-embeddings.ts
 * Embedding operations for MemoryIndexManager.
 * Covers batch construction, retry logic, provider-specific batch embedding,
 * timeout handling, and provider key computation.
 * Extracted from manager.ts to reduce file size.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runGeminiEmbeddingBatches } from "./batch-gemini.js";
import { OPENAI_BATCH_ENDPOINT, runOpenAiEmbeddingBatches } from "./batch-openai.js";
import { runVoyageEmbeddingBatches } from "./batch-voyage.js";
import { hashText } from "./internal.js";
import { loadEmbeddingCache, upsertEmbeddingCache } from "./manager-embedding-cache.js";
const log = createSubsystemLogger("memory");
const EMBEDDING_BATCH_MAX_TOKENS = 8000;
const EMBEDDING_APPROX_CHARS_PER_TOKEN = 1;
const EMBEDDING_RETRY_MAX_ATTEMPTS = 3;
const EMBEDDING_RETRY_BASE_DELAY_MS = 500;
const EMBEDDING_RETRY_MAX_DELAY_MS = 8000;
const EMBEDDING_QUERY_TIMEOUT_REMOTE_MS = 60_000;
const EMBEDDING_QUERY_TIMEOUT_LOCAL_MS = 5 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_REMOTE_MS = 2 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_LOCAL_MS = 10 * 60_000;
export function estimateEmbeddingTokens(text) {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / EMBEDDING_APPROX_CHARS_PER_TOKEN);
}
export function buildEmbeddingBatches(chunks) {
  const batches = [];
  let current = [];
  let currentTokens = 0;
  for (const chunk of chunks) {
    const estimate = estimateEmbeddingTokens(chunk.text);
    const wouldExceed = current.length > 0 && currentTokens + estimate > EMBEDDING_BATCH_MAX_TOKENS;
    if (wouldExceed) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && estimate > EMBEDDING_BATCH_MAX_TOKENS) {
      batches.push([chunk]);
      continue;
    }
    current.push(chunk);
    currentTokens += estimate;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}
export async function embedChunksInBatches(ctx, chunks) {
  if (chunks.length === 0) {
    return [];
  }
  const cached = loadEmbeddingCache({
    db: ctx.db,
    cache: ctx.cache,
    provider: ctx.provider,
    providerKey: ctx.providerKey,
    cacheTable: ctx.cacheTable,
    hashes: chunks.map((chunk) => chunk.hash),
  });
  const embeddings = Array.from({ length: chunks.length }, () => []);
  const missing = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const hit = chunk?.hash ? cached.get(chunk.hash) : undefined;
    if (hit && hit.length > 0) {
      embeddings[i] = hit;
    } else if (chunk) {
      missing.push({ index: i, chunk });
    }
  }
  if (missing.length === 0) {
    return embeddings;
  }
  const missingChunks = missing.map((m) => m.chunk);
  const batches = buildEmbeddingBatches(missingChunks);
  const toCache = [];
  let cursor = 0;
  for (const batch of batches) {
    const batchEmbeddings = await embedBatchWithRetry(
      ctx,
      batch.map((chunk) => chunk.text),
    );
    for (let i = 0; i < batch.length; i += 1) {
      const item = missing[cursor + i];
      const embedding = batchEmbeddings[i] ?? [];
      if (item) {
        embeddings[item.index] = embedding;
        toCache.push({ hash: item.chunk.hash, embedding });
      }
    }
    cursor += batch.length;
  }
  upsertEmbeddingCache({
    db: ctx.db,
    cache: ctx.cache,
    provider: ctx.provider,
    providerKey: ctx.providerKey,
    cacheTable: ctx.cacheTable,
    entries: toCache,
  });
  return embeddings;
}
export function computeProviderKey(provider, openAi, gemini) {
  if (provider.id === "openai" && openAi) {
    const entries = Object.entries(openAi.headers)
      .filter(([key]) => key.toLowerCase() !== "authorization")
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, value]);
    return hashText(
      JSON.stringify({
        provider: "openai",
        baseUrl: openAi.baseUrl,
        model: openAi.model,
        headers: entries,
      }),
    );
  }
  if (provider.id === "gemini" && gemini) {
    const entries = Object.entries(gemini.headers)
      .filter(([key]) => {
        const lower = key.toLowerCase();
        return lower !== "authorization" && lower !== "x-goog-api-key";
      })
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, value]);
    return hashText(
      JSON.stringify({
        provider: "gemini",
        baseUrl: gemini.baseUrl,
        model: gemini.model,
        headers: entries,
      }),
    );
  }
  return hashText(JSON.stringify({ provider: provider.id, model: provider.model }));
}
export async function embedChunksWithBatch(ctx, chunks, entry, source) {
  if (ctx.provider.id === "openai" && ctx.openAi) {
    return embedChunksWithOpenAiBatch(ctx, chunks, entry, source);
  }
  if (ctx.provider.id === "gemini" && ctx.gemini) {
    return embedChunksWithGeminiBatch(ctx, chunks, entry, source);
  }
  if (ctx.provider.id === "voyage" && ctx.voyage) {
    return embedChunksWithVoyageBatch(ctx, chunks, entry, source);
  }
  return embedChunksInBatches(ctx, chunks);
}
async function embedChunksWithVoyageBatch(ctx, chunks, entry, source) {
  const voyage = ctx.voyage;
  if (!voyage) {
    return embedChunksInBatches(ctx, chunks);
  }
  if (chunks.length === 0) {
    return [];
  }
  const cached = loadEmbeddingCache({
    db: ctx.db,
    cache: ctx.cache,
    provider: ctx.provider,
    providerKey: ctx.providerKey,
    cacheTable: ctx.cacheTable,
    hashes: chunks.map((chunk) => chunk.hash),
  });
  const embeddings = Array.from({ length: chunks.length }, () => []);
  const missing = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const hit = chunk?.hash ? cached.get(chunk.hash) : undefined;
    if (hit && hit.length > 0) {
      embeddings[i] = hit;
    } else if (chunk) {
      missing.push({ index: i, chunk });
    }
  }
  if (missing.length === 0) {
    return embeddings;
  }
  const requests = [];
  const mapping = new Map();
  for (const item of missing) {
    const chunk = item.chunk;
    const customId = hashText(
      `${source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${item.index}`,
    );
    mapping.set(customId, { index: item.index, hash: chunk.hash });
    requests.push({
      custom_id: customId,
      body: {
        input: chunk.text,
      },
    });
  }
  const batchResult = await ctx.runBatchWithFallback({
    provider: "voyage",
    run: async () =>
      await runVoyageEmbeddingBatches({
        client: voyage,
        agentId: ctx.agentId,
        requests,
        wait: ctx.batch.wait,
        concurrency: ctx.batch.concurrency,
        pollIntervalMs: ctx.batch.pollIntervalMs,
        timeoutMs: ctx.batch.timeoutMs,
        debug: (message, data) => log.debug(message, { ...data, source, chunks: chunks.length }),
      }),
    fallback: async () => await embedChunksInBatches(ctx, chunks),
  });
  if (Array.isArray(batchResult)) {
    return batchResult;
  }
  const byCustomId = batchResult;
  const toCache = [];
  for (const [customId, embedding] of byCustomId.entries()) {
    const mapped = mapping.get(customId);
    if (!mapped) {
      continue;
    }
    embeddings[mapped.index] = embedding;
    toCache.push({ hash: mapped.hash, embedding });
  }
  upsertEmbeddingCache({
    db: ctx.db,
    cache: ctx.cache,
    provider: ctx.provider,
    providerKey: ctx.providerKey,
    cacheTable: ctx.cacheTable,
    entries: toCache,
  });
  return embeddings;
}
async function embedChunksWithOpenAiBatch(ctx, chunks, entry, source) {
  const openAi = ctx.openAi;
  if (!openAi) {
    return embedChunksInBatches(ctx, chunks);
  }
  if (chunks.length === 0) {
    return [];
  }
  const cached = loadEmbeddingCache({
    db: ctx.db,
    cache: ctx.cache,
    provider: ctx.provider,
    providerKey: ctx.providerKey,
    cacheTable: ctx.cacheTable,
    hashes: chunks.map((chunk) => chunk.hash),
  });
  const embeddings = Array.from({ length: chunks.length }, () => []);
  const missing = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const hit = chunk?.hash ? cached.get(chunk.hash) : undefined;
    if (hit && hit.length > 0) {
      embeddings[i] = hit;
    } else if (chunk) {
      missing.push({ index: i, chunk });
    }
  }
  if (missing.length === 0) {
    return embeddings;
  }
  const requests = [];
  const mapping = new Map();
  for (const item of missing) {
    const chunk = item.chunk;
    const customId = hashText(
      `${source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${item.index}`,
    );
    mapping.set(customId, { index: item.index, hash: chunk.hash });
    requests.push({
      custom_id: customId,
      method: "POST",
      url: OPENAI_BATCH_ENDPOINT,
      body: {
        model: ctx.openAi?.model ?? ctx.provider.model,
        input: chunk.text,
      },
    });
  }
  const batchResult = await ctx.runBatchWithFallback({
    provider: "openai",
    run: async () =>
      await runOpenAiEmbeddingBatches({
        openAi,
        agentId: ctx.agentId,
        requests,
        wait: ctx.batch.wait,
        concurrency: ctx.batch.concurrency,
        pollIntervalMs: ctx.batch.pollIntervalMs,
        timeoutMs: ctx.batch.timeoutMs,
        debug: (message, data) => log.debug(message, { ...data, source, chunks: chunks.length }),
      }),
    fallback: async () => await embedChunksInBatches(ctx, chunks),
  });
  if (Array.isArray(batchResult)) {
    return batchResult;
  }
  const byCustomId = batchResult;
  const toCache = [];
  for (const [customId, embedding] of byCustomId.entries()) {
    const mapped = mapping.get(customId);
    if (!mapped) {
      continue;
    }
    embeddings[mapped.index] = embedding;
    toCache.push({ hash: mapped.hash, embedding });
  }
  upsertEmbeddingCache({
    db: ctx.db,
    cache: ctx.cache,
    provider: ctx.provider,
    providerKey: ctx.providerKey,
    cacheTable: ctx.cacheTable,
    entries: toCache,
  });
  return embeddings;
}
async function embedChunksWithGeminiBatch(ctx, chunks, entry, source) {
  const gemini = ctx.gemini;
  if (!gemini) {
    return embedChunksInBatches(ctx, chunks);
  }
  if (chunks.length === 0) {
    return [];
  }
  const cached = loadEmbeddingCache({
    db: ctx.db,
    cache: ctx.cache,
    provider: ctx.provider,
    providerKey: ctx.providerKey,
    cacheTable: ctx.cacheTable,
    hashes: chunks.map((chunk) => chunk.hash),
  });
  const embeddings = Array.from({ length: chunks.length }, () => []);
  const missing = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const hit = chunk?.hash ? cached.get(chunk.hash) : undefined;
    if (hit && hit.length > 0) {
      embeddings[i] = hit;
    } else if (chunk) {
      missing.push({ index: i, chunk });
    }
  }
  if (missing.length === 0) {
    return embeddings;
  }
  const requests = [];
  const mapping = new Map();
  for (const item of missing) {
    const chunk = item.chunk;
    const customId = hashText(
      `${source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${item.index}`,
    );
    mapping.set(customId, { index: item.index, hash: chunk.hash });
    requests.push({
      custom_id: customId,
      content: { parts: [{ text: chunk.text }] },
      taskType: "RETRIEVAL_DOCUMENT",
    });
  }
  const batchResult = await ctx.runBatchWithFallback({
    provider: "gemini",
    run: async () =>
      await runGeminiEmbeddingBatches({
        gemini,
        agentId: ctx.agentId,
        requests,
        wait: ctx.batch.wait,
        concurrency: ctx.batch.concurrency,
        pollIntervalMs: ctx.batch.pollIntervalMs,
        timeoutMs: ctx.batch.timeoutMs,
        debug: (message, data) => log.debug(message, { ...data, source, chunks: chunks.length }),
      }),
    fallback: async () => await embedChunksInBatches(ctx, chunks),
  });
  if (Array.isArray(batchResult)) {
    return batchResult;
  }
  const byCustomId = batchResult;
  const toCache = [];
  for (const [customId, embedding] of byCustomId.entries()) {
    const mapped = mapping.get(customId);
    if (!mapped) {
      continue;
    }
    embeddings[mapped.index] = embedding;
    toCache.push({ hash: mapped.hash, embedding });
  }
  upsertEmbeddingCache({
    db: ctx.db,
    cache: ctx.cache,
    provider: ctx.provider,
    providerKey: ctx.providerKey,
    cacheTable: ctx.cacheTable,
    entries: toCache,
  });
  return embeddings;
}
export async function embedBatchWithRetry(ctx, texts) {
  if (texts.length === 0) {
    return [];
  }
  let attempt = 0;
  let delayMs = EMBEDDING_RETRY_BASE_DELAY_MS;
  while (true) {
    try {
      const timeoutMs = resolveEmbeddingTimeout(ctx.provider, "batch");
      log.debug("memory embeddings: batch start", {
        provider: ctx.provider.id,
        items: texts.length,
        timeoutMs,
      });
      return await withTimeout(
        ctx.provider.embedBatch(texts),
        timeoutMs,
        `memory embeddings batch timed out after ${Math.round(timeoutMs / 1000)}s`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isRetryableEmbeddingError(message) || attempt >= EMBEDDING_RETRY_MAX_ATTEMPTS) {
        throw err;
      }
      const waitMs = Math.min(
        EMBEDDING_RETRY_MAX_DELAY_MS,
        Math.round(delayMs * (1 + Math.random() * 0.2)),
      );
      log.warn(`memory embeddings rate limited; retrying in ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      delayMs *= 2;
      attempt += 1;
    }
  }
}
export function isRetryableEmbeddingError(message) {
  return /(rate[_ ]limit|too many requests|429|resource has been exhausted|5\d\d|cloudflare)/i.test(
    message,
  );
}
export function resolveEmbeddingTimeout(provider, kind) {
  const isLocal = provider.id === "local";
  if (kind === "query") {
    return isLocal ? EMBEDDING_QUERY_TIMEOUT_LOCAL_MS : EMBEDDING_QUERY_TIMEOUT_REMOTE_MS;
  }
  return isLocal ? EMBEDDING_BATCH_TIMEOUT_LOCAL_MS : EMBEDDING_BATCH_TIMEOUT_REMOTE_MS;
}
export async function embedQueryWithTimeout(ctx, text) {
  const timeoutMs = resolveEmbeddingTimeout(ctx.provider, "query");
  log.debug("memory embeddings: query start", { provider: ctx.provider.id, timeoutMs });
  return await withTimeout(
    ctx.provider.embedQuery(text),
    timeoutMs,
    `memory embeddings query timed out after ${Math.round(timeoutMs / 1000)}s`,
  );
}
export async function withTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return await promise;
  }
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
