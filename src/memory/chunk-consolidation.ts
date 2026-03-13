/**
 * chunk-consolidation.ts — Gradual merge of semantically similar chunks.
 *
 * During sync, chunks from the same source file may overlap or cover
 * near-identical content (e.g. after edits that shift line boundaries).
 * This module identifies and merges such chunks to reduce storage and
 * avoid injecting redundant context.
 *
 * Merge criteria (all must hold):
 *   1. Same `path` (same source file)
 *   2. Cosine similarity of embeddings ≥ threshold (default 0.92)
 *   3. Combined text ≤ max chunk size (prevents unbounded growth)
 *
 * After merge, the merged chunk is:
 *   - Re-embedded from scratch (not averaged)
 *   - L1 re-extracted using the same embedding-based MMR pipeline
 *   - L0 tags re-projected from the new embedding
 */

import type { DatabaseSync } from "node:sqlite";
import type { ExtractedSentence } from "./manager-l1-extractive.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory:consolidation");

// ---------- Types ----------

export type ConsolidationCandidate = {
  id: string;
  path: string;
  source: string;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
  model: string;
  embedding: number[];
  l0Tags: Record<string, number>;
  l1Sentences: ExtractedSentence[];
  updatedAt: number;
};

export type MergePlan = {
  /** IDs of chunks that will be consumed (deleted). */
  consumed: string[];
  /** Merged text, line range, and metadata. Embedding/L1/L0 are placeholders until hydration. */
  merged: ConsolidationCandidate;
};

/** Callbacks the caller provides for re-computing derived fields on merged text. */
export type ConsolidationPipeline = {
  /** Hash the merged text for dedup. */
  hashText: (text: string) => string;
  /** Embed the merged text from scratch. */
  embedText: (text: string) => Promise<number[]>;
  /** Extract L1 sentences using the standard embedding-based MMR pipeline. */
  extractL1: (text: string, chunkEmbedding: number[]) => Promise<ExtractedSentence[]>;
  /** Re-project L0 tags from the new embedding. */
  projectL0: (embedding: number[]) => Record<string, number>;
  /** Called for each consumed chunk ID — clean up FTS, vector table, utilization, etc. */
  onDelete?: (chunkId: string) => void;
  /** Called for the merged chunk after SQL upsert — update FTS, vector table, etc. */
  onUpsert?: (chunk: ConsolidationCandidate) => void;
};

export type ConsolidationStats = {
  candidatesPaired: number;
  merged: number;
  skipped: number;
};

// ---------- Similarity ----------

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------- Core merge logic ----------

/**
 * Attempt to merge two chunks. Returns null if they don't meet criteria.
 * Only produces a MergePlan with text/metadata — embedding, L1, L0 are
 * placeholders that must be hydrated by `applyMerges`.
 */
export function tryMerge(
  a: ConsolidationCandidate,
  b: ConsolidationCandidate,
  opts: { similarityThreshold: number; maxMergedChars: number },
): MergePlan | null {
  if (a.path !== b.path || a.source !== b.source || a.model !== b.model) return null;

  const sim = cosine(a.embedding, b.embedding);
  if (sim < opts.similarityThreshold) return null;

  // Order by line position
  const [first, second] = a.startLine <= b.startLine ? [a, b] : [b, a];

  // Merge text
  let mergedText: string;
  if (second.startLine <= first.endLine + 1) {
    // Overlapping or adjacent — stitch, dedup overlapping lines
    const firstLines = first.text.split("\n");
    const secondLines = second.text.split("\n");
    const uniqueSecondLines = secondLines.slice(Math.max(0, first.endLine - second.startLine + 1));
    mergedText = [...firstLines, ...uniqueSecondLines].join("\n");
  } else {
    mergedText = first.text + "\n\n" + second.text;
  }

  if (mergedText.length > opts.maxMergedChars) return null;

  return {
    consumed: [a.id, b.id],
    merged: {
      id: first.id,
      path: first.path,
      source: first.source,
      startLine: Math.min(first.startLine, second.startLine),
      endLine: Math.max(first.endLine, second.endLine),
      text: mergedText,
      hash: "", // placeholder — hydrated in applyMerges
      model: first.model,
      embedding: [], // placeholder — re-embedded in applyMerges
      l0Tags: {}, // placeholder — re-projected in applyMerges
      l1Sentences: [], // placeholder — re-extracted in applyMerges
      updatedAt: Math.max(a.updatedAt, b.updatedAt),
    },
  };
}

// ---------- Batch candidate finding ----------

/**
 * Find merge-able pairs within the same file.
 * Greedy: once a chunk is paired, it's excluded from further pairing.
 */
