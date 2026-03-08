/**
 * latent-factors.ts
 *
 * Latent Factor Space for multi-dimensional query projection.
 *
 * Mathematical model
 * ------------------
 * The factor space is a set of "probe directions" {f₁, f₂, ..., fₙ} in the
 * embedding space. A query q is projected onto each factor via cosine similarity,
 * yielding raw coordinates:
 *
 *   raw_i = w_i · cosine(q, f_i)
 *
 * where w_i is a learnable per-factor weight (default 1.0). The raw coordinates
 * are then passed through softmax to obtain a proper probability distribution
 * over factors — this eliminates the "curse of dimensionality" effect where all
 * high-dimensional cosine similarities collapse toward zero:
 *
 *   score_i = softmax(raw)_i = exp(raw_i) / Σ_j exp(raw_j)
 *
 * This is analogous to a weighted Fourier transform: each factor is a basis
 * direction, the scores are the spectral coefficients, and the softmax ensures
 * the "spectrum" is always meaningful regardless of embedding dimensionality.
 *
 * When no pre-computed vector exists for the current model, the system falls
 * back to bigram-Jaccard similarity and triggers async embedding of all factors
 * (fire-and-forget, idempotent). Subsequent queries will use the real projection.
 *
 * Key design: vectors vs weights
 * --------------------------------
 * `vectors` are keyed by `providerModel` only — the embedding space is a property
 * of the model, shared across all use cases that use the same model.
 *
 * `weights` are keyed by `{providerModel}:{useCase}` — the same embedding model
 * can be used in different application contexts (e.g. "memory" vs "web"), each
 * with independently learned factor weights. This allows the evolver to tune
 * memory retrieval and web search separately even when they share an embedding model.
 *
 * Weight learning
 * ---------------
 * Weights are updated externally (e.g. by the evolver) using `updateFactorWeight`.
 * A factor that consistently produces high-scoring retrievals gets its weight
 * increased; one that produces misses gets decreased.
 *
 * Factor set extensibility
 * ------------------------
 * The factor set is intentionally not a complete orthogonal basis — it is a
 * sparse set of semantically meaningful probe directions. When a new factor is
 * added to factor-space.json, `registerFactorVectors` automatically initialises
 * its weight to 1.0 for the given weightKey, keeping weights and factors in sync.
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Override in tests via LATENT_FACTOR_SPACE_PATH to avoid polluting production data. */
function factorSpacePath(): string {
  if (process.env.LATENT_FACTOR_SPACE_PATH) {
    return process.env.LATENT_FACTOR_SPACE_PATH;
  }

  // Prefer workspace copy (writable, evolver can optimize it)
  const workspaceRoot =
    process.env.VERSO_WORKSPACE || path.join(os.homedir(), ".verso", "workspace");
  const workspacePath = path.join(workspaceRoot, "evolver", "assets", "factor-space.json");
  if (fsSync.existsSync(workspacePath)) {
    return workspacePath;
  }

  // Find bundled default and seed into workspace.
  // Bundler may place this chunk in dist/evolver/ or dist/memory/ — walk up to dist root.
  const candidates = [
    path.resolve(__dirname, "factor-space.json"),
    path.resolve(__dirname, "memory", "factor-space.json"),
    path.resolve(__dirname, "..", "memory", "factor-space.json"),
    path.resolve(__dirname, "..", "..", "memory", "factor-space.json"),
  ];
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      const dir = path.dirname(workspacePath);
      fsSync.mkdirSync(dir, { recursive: true });
      fsSync.copyFileSync(candidate, workspacePath);
      return workspacePath;
    }
  }

  // Last resort: return the bundled path even if missing
  return candidates[0]!;
}

// ---------- Types ----------

