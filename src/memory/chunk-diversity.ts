/**
 * chunk-diversity.ts
 *
 * Diversity primitives for multi-factor retrieval result sets.
 *
 * Responsibilities:
 *   1. Exact deduplication: collapse chunks with the same (path, startLine)
 *      identity, merging factor attribution and keeping the highest score.
 *   2. Semantic similarity: cosine when embeddings are available, bigram-Jaccard
 *      as a graceful fallback — same interface, transparent switching.
 *   3. MMR selection: budget-aware greedy selection that maximises marginal
 *      information gain across the merged candidate pool.
 *
 * This module is the single source of truth for diversity logic.
 * dynamic-context.ts delegates to it; it has no dependency on retrieval
 * internals and can be tested in isolation.
 */

// ---------- Types ----------

export type DiverseChunk = {
  /** Unique chunk identity key: "<path>:<startLine>" */
  readonly key: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly snippet: string;
  /** Relevance score (after time-decay if applied upstream). */
  score: number;
  readonly source: string;
  readonly timestamp?: number;
  readonly id?: string;
  /** L0 factor tags { factorId: score }. */
  readonly l0Tags?: Record<string, number>;
  /** L1 extracted key sentences. */
  readonly l1Sentences?: Array<{ text: string; startChar: number; endChar: number }>;
  /** Embedding vector — present when the retrieval layer provides it. */
  readonly embedding?: number[];
  /** Factor attribution — populated by multi-factor retrieval. */
  factorsUsed?: Array<{ id: string; score: number }>;
  latentProjection?: { factorIds: string[]; scores: number[] };
};

// ---------- Identity key ----------

export function chunkKey(path: string, startLine: number): string {
  return `${path}:${startLine}`;
}

// ---------- Exact deduplication ----------

/**
 * Merge a flat list of chunks (possibly from multiple factor sub-queries)
 * into a deduplicated map keyed by (path, startLine).
 *
 * When the same chunk appears from multiple factors:
 *   - score: keep the maximum (most relevant signal wins)
 *   - factorsUsed: union of all factor attributions, sorted by score desc
 *   - embedding: keep the first non-empty one (they are identical)
 */
export function deduplicateChunks(chunks: DiverseChunk[]): DiverseChunk[] {
  const map = new Map<string, DiverseChunk>();

  for (const chunk of chunks) {
    const key = chunkKey(chunk.path, chunk.startLine);
    const existing = map.get(key);

    if (!existing) {
      map.set(key, { ...chunk, key });
      continue;
    }

    // Merge: keep highest score
    const mergedScore = Math.max(existing.score, chunk.score);

    // Merge factor attributions — union, deduplicated by factor id
    const factorMap = new Map<string, { id: string; score: number }>();
    for (const f of existing.factorsUsed ?? []) {
      factorMap.set(f.id, f);
    }
    for (const f of chunk.factorsUsed ?? []) {
      const prev = factorMap.get(f.id);
      if (!prev || f.score > prev.score) {
        factorMap.set(f.id, f);
      }
    }
    const mergedFactors = [...factorMap.values()].toSorted((a, b) => b.score - a.score);

    map.set(key, {
      ...existing,
      score: mergedScore,
      embedding: existing.embedding ?? chunk.embedding,
      factorsUsed: mergedFactors.length > 0 ? mergedFactors : undefined,
    });
  }

  return [...map.values()];
}

// ---------- Semantic similarity ----------

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
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

