/**
 * Tests for manager-l1-extractive.ts
 *
 * Covers:
 *   - splitSentences: natural language, code blocks, edge cases
 *   - extractL1Sentences: MMR selection with gap detection cutoff
 */

import { describe, expect, it } from "vitest";
import {
  splitSentences,
  extractL1Sentences,
  type ExtractedSentence,
} from "./manager-l1-extractive.js";

// -------- splitSentences --------

describe("splitSentences", () => {
  it("splits natural language on sentence-ending punctuation", () => {
    const text = "This is the first sentence. Here is the second one! And a third?";
    const result = splitSentences(text);
    expect(result.length).toBe(3);
    expect(result[0].text).toContain("first sentence");
    expect(result[1].text).toContain("second one");
    expect(result[2].text).toContain("third");
  });

  it("tracks character offsets correctly", () => {
    const text = "Hello world. Goodbye world.";
    const result = splitSentences(text);
    for (const s of result) {
      expect(text.slice(s.startChar, s.endChar).trim()).toBe(s.text);
    }
  });

  it("uses line-based splitting for code blocks", () => {
    const code = [
      "function greet(name) {",
      "  const message = `Hello ${name}`;",
      "  return message;",
      "}",
    ].join("\n");
    const result = splitSentences(code);
    // Should split by lines, not by punctuation
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result[0].text).toContain("function greet");
  });

  it("does not break on decimals or dotted identifiers in code", () => {
    const code = "const x = 0.5;\nconsole.log(x);\nreturn x;";
    const result = splitSentences(code);
    // Code detection should kick in — lines should stay intact
    const texts = result.map((s) => s.text);
    expect(texts.some((t) => t.includes("0.5"))).toBe(true);
    expect(texts.some((t) => t.includes("console.log"))).toBe(true);
  });

  it("falls back to line splitting when no sentence punctuation found", () => {
    const text = "first line\nsecond line\nthird line is long enough";
    const result = splitSentences(text);
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns empty array for very short text", () => {
    const result = splitSentences("hi");
    expect(result).toEqual([]);
  });

  it("handles empty string", () => {
    const result = splitSentences("");
    expect(result).toEqual([]);
  });

  it("handles mixed code and prose in code-heavy block", () => {
    const text = [
      "import { foo } from 'bar';",
      "// This function does things.",
      "export function doThings() {",
      "  return foo();",
      "}",
    ].join("\n");
    const result = splitSentences(text);
    // Should be line-based since it's code-heavy
    expect(result.length).toBeGreaterThanOrEqual(3);
  });
});

// -------- extractL1Sentences --------

describe("extractL1Sentences", () => {
  // Helper: create orthogonal unit vectors
  function unitVec(dim: number, idx: number): number[] {
    const v = Array(dim).fill(0);
    v[idx] = 1;
    return v;
  }

  it("returns single sentence when only one provided", () => {
    const sentences: ExtractedSentence[] = [{ text: "Only sentence.", startChar: 0, endChar: 14 }];
    const result = extractL1Sentences(sentences, [unitVec(3, 0)], unitVec(3, 0));
    expect(result).toEqual(sentences);
  });

  it("returns empty array for empty input", () => {
    const result = extractL1Sentences([], [], unitVec(3, 0));
    expect(result).toEqual([]);
  });

  it("selects diverse sentences via MMR", () => {
    // 4 sentences: two very similar to centroid, two different
    // Centroid is [1,0,0]
    const centroid = [1, 0, 0];
    const sentences: ExtractedSentence[] = [
      { text: "Sentence A (relevant)", startChar: 0, endChar: 10 },
      { text: "Sentence B (relevant duplicate)", startChar: 10, endChar: 20 },
      { text: "Sentence C (different)", startChar: 20, endChar: 30 },
      { text: "Sentence D (orthogonal)", startChar: 30, endChar: 40 },
    ];
    // A and B are both close to centroid (and close to each other)
    // C is somewhat relevant, D is orthogonal
    const embeddings = [
      [0.95, 0.05, 0], // A: high relevance
      [0.93, 0.07, 0], // B: also high relevance, very similar to A
      [0.5, 0.5, 0], // C: moderate relevance, different direction
      [0, 0, 1], // D: orthogonal to centroid
    ];

    const result = extractL1Sentences(sentences, embeddings, centroid);
    // MMR should pick A first (highest relevance), then prefer C over B (more diverse)
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].text).toBe("Sentence A (relevant)");
  });

  it("applies gap detection cutoff to stop adding low-gain sentences", () => {
    // Create a scenario with a clear gap in gains
    const centroid = [1, 0, 0, 0];
    const sentences: ExtractedSentence[] = Array.from({ length: 5 }, (_, i) => ({
      text: `Sentence ${i}`,
      startChar: i * 20,
      endChar: (i + 1) * 20,
    }));
    // First two are relevant to centroid, rest are near-zero
    const embeddings = [
      [0.9, 0.1, 0, 0], // high relevance
      [0.1, 0.9, 0, 0], // different direction, moderate relevance
      [0, 0, 0.01, 0], // very low relevance
      [0, 0, 0, 0.01], // very low relevance
      [0.005, 0, 0, 0], // near-zero
    ];

    const result = extractL1Sentences(sentences, embeddings, centroid);
    // Gap detection should cut off the near-zero gain sentences
    expect(result.length).toBeLessThan(5);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("returns results in original document order", () => {
    const centroid = [1, 0, 0];
    const sentences: ExtractedSentence[] = [
      { text: "First in doc", startChar: 0, endChar: 10 },
      { text: "Second in doc", startChar: 10, endChar: 20 },
      { text: "Third in doc", startChar: 20, endChar: 30 },
    ];
    // Third has highest relevance, second moderate, first low
    const embeddings = [
      [0.3, 0.7, 0],
      [0.6, 0.4, 0],
      [0.95, 0.05, 0],
    ];

    const result = extractL1Sentences(sentences, embeddings, centroid);
    // Regardless of MMR selection order, output should be sorted by startChar
    for (let i = 1; i < result.length; i++) {
      expect(result[i].startChar).toBeGreaterThan(result[i - 1].startChar);
    }
  });
});