/**
 * A single latent factor (probe direction in embedding space).
 *
 * `vectors`  — providerModel → unit-normalised embedding of the factor description.
 *              Empty object means no vectors yet; bigram-Jaccard fallback is used.
 * `weights`  — "{providerModel}:{useCase}" → learnable scalar applied before softmax.
 *              Keyed by use-case so that memory search and web search can have
 *              independent calibrations even when sharing the same embedding model.
 *              Defaults to 1.0 when absent.
 */
export type LatentFactor = {
  id: string;
  description: string;
  subqueryTemplate: string;
  /** providerModel → unit-normalised embedding vector */
  vectors: Record<string, number[]>;
  /** "{providerModel}:{useCase}" → learnable weight (default 1.0) */
  weights: Record<string, number>;
};

export type LatentFactorSpace = {
  version: string;
  factors: LatentFactor[];
};

export type FactorScore = {
  factor: LatentFactor;
  /** softmax-normalised score ∈ (0, 1), sums to 1 across all factors */
  score: number;
  /** raw weighted cosine (or bigram-Jaccard) before softmax — useful for debugging */
  rawScore: number;
};

/** Canonical weight key for a given model + use-case pair. */
export function weightKey(providerModel: string, useCase: string): string {
  return `${providerModel}:${useCase}`;
}

// ---------- Load / persist ----------

let _cachedSpace: LatentFactorSpace | null = null;

/**
 * Load the factor space from disk. Result is cached in-process.
 * Call `invalidateFactorSpaceCache()` after writing new vectors or weights.
 */
export async function loadFactorSpace(): Promise<LatentFactorSpace> {
  if (_cachedSpace) {
    return _cachedSpace;
  }
  const p = factorSpacePath();
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch {
    // Do not cache missing file — allow retry on next call.
    return { version: "1.0.0", factors: [] };
  }
  const parsed = JSON.parse(raw) as {
    version: string;
    factors: Array<Omit<LatentFactor, "weights"> & { weights?: Record<string, number> }>;
  };
  // Backfill missing `weights` field for factors loaded from older JSON
  _cachedSpace = {
    ...parsed,
    factors: parsed.factors.map((f) => ({ ...f, weights: f.weights ?? {} })),
  };
  return _cachedSpace;
}

export function invalidateFactorSpaceCache(): void {
  _cachedSpace = null;
}

export async function saveFactorSpace(space: LatentFactorSpace): Promise<void> {
  const p = factorSpacePath();
  await fs.writeFile(p, JSON.stringify(space, null, 2), "utf-8");
  _cachedSpace = space;
}

// ---------- Similarity helpers ----------

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function bigramSet(s: string): Set<string> {
  const set = new Set<string>();
  const lower = s.toLowerCase();
  for (let i = 0; i < lower.length - 1; i++) {
    set.add(lower.slice(i, i + 2));
  }
  return set;
}

function bigramJaccard(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) {
    return 0;
  }
  const setA = bigramSet(a);
  const setB = bigramSet(b);
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
 * Numerically stable softmax.
 * Subtracts max before exp to prevent overflow.
 */
function softmax(values: number[]): number[] {
  if (values.length === 0) {
    return [];
  }
  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return sum === 0 ? exps.map(() => 1 / values.length) : exps.map((e) => e / sum);
}

// ---------- Core projection ----------

/**
 * Project a query into the factor space, returning softmax-normalised scores.
 *
 * Pipeline:
 *   1. For each factor fᵢ, compute raw_i = w_i · sim(q, fᵢ)
 *      - w_i   = weights["{providerModel}:{useCase}"] ?? 1.0
 *      - sim   = cosine(queryVec, factorVec)  if embedding available
 *      - sim   = bigramJaccard(queryText, fᵢ.description)  otherwise
 *   2. Apply softmax over all raw_i → score_i
 *
 * The softmax step is what makes this a proper "Fourier decomposition" of the
 * query: the scores represent the relative energy in each factor dimension,
 * independent of the absolute magnitude of cosine similarities (which collapse
 * in high-dimensional spaces).
 */
