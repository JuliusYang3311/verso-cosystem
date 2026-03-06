/**
 * manager-hierarchical-search.ts
 * Two-phase hierarchical search: file-level pre-filter → chunk-level search with score propagation.
 * Replaces flat chunk search when `hierarchicalSearch` is enabled in context_params.
 */
import { bm25RankToScore, buildFtsQuery, mergeHybridFileResults } from "./hybrid.js";
import { searchKeywordFiles, searchVector, searchVectorFiles } from "./manager-search.js";
export async function searchHierarchical(params) {
  const {
    db,
    queryVec,
    query,
    limit,
    contextParams,
    filesVectorTable,
    filesFtsTable,
    filesFtsAvailable,
  } = params;
  const fileThreshold = contextParams.hierarchicalFileThreshold ?? 0.5;
  const fileThresholdFloor = contextParams.hierarchicalFileThresholdFloor ?? 0.3;
  const alpha = contextParams.hierarchicalAlpha ?? 0.7;
  const convergenceRounds = contextParams.hierarchicalConvergenceRounds ?? 3;
  const fileVecWeight = contextParams.fileVectorWeight ?? 0.7;
  const fileBm25Weight = contextParams.fileBm25Weight ?? 0.3;
  // No limit — threshold filtering decides the final count.
  const fileLimit = contextParams.hierarchicalFileLimit ?? 10;
  // ---- Phase 1: File-level pre-filter ----
  const vectorFiles =
    queryVec.length > 0
      ? await searchVectorFiles({
          db,
          filesVectorTable,
          queryVec,
          limit: fileLimit,
          ensureFileVectorReady: params.ensureFileVectorReady,
        }).catch(() => [])
      : [];
  const keywordFiles =
    filesFtsAvailable && query
      ? searchKeywordFiles({
          db,
          filesFtsTable,
          query,
          limit: fileLimit,
          buildFtsQuery,
          bm25RankToScore,
        })
      : [];
  const topFiles = mergeHybridFileResults({
    vector: vectorFiles.map((f) => ({
      path: f.path,
      source: f.source,
      score: f.score,
      l0Abstract: f.l0Abstract,
    })),
    keyword: keywordFiles.map((f) => ({
      path: f.path,
      source: f.source,
      score: f.score,
      l0Abstract: f.l0Abstract,
    })),
    vectorWeight: fileVecWeight,
    textWeight: fileBm25Weight,
  });
  // Threshold-driven file selection (learnable).
  // Falls back to fileThresholdFloor if nothing passes primary threshold.
  // Guarantees at least 1 file if any results exist.
  const selectFiles = (files, threshold) => files.filter((f) => f.score >= threshold);
  let selectedFiles = selectFiles(topFiles, fileThreshold);
  if (selectedFiles.length === 0) {
    selectedFiles = selectFiles(topFiles, fileThresholdFloor);
  }
  if (selectedFiles.length === 0 && topFiles.length > 0) {
    selectedFiles = [topFiles[0]];
  }
  if (selectedFiles.length === 0) {
    // No file-level results — fall back to flat search
    return searchVector({
      db: params.db,
      vectorTable: params.vectorTable,
      providerModel: params.providerModel,
      queryVec: params.queryVec,
      limit,
      snippetMaxChars: params.snippetMaxChars,
      ensureVectorReady: params.ensureVectorReady,
      sourceFilterVec: params.sourceFilterVec,
      sourceFilterChunks: params.sourceFilterChunks,
    });
  }
  // ---- Phase 2: Chunk-level search within top files + score propagation ----
  const allChunks = [];
  let stableRounds = 0;
  let prevTopK = [];
  for (const file of selectedFiles) {
    // Search chunks within this file using path filter
    const pathFilter = {
      sql: ` AND c.path = ?`,
      params: [file.path],
    };
    const chunkPathFilter = {
      sql: ` AND path = ?`,
      params: [file.path],
    };
    const chunkResults = await searchVector({
      db: params.db,
      vectorTable: params.vectorTable,
      providerModel: params.providerModel,
      queryVec: params.queryVec,
      limit: Math.ceil(limit / 2),
      snippetMaxChars: params.snippetMaxChars,
      ensureVectorReady: params.ensureVectorReady,
      sourceFilterVec: {
        sql: params.sourceFilterVec.sql + pathFilter.sql,
        params: [...params.sourceFilterVec.params, ...pathFilter.params],
      },
      sourceFilterChunks: {
        sql: params.sourceFilterChunks.sql + chunkPathFilter.sql,
        params: [...params.sourceFilterChunks.params, ...chunkPathFilter.params],
      },
    });
    // Score propagation: final = α * chunk_score + (1-α) * file_score
    for (const chunk of chunkResults) {
      allChunks.push({
        ...chunk,
        score: alpha * chunk.score + (1 - alpha) * file.score,
      });
    }
    // Early termination: check if top-k has converged
    if (allChunks.length >= limit) {
      const sorted = allChunks.toSorted((a, b) => b.score - a.score);
      const currentTopK = sorted.slice(0, limit).map((c) => c.id);
      const isStable = currentTopK.every((id, i) => id === prevTopK[i]);
      if (isStable) {
        stableRounds++;
        if (stableRounds >= convergenceRounds) {
          break;
        }
      } else {
        stableRounds = 0;
      }
      prevTopK = currentTopK;
    }
  }
  // Sort by final score and return top results
  return allChunks.toSorted((a, b) => b.score - a.score).slice(0, limit);
}
