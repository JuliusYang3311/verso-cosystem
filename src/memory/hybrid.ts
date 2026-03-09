export type HybridSource = string;

export type HybridVectorResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  vectorScore: number;
  timestamp?: number;
};

export type HybridKeywordResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  textScore: number;
};

/**
 * Build an FTS5 query from raw user input.
 * Supports Unicode (Chinese, Japanese, etc.) via \p{L} character class.
 * For trigram tokenizer: wraps each token in double quotes for substring matching.
 */
export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) {
    return null;
  }
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" AND ");
}

/**
 * Convert FTS5 bm25() rank to a score in (0, 1).
 * FTS5 bm25() returns negative values — more negative = more relevant.
 * Sigmoid maps this to (0, 1) while preserving ranking order.
 */
export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) {
    return 0;
  }
  // rank is negative (e.g. -5.2 = very relevant, -0.3 = less relevant)
  // sigmoid(-rank) maps: -5.2 → sigmoid(5.2) ≈ 0.99, -0.3 → sigmoid(0.3) ≈ 0.57
  return 1 / (1 + Math.exp(rank));
}

/**
 * Softmax: exp(s_i) / Σ exp(s_j), with log-sum-exp trick for numerical stability.
 */
function softmax(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/**
 * Merge vector and keyword search results using softmax-normalized score fusion.
 *
 *   final = vectorWeight × softmax(vectorScores) + textWeight × softmax(textScores)
 *
 * Softmax independently normalizes each source into a smooth probability
 * distribution, eliminating scale differences between cosine and BM25.
 * Items appearing in both sources accumulate contributions from both.
 */
export function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
}): Array<{
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: HybridSource;
  timestamp?: number;
}> {
  const entryMap = new Map<
    string,
    {
      id: string;
      path: string;
      startLine: number;
      endLine: number;
      source: HybridSource;
      snippet: string;
      rawScore: number;
      timestamp?: number;
    }
  >();

  const vecSm = softmax(params.vector.map((r) => r.vectorScore));
  for (let i = 0; i < params.vector.length; i++) {
    const r = params.vector[i];
    entryMap.set(r.id, {
      id: r.id,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      source: r.source,
      snippet: r.snippet,
      rawScore: params.vectorWeight * vecSm[i],
      timestamp: r.timestamp,
    });
  }

  const kwSm = softmax(params.keyword.map((r) => r.textScore));
  for (let i = 0; i < params.keyword.length; i++) {
    const r = params.keyword[i];
    const contribution = params.textWeight * kwSm[i];
    const existing = entryMap.get(r.id);
    if (existing) {
      existing.rawScore += contribution;
      if (r.snippet && r.snippet.length > 0) {
        existing.snippet = r.snippet;
      }
    } else {
      entryMap.set(r.id, {
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        rawScore: contribution,
        timestamp: undefined,
      });
    }
  }

  return Array.from(entryMap.values())
    .map((entry) => ({
      id: entry.id,
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      score: entry.rawScore,
      snippet: entry.snippet,
      source: entry.source,
      timestamp: entry.timestamp,
    }))
    .sort((a, b) => b.score - a.score);
}