export function findMergeCandidates(
  chunks: ConsolidationCandidate[],
  opts?: { similarityThreshold?: number; maxMergedChars?: number },
): MergePlan[] {
  const threshold = opts?.similarityThreshold ?? 0.92;
  const maxChars = opts?.maxMergedChars ?? 6400;

  const byPath = new Map<string, ConsolidationCandidate[]>();
  for (const c of chunks) {
    const group = byPath.get(c.path) ?? [];
    group.push(c);
    byPath.set(c.path, group);
  }

  const results: MergePlan[] = [];
  const consumed = new Set<string>();

  for (const group of byPath.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.startLine - b.startLine);

    for (let i = 0; i < group.length; i++) {
      if (consumed.has(group[i].id)) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (consumed.has(group[j].id)) continue;
        const plan = tryMerge(group[i], group[j], {
          similarityThreshold: threshold,
          maxMergedChars: maxChars,
        });
        if (plan) {
          results.push(plan);
          consumed.add(group[i].id);
          consumed.add(group[j].id);
          break;
        }
      }
    }
  }

  return results;
}

// ---------- SQL loading ----------

export function loadConsolidationCandidates(
  db: DatabaseSync,
  opts?: { source?: string; path?: string },
): ConsolidationCandidate[] {
  let sql = `SELECT id, path, source, start_line, end_line, text, hash, model,
                    embedding, l0_tags, l1_sentences, updated_at
             FROM chunks WHERE embedding != '[]'`;
  const params: string[] = [];

  if (opts?.source) {
    sql += ` AND source = ?`;
    params.push(opts.source);
  }
  if (opts?.path) {
    sql += ` AND path = ?`;
    params.push(opts.path);
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    path: string;
    source: string;
    start_line: number;
    end_line: number;
    text: string;
    hash: string;
    model: string;
    embedding: string;
    l0_tags: string;
    l1_sentences: string;
    updated_at: number;
  }>;

  return rows
    .map((r) => {
      let embedding: number[];
      try {
        embedding = JSON.parse(r.embedding);
        if (!Array.isArray(embedding) || embedding.length === 0) return null;
      } catch {
        return null;
      }
      let l0Tags: Record<string, number>;
      try {
        l0Tags = JSON.parse(r.l0_tags);
      } catch {
        l0Tags = {};
      }
      let l1Sentences: ExtractedSentence[];
      try {
        l1Sentences = JSON.parse(r.l1_sentences);
      } catch {
        l1Sentences = [];
      }
      return {
        id: r.id,
        path: r.path,
        source: r.source,
        startLine: r.start_line,
        endLine: r.end_line,
        text: r.text,
        hash: r.hash,
        model: r.model,
        embedding,
        l0Tags,
        l1Sentences,
        updatedAt: r.updated_at,
      };
    })
    .filter(Boolean) as ConsolidationCandidate[];
}

// ---------- Apply merges ----------

/**
 * Hydrate and persist merge plans.
 *
 * For each plan:
 *   1. Re-embed the merged text (fresh, not averaged)
 *   2. Re-extract L1 sentences using embedding-based MMR
 *   3. Re-project L0 tags from the new embedding
 *   4. Delete consumed chunks + cleanup (FTS, vector)
 *   5. Upsert the merged chunk + register (FTS, vector)
 */
export async function applyMerges(
  db: DatabaseSync,
  plans: MergePlan[],
  pipeline: ConsolidationPipeline,
): Promise<ConsolidationStats> {
  if (plans.length === 0) return { candidatesPaired: 0, merged: 0, skipped: 0 };

  const deleteStmt = db.prepare(`DELETE FROM chunks WHERE id = ?`);
  const upsertStmt = db.prepare(
    `INSERT OR REPLACE INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding, l0_tags, l1_sentences, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let merged = 0;
  let skipped = 0;

  for (const plan of plans) {
    try {
      const m = plan.merged;

      // Hydrate: re-embed, re-extract L1, re-project L0
      const hash = pipeline.hashText(m.text);
      const embedding = await pipeline.embedText(m.text);
      if (embedding.length === 0) {
        skipped++;
        continue;
      }
      const l1Sentences = await pipeline.extractL1(m.text, embedding);
      const l0Tags = pipeline.projectL0(embedding);

      // Delete consumed chunks
      for (const id of plan.consumed) {
        if (id !== m.id) {
          deleteStmt.run(id);
          pipeline.onDelete?.(id);
        }
      }

      // Upsert merged chunk
      upsertStmt.run(
        m.id,
        m.path,
        m.source,
        m.startLine,
        m.endLine,
        m.text,
        hash,
        m.model,
        JSON.stringify(embedding),
        JSON.stringify(l0Tags),
        JSON.stringify(l1Sentences),
        m.updatedAt,
      );

      // Update the candidate object for the onUpsert callback
      const hydrated: ConsolidationCandidate = {
        ...m,
        hash,
        embedding,
        l0Tags,
        l1Sentences,
      };
      pipeline.onUpsert?.(hydrated);

      merged++;
    } catch (err) {
      log.warn?.("consolidation merge failed", { error: err });
      skipped++;
    }
  }

  log.info?.("chunk consolidation complete", { merged, skipped });
  return { candidatesPaired: plans.length, merged, skipped };
}
