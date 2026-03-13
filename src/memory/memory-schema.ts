import type { DatabaseSync } from "node:sqlite";

export function ensureMemoryIndexSchema(params: {
  db: DatabaseSync;
  embeddingCacheTable: string;
  ftsTable: string;
  ftsEnabled: boolean;
}): { ftsAvailable: boolean; ftsError?: string } {
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );
  `);
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS ${params.embeddingCacheTable} (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding TEXT NOT NULL,
      dims INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model, provider_key, hash)
    );
  `);
  params.db.exec(
    `CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON ${params.embeddingCacheTable}(updated_at);`,
  );

  let ftsAvailable = false;
  let ftsError: string | undefined;
  if (params.ftsEnabled) {
    try {
      // Migrate from unicode61 (default) to trigram tokenizer for CJK support.
      // Check if existing table uses trigram; if not, drop and recreate.
      let needsRecreate = false;
      try {
        const tableExists = params.db
          .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
          .get(params.ftsTable);
        if (tableExists) {
          const createSql = params.db
            .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
            .get(params.ftsTable) as { sql: string } | undefined;
          if (createSql && !createSql.sql.includes("trigram")) {
            needsRecreate = true;
          }
        }
      } catch {
        /* fall through */
      }
      if (needsRecreate) {
        params.db.exec(`DROP TABLE IF EXISTS ${params.ftsTable}`);
      }
      params.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${params.ftsTable} USING fts5(\n` +
          `  text,\n` +
          `  id UNINDEXED,\n` +
          `  path UNINDEXED,\n` +
          `  source UNINDEXED,\n` +
          `  model UNINDEXED,\n` +
          `  start_line UNINDEXED,\n` +
          `  end_line UNINDEXED,\n` +
          `  tokenize='trigram'\n` +
          `);`,
      );
      ftsAvailable = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ftsAvailable = false;
      ftsError = message;
    }
  }

  ensureColumn(params.db, "files", "source", "TEXT NOT NULL DEFAULT 'memory'");
  ensureColumn(params.db, "chunks", "source", "TEXT NOT NULL DEFAULT 'memory'");

  // 3-layer architecture columns
  // L0: factor projection tags { factorId: score, ... }
  ensureColumn(params.db, "chunks", "l0_tags", "TEXT NOT NULL DEFAULT '{}'");
  // L1: extractive key sentences [{ text, startChar, endChar }]
  ensureColumn(params.db, "chunks", "l1_sentences", "TEXT NOT NULL DEFAULT '[]'");
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);`);

  // Drop legacy tables no longer used
  try {
    params.db.exec(`DROP TABLE IF EXISTS files_fts`);
  } catch {
    /* ignore */
  }

  // Chunk utilization tracking (feedback loop)
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_utilization (
      chunk_id    TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      event       TEXT NOT NULL,
      factor_ids  TEXT NOT NULL DEFAULT '[]',
      query_hash  TEXT,
      score       REAL,
      timestamp   INTEGER NOT NULL
    );
  `);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunk_util_chunk ON chunk_utilization(chunk_id);`);
  params.db.exec(
    `CREATE INDEX IF NOT EXISTS idx_chunk_util_session ON chunk_utilization(session_id, timestamp);`,
  );

  return {
    ftsAvailable,
    ...(ftsError ? { ftsError } : {}),
  };
}

function ensureColumn(
  db: DatabaseSync,
  table: "files" | "chunks",
  column: string,
  definition: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
