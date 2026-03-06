/**
 * manager-vectors.ts
 * Vector extension lifecycle for MemoryIndexManager.
 * Handles sqlite-vec loading, vector table creation/dropping.
 * Extracted from manager.ts to reduce file size.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { loadSqliteVecExtension } from "./sqlite-vec.js";
const log = createSubsystemLogger("memory");
export const VECTOR_TABLE = "chunks_vec";
export const vectorToBlob = (embedding) => Buffer.from(new Float32Array(embedding).buffer);
export async function loadVectorExtension(db, vector) {
  if (vector.available !== null) {
    return vector.available;
  }
  if (!vector.enabled) {
    vector.available = false;
    return false;
  }
  try {
    const resolvedPath = vector.extensionPath?.trim()
      ? resolveUserPath(vector.extensionPath)
      : undefined;
    const loaded = await loadSqliteVecExtension({ db, extensionPath: resolvedPath });
    if (!loaded.ok) {
      throw new Error(loaded.error ?? "unknown sqlite-vec load error");
    }
    vector.extensionPath = loaded.extensionPath;
    vector.available = true;
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vector.available = false;
    vector.loadError = message;
    log.warn(`sqlite-vec unavailable: ${message}`);
    return false;
  }
}
export function ensureVectorTable(db, vector, dimensions) {
  if (vector.dims === dimensions) {
    return;
  }
  if (vector.dims && vector.dims !== dimensions) {
    dropVectorTable(db);
  }
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
      `  id TEXT PRIMARY KEY,\n` +
      `  embedding FLOAT[${dimensions}]\n` +
      `)`,
  );
  vector.dims = dimensions;
}
export function dropVectorTable(db) {
  try {
    db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug(`Failed to drop ${VECTOR_TABLE}: ${message}`);
  }
}
// ---------- File-level vector table (for hierarchical search) ----------
export const FILES_VECTOR_TABLE = "files_vec";
export function ensureFileVectorTable(db, dimensions) {
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${FILES_VECTOR_TABLE} USING vec0(\n` +
        `  path TEXT PRIMARY KEY,\n` +
        `  embedding FLOAT[${dimensions}]\n` +
        `)`,
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug(`Failed to create ${FILES_VECTOR_TABLE}: ${message}`);
    return false;
  }
}
export function dropFileVectorTable(db) {
  try {
    db.exec(`DROP TABLE IF EXISTS ${FILES_VECTOR_TABLE}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug(`Failed to drop ${FILES_VECTOR_TABLE}: ${message}`);
  }
}