export function projectQueryToFactors(
  queryVec: number[],
  queryText: string,
  space: LatentFactorSpace,
  providerModel: string,
  useCase: string,
): FactorScore[] {
  const hasEmbedding = queryVec.length > 0;
  const wKey = weightKey(providerModel, useCase);

  const rawScores = space.factors.map((factor) => {
    const factorVec = factor.vectors[providerModel];
    const weight = factor.weights[wKey] ?? 1.0;
    const sim =
      hasEmbedding && factorVec && factorVec.length > 0
        ? cosine(queryVec, factorVec)
        : bigramJaccard(queryText, factor.description);
    return weight * sim;
  });

  const normalised = softmax(rawScores);

  return space.factors.map((factor, i) => ({
    factor,
    score: normalised[i],
    rawScore: rawScores[i],
  }));
}

/**
 * Coarse threshold gate: keep only factors whose softmax score >= threshold.
 * If nothing passes, returns the single highest-scoring factor as a fallback
 * so retrieval is never empty.
 */
export function selectFactorsAboveThreshold(
  scores: FactorScore[],
  threshold: number,
): FactorScore[] {
  const passing = scores.filter((s) => s.score >= threshold);
  if (passing.length > 0) {
    return passing;
  }
  const best = scores.reduce((a, b) => (b.score > a.score ? b : a), scores[0]);
  return best ? [best] : [];
}

/**
 * MMR-style diversification across factors.
 *
 * Selects all candidates ordered by MMR score — relevant and mutually dissimilar.
 *
 * Inter-factor similarity uses factor vectors (cosine) when available,
 * falling back to bigram-Jaccard over descriptions.
 *
 * MMR(fᵢ) = λ · score_i − (1−λ) · max_{fⱼ ∈ selected} sim(fᵢ, fⱼ)
 */
export function mmrDiversifyFactors(
  candidates: FactorScore[],
  providerModel: string,
  lambda: number,
): FactorScore[] {
  if (candidates.length === 0) {
    return [];
  }

  const selected: FactorScore[] = [];
  const remaining = [...candidates];

  const interSim = (a: LatentFactor, b: LatentFactor): number => {
    const va = a.vectors[providerModel];
    const vb = b.vectors[providerModel];
    if (va && vb && va.length > 0 && vb.length > 0) {
      return cosine(va, vb);
    }
    return bigramJaccard(a.description, b.description);
  };

  while (remaining.length > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score;
      const maxSim =
        selected.length === 0
          ? 0
          : Math.max(...selected.map((s) => interSim(remaining[i].factor, s.factor)));
      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) {
      break;
    }
    const [picked] = remaining.splice(bestIdx, 1);
    selected.push(picked);
  }

  return selected;
}

/**
 * Build sub-queries for each selected factor by filling the factor's template.
 * Supports both `{entity}` and `{query}` placeholder conventions.
 */
export function buildSubqueries(
  queryText: string,
  selectedFactors: FactorScore[],
): Array<{ factorId: string; subquery: string }> {
  return selectedFactors.map(({ factor }) => ({
    factorId: factor.id,
    subquery: factor.subqueryTemplate
      .replace("{entity}", queryText)
      .replace("{query}", queryText)
      .trim(),
  }));
}

/**
 * Full pipeline: query → softmax factor scores → MMR selection → sub-queries.
 */
export function queryToSubqueries(params: {
  queryVec: number[];
  queryText: string;
  space: LatentFactorSpace;
  providerModel: string;
  useCase: string;
  threshold: number;
  mmrLambda: number;
}): { selectedFactors: FactorScore[]; subqueries: Array<{ factorId: string; subquery: string }> } {
  const { queryVec, queryText, space, providerModel, useCase, threshold, mmrLambda } = params;

  const allScores = projectQueryToFactors(queryVec, queryText, space, providerModel, useCase);
  const aboveThreshold = selectFactorsAboveThreshold(allScores, threshold);
  const selectedFactors = mmrDiversifyFactors(aboveThreshold, providerModel, mmrLambda);
  const subqueries = buildSubqueries(queryText, selectedFactors);

  return { selectedFactors, subqueries };
}

