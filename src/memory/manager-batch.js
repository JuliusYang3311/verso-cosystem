/**
 * manager-batch.ts
 * Batch embedding orchestration for MemoryIndexManager.
 * Consolidates the per-provider batch methods (OpenAI, Gemini, Voyage)
 * into a single generic flow.
 * Extracted from manager.ts to reduce file size and eliminate repetition.
 */
import { hashText } from "./internal.js";
import { loadEmbeddingCache, upsertEmbeddingCache } from "./manager-embedding-cache.js";
/**
 * Generic batch embedding flow for any provider.
 * Takes a `createRequests` function to build provider-specific requests
 * and a `runBatch` function to execute them.
 */
export async function embedChunksWithProviderBatch(params) {
  if (params.chunks.length === 0) {
    return [];
  }
  const cached = loadEmbeddingCache({
    db: params.db,
    cache: params.cache,
    provider: params.provider,
    providerKey: params.providerKey,
    cacheTable: params.cacheTable,
    hashes: params.chunks.map((chunk) => chunk.hash),
  });
  const embeddings = Array.from({ length: params.chunks.length }, () => []);
  const missing = [];
  for (let i = 0; i < params.chunks.length; i += 1) {
    const chunk = params.chunks[i];
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
  const mapping = new Map();
  for (const item of missing) {
    const chunk = item.chunk;
    const customId = hashText(
      `${params.source}:${params.entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${item.index}`,
    );
    mapping.set(customId, { index: item.index, hash: chunk.hash });
  }
  const requests = params.createRequests(missing, mapping);
  const batchResult = await params.runBatchWithFallback({
    provider: params.provider.id,
    run: async () => params.runBatch(requests),
    fallback: async () => await params.nonBatchFallback(params.chunks),
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
    db: params.db,
    cache: params.cache,
    provider: params.provider,
    providerKey: params.providerKey,
    cacheTable: params.cacheTable,
    entries: toCache,
  });
  return embeddings;
}
