/**
 * manager-embedding-cache.ts
 * Embedding cache operations for MemoryIndexManager.
 * Extracted from manager.ts to reduce file size.
 */
import { parseEmbedding } from "./internal.js";
export function loadEmbeddingCache(params) {
  if (!params.cache.enabled) {
    return new Map();
  }
  if (params.hashes.length === 0) {
    return new Map();
  }
  const unique = [];
  const seen = new Set();
  for (const hash of params.hashes) {
    if (!hash) {
      continue;
    }
    if (seen.has(hash)) {
      continue;
    }
    seen.add(hash);
    unique.push(hash);
  }
  if (unique.length === 0) {
    return new Map();
  }
  const out = new Map();
  const baseParams = [params.provider.id, params.provider.model, params.providerKey];
  const batchSize = 400;
  for (let start = 0; start < unique.length; start += batchSize) {
    const batch = unique.slice(start, start + batchSize);
    const placeholders = batch.map(() => "?").join(", ");
    const rows = params.db
      .prepare(
        `SELECT hash, embedding FROM ${params.cacheTable}\n` +
          ` WHERE provider = ? AND model = ? AND provider_key = ? AND hash IN (${placeholders})`,
      )
      .all(...baseParams, ...batch);
    for (const row of rows) {
      out.set(row.hash, parseEmbedding(row.embedding));
    }
  }
  return out;
}
export function upsertEmbeddingCache(params) {
  if (!params.cache.enabled) {
    return;
  }
  if (params.entries.length === 0) {
    return;
  }
  const now = Date.now();
  const stmt = params.db.prepare(
    `INSERT INTO ${params.cacheTable} (provider, model, provider_key, hash, embedding, dims, updated_at)\n` +
      ` VALUES (?, ?, ?, ?, ?, ?, ?)\n` +
      ` ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET\n` +
      `   embedding=excluded.embedding,\n` +
      `   dims=excluded.dims,\n` +
      `   updated_at=excluded.updated_at`,
  );
  for (const entry of params.entries) {
    const embedding = entry.embedding ?? [];
    stmt.run(
      params.provider.id,
      params.provider.model,
      params.providerKey,
      entry.hash,
      JSON.stringify(embedding),
      embedding.length,
      now,
    );
  }
}
export function pruneEmbeddingCacheIfNeeded(params) {
  if (!params.cache.enabled) {
    return;
  }
  const max = params.cache.maxEntries;
  if (!max || max <= 0) {
    return;
  }
  const row = params.db.prepare(`SELECT COUNT(*) as c FROM ${params.cacheTable}`).get();
  const count = row?.c ?? 0;
  if (count <= max) {
    return;
  }
  const excess = count - max;
  params.db
    .prepare(
      `DELETE FROM ${params.cacheTable}\n` +
        ` WHERE rowid IN (\n` +
        `   SELECT rowid FROM ${params.cacheTable}\n` +
        `   ORDER BY updated_at ASC\n` +
        `   LIMIT ?\n` +
        ` )`,
    )
    .run(excess);
}
export function seedEmbeddingCache(params) {
  if (!params.cache.enabled) {
    return;
  }
  try {
    const rows = params.sourceDb
      .prepare(
        `SELECT provider, model, provider_key, hash, embedding, dims, updated_at FROM ${params.cacheTable}`,
      )
      .all();
    if (!rows.length) {
      return;
    }
    const insert = params.db
      .prepare(`INSERT INTO ${params.cacheTable} (provider, model, provider_key, hash, embedding, dims, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET
         embedding=excluded.embedding,
         dims=excluded.dims,
         updated_at=excluded.updated_at`);
    params.db.exec("BEGIN");
    for (const row of rows) {
      insert.run(
        row.provider,
        row.model,
        row.provider_key,
        row.hash,
        row.embedding,
        row.dims,
        row.updated_at,
      );
    }
    params.db.exec("COMMIT");
  } catch (err) {
    try {
      params.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}