// ---------- Factor vector registration ----------

/**
 * Register pre-computed embedding vectors for all factors under a given providerModel.
 *
 * - Vectors must be ordered to match space.factors order.
 * - Automatically initialises weights to 1.0 for the given weightKey for any
 *   factor that does not yet have an entry — this keeps weights and factors in
 *   sync whenever new factors are added to the space.
 * - Persists to disk and invalidates the in-process cache.
 *
 * @param useCase  The application context for which to initialise weights
 *                 (e.g. "memory" or "web"). Vectors are shared across use cases;
 *                 weights are per use case.
 */
export async function registerFactorVectors(
  space: LatentFactorSpace,
  providerModel: string,
  useCase: string,
  vectors: number[][],
): Promise<LatentFactorSpace> {
  if (vectors.length !== space.factors.length) {
    throw new Error(
      `registerFactorVectors: expected ${space.factors.length} vectors, got ${vectors.length}`,
    );
  }
  const wKey = weightKey(providerModel, useCase);
  const updated: LatentFactorSpace = {
    ...space,
    factors: space.factors.map((f, i) => ({
      ...f,
      vectors: { ...f.vectors, [providerModel]: vectors[i] },
      weights: { ...f.weights, [wKey]: f.weights[wKey] ?? 1.0 },
    })),
  };
  await saveFactorSpace(updated);
  return updated;
}

/**
 * Update the learnable weight for a single factor.
 *
 * @param factorId      ID of the factor to update.
 * @param providerModel Embedding model key.
 * @param useCase       Application context ("memory" | "web" | …).
 * @param newWeight     New weight value; clamped to [0.1, 10.0].
 */
export async function updateFactorWeight(
  space: LatentFactorSpace,
  factorId: string,
  providerModel: string,
  useCase: string,
  newWeight: number,
): Promise<LatentFactorSpace> {
  const clamped = Math.max(0.1, Math.min(10.0, newWeight));
  const wKey = weightKey(providerModel, useCase);
  const updated: LatentFactorSpace = {
    ...space,
    factors: space.factors.map((f) =>
      f.id === factorId ? { ...f, weights: { ...f.weights, [wKey]: clamped } } : f,
    ),
  };
  await saveFactorSpace(updated);
  return updated;
}

// ---------- Lazy factor embedding ----------

// In-flight embedding promises keyed by providerModel — prevents duplicate work
const _embeddingInFlight = new Map<string, Promise<void>>();

/**
 * Ensure all factors have embedding vectors for the given providerModel.
 *
 * If vectors are already present, returns immediately (no I/O).
 * Otherwise, embeds all factor descriptions in a single batch and persists.
 * Uses an in-flight lock so concurrent callers share the same promise.
 *
 * Designed to be called fire-and-forget at query time:
 *   void ensureFactorVectors(space, providerModel, useCase, embedBatch).catch(...)
 *
 * The current query continues with bigram-Jaccard fallback; subsequent queries
 * will use the real embedding projection.
 */
export function ensureFactorVectors(
  space: LatentFactorSpace,
  providerModel: string,
  useCase: string,
  embedBatch: (texts: string[]) => Promise<number[][]>,
): Promise<void> {
  const allPresent = space.factors.every(
    (f) => f.vectors[providerModel] && f.vectors[providerModel].length > 0,
  );
  if (allPresent) {
    return Promise.resolve();
  }

  const existing = _embeddingInFlight.get(providerModel);
  if (existing) {
    return existing;
  }

  const work = (async () => {
    const descriptions = space.factors.map((f) => f.description);
    const vectors = await embedBatch(descriptions);
    await registerFactorVectors(space, providerModel, useCase, vectors);
  })().finally(() => {
    _embeddingInFlight.delete(providerModel);
  });

  _embeddingInFlight.set(providerModel, work);
  return work;
}