function bigramJaccard(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) {
    return 0;
  }
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    const lower = s.toLowerCase();
    for (let i = 0; i < lower.length - 1; i++) {
      set.add(lower.slice(i, i + 2));
    }
    return set;
  };
  const setA = bigrams(a);
  const setB = bigrams(b);
  let intersection = 0;
  for (const bg of setA) {
    if (setB.has(bg)) {
      intersection++;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Semantic similarity between two chunks.
 *
 * Strategy (in priority order):
 *   1. Cosine similarity on embedding vectors — accurate cross-factor comparison
 *   2. Bigram-Jaccard on snippet text — zero-dependency fallback
 *
 * The caller never needs to know which strategy was used.
 */
export function chunkSimilarity(a: DiverseChunk, b: DiverseChunk): number {
  if (a.embedding && b.embedding && a.embedding.length > 0 && b.embedding.length > 0) {
    return cosine(a.embedding, b.embedding);
  }
  return bigramJaccard(a.snippet, b.snippet);
}

// ---------- MMR selection ----------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Budget-aware MMR greedy selection over a deduplicated candidate pool.
 *
 * MMR(cᵢ) = λ · relevance(cᵢ) − (1−λ) · max_{cⱼ ∈ selected} sim(cᵢ, cⱼ)
 *
 * Similarity uses cosine when embeddings are present, bigram-Jaccard otherwise.
 * Chunks that do not fit in the remaining budget are skipped (not stopped at),
 * so smaller chunks later in the list still get a chance.
 *
 * @param candidates  Deduplicated, time-decayed, threshold-filtered chunks
 * @param budgetTokens  Token budget for the retrieval slot
 * @param lambda  MMR trade-off: 1 = pure relevance, 0 = pure diversity
 */
export function mmrSelectChunks(
  candidates: DiverseChunk[],
  budgetTokens: number,
  lambda: number,
): { chunks: DiverseChunk[]; tokensUsed: number } {
  if (candidates.length === 0 || budgetTokens <= 0) {
    return { chunks: [], tokensUsed: 0 };
  }

  const selected: DiverseChunk[] = [];
  let tokensUsed = 0;
  const remaining = [...candidates];

  while (remaining.length > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score;
      const maxSim =
        selected.length === 0
          ? 0
          : Math.max(...selected.map((s) => chunkSimilarity(remaining[i], s)));
      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) {
      break;
    }

    const [chunk] = remaining.splice(bestIdx, 1);
    const chunkTokens = estimateTokens(chunk.snippet);

    if (tokensUsed + chunkTokens <= budgetTokens) {
      selected.push(chunk);
      tokensUsed += chunkTokens;
    }
    // If this chunk doesn't fit, remove it from remaining and continue —
    // a smaller chunk later may still fit within the budget.
  }

  return { chunks: selected, tokensUsed };
}

// ---------- Full pipeline ----------

/**
 * Canonical diversity pipeline for a merged multi-factor candidate pool:
 *   1. Exact deduplication by (path, startLine)
 *   2. Time-decay (applied upstream — scores already decayed on input)
 *   3. Threshold filtering with floor fallback
 *   4. MMR selection within token budget
 */
export function applyDiversityPipeline(params: {
  chunks: DiverseChunk[];
  budgetTokens: number;
  threshold: number;
  thresholdFloor: number;
  mmrLambda: number;
}): { chunks: DiverseChunk[]; tokensUsed: number; thresholdUsed: number } {
  const { chunks, budgetTokens, threshold, thresholdFloor, mmrLambda } = params;

  // 1. Exact dedup
  const deduped = deduplicateChunks(chunks);

  // 2. Sort by score descending
  deduped.sort((a, b) => b.score - a.score);

  // 3. Threshold filter with floor fallback
  let filtered = deduped.filter((c) => c.score >= threshold);
  if (filtered.length === 0) {
    filtered = deduped.filter((c) => c.score >= thresholdFloor);
  }

  if (filtered.length === 0) {
    return { chunks: [], tokensUsed: 0, thresholdUsed: threshold };
  }

  // 4. MMR selection
  const { chunks: selected, tokensUsed } = mmrSelectChunks(filtered, budgetTokens, mmrLambda);

  const thresholdUsed = selected.length > 0 ? selected[selected.length - 1].score : threshold;

  return { chunks: selected, tokensUsed, thresholdUsed };
}
