/**
 * manager-l1-extractive.ts
 * Embedding-based extractive summarization for L1 layer.
 *
 * Algorithm:
 *   1. Split chunk text into sentences
 *   2. Compute centroid (chunk embedding or mean of sentence embeddings)
 *   3. MMR greedy selection:
 *      gain_i = sim(sentence_i, centroid) - max_j∈selected sim(sentence_i, selected_j)
 *   4. Gap detection cutoff: sort gains, find largest drop, stop there
 *   5. Return selected sentences with character offsets
 *
 * No LLM needed — only uses embedding model (already available during indexing).
 */

import { findGapCutoff } from "./latent-factors.js";

export type ExtractedSentence = {
  text: string;
  startChar: number;
  endChar: number;
};

/**
 * Detect whether a text block is predominantly code.
 * Heuristic: high density of code indicators (braces, semicolons, arrows, assignments).
 */
function isCodeBlock(text: string): boolean {
  const codeIndicators = text.match(
    /[{}();=><]|\bfunction\b|\bconst\b|\blet\b|\bvar\b|\breturn\b|\bimport\b|\bclass\b/g,
  );
  const ratio = (codeIndicators?.length ?? 0) / Math.max(1, text.length / 20);
  return ratio > 0.3;
}

/**
 * Split text into sentences. Strategy:
 *
 * 1. Code blocks: split by newlines (code is line-oriented)
 * 2. Natural language: split on sentence-ending punctuation (.!?)
 *    followed by whitespace or end-of-string
 * 3. Fallback: split by newlines if punctuation-based split yields nothing
 */
export function splitSentences(text: string): ExtractedSentence[] {
  // For code-heavy chunks, always split by lines
  if (isCodeBlock(text)) {
    return splitByLines(text);
  }

  const sentences: ExtractedSentence[] = [];
  // Sentence-ending punctuation followed by whitespace or end-of-string.
  // Negative lookbehind avoids splitting on abbreviations like "e.g." or decimals like "0.5".
  const pattern = /[^.!?\n]+(?:[.!?]+(?=\s|$))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const trimmed = match[0].trim();
    if (trimmed.length > 5) {
      sentences.push({
        text: trimmed,
        startChar: match.index,
        endChar: match.index + match[0].length,
      });
    }
  }
  // Fallback: if regex produced nothing useful, split by newlines
  if (sentences.length === 0) {
    return splitByLines(text);
  }
  return sentences;
}

function splitByLines(text: string): ExtractedSentence[] {
  const sentences: ExtractedSentence[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 5) {
      const startChar = text.indexOf(trimmed, offset);
      sentences.push({
        text: trimmed,
        startChar,
        endChar: startChar + trimmed.length,
      });
    }
    offset += line.length + 1;
  }
  return sentences;
}

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

/**
 * Extract key sentences from chunk text using embedding-based MMR with gap detection cutoff.
 *
 * @param sentences - Pre-split sentences with char offsets
 * @param sentenceEmbeddings - Embedding for each sentence (same order)
 * @param centroid - Chunk-level embedding (or mean of sentence embeddings)
 * @returns Selected sentences in original order
 */
export function extractL1Sentences(
  sentences: ExtractedSentence[],
  sentenceEmbeddings: number[][],
  centroid: number[],
): ExtractedSentence[] {
  if (sentences.length === 0) {
    return [];
  }
  if (sentences.length === 1) {
    return [sentences[0]];
  }

  // Compute relevance score for each sentence (similarity to centroid)
  const relevanceScores = sentenceEmbeddings.map((emb) => cosine(emb, centroid));

  // MMR greedy selection
  const selected: number[] = [];
  const remaining = new Set(sentences.map((_, i) => i));
  const gains: number[] = [];

  while (remaining.size > 0) {
    let bestIdx = -1;
    let bestGain = -Infinity;

    for (const idx of remaining) {
      const relevance = relevanceScores[idx];
      // Max similarity to already-selected sentences
      let maxSimToSelected = 0;
      for (const selIdx of selected) {
        const sim = cosine(sentenceEmbeddings[idx], sentenceEmbeddings[selIdx]);
        if (sim > maxSimToSelected) {
          maxSimToSelected = sim;
        }
      }
      const gain = relevance - maxSimToSelected;
      if (gain > bestGain) {
        bestGain = gain;
        bestIdx = idx;
      }
    }

    if (bestIdx < 0) {
      break;
    }

    selected.push(bestIdx);
    gains.push(bestGain);
    remaining.delete(bestIdx);
  }

  // Gap detection on gains to find cutoff
  const cutoff = findGapCutoff(gains);
  const keptIndices = selected.slice(0, cutoff);

  // Return in original document order
  keptIndices.sort((a, b) => a - b);
  return keptIndices.map((i) => sentences[i]);
}
