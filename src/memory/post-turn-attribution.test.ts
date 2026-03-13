import { describe, expect, it } from "vitest";
import type { InjectedChunkRecord } from "../agents/pi-extensions/dynamic-context/runtime.js";
import { computeAttribution } from "./post-turn-attribution.js";

function makeChunk(overrides: Partial<InjectedChunkRecord> = {}): InjectedChunkRecord {
  return {
    id: "chunk-1",
    path: "file.ts",
    startLine: 1,
    endLine: 10,
    snippet: "The memory retrieval system uses cosine similarity for ranking results efficiently",
    score: 0.85,
    factorIds: ["f1"],
    ...overrides,
  };
}

describe("computeAttribution", () => {
  it("returns empty result when no chunks injected", () => {
    const result = computeAttribution({
      injectedChunks: [],
      assistantOutput: "some output",
      toolMetas: [],
      sessionId: "s1",
    });
    expect(result.injectedCount).toBe(0);
    expect(result.events).toHaveLength(0);
  });

  it("marks chunk as utilized when phrase matches output", () => {
    const chunk = makeChunk({
      snippet: "The memory retrieval system uses cosine similarity for ranking results",
    });
    const result = computeAttribution({
      injectedChunks: [chunk],
      assistantOutput:
        "Based on the data, the memory retrieval system uses cosine similarity for ranking results.",
      toolMetas: [],
      sessionId: "s1",
    });
    expect(result.injectedCount).toBe(1);
    expect(result.utilizedCount).toBe(1);
    expect(result.ignoredCount).toBe(0);
    expect(result.events).toHaveLength(2); // injected + utilized
    expect(result.events[0].event).toBe("injected");
    expect(result.events[1].event).toBe("utilized");
  });

  it("marks chunk as ignored when no phrase match", () => {
    const chunk = makeChunk({
      snippet: "The memory retrieval system uses cosine similarity for ranking",
    });
    const result = computeAttribution({
      injectedChunks: [chunk],
      assistantOutput: "I don't know anything about that topic.",
      toolMetas: [],
      sessionId: "s1",
    });
    expect(result.ignoredCount).toBe(1);
    expect(result.utilizedCount).toBe(0);
    expect(result.events[1].event).toBe("ignored");
  });

  it("marks chunk as l1_miss when memory_get called with chunk id", () => {
    const chunk = makeChunk({ id: "chunk-42" });
    const result = computeAttribution({
      injectedChunks: [chunk],
      assistantOutput: "Let me look at the full content.",
      toolMetas: [{ toolName: "memory_get", meta: JSON.stringify({ chunkId: "chunk-42" }) }],
      sessionId: "s1",
    });
    expect(result.l1MissCount).toBe(1);
    expect(result.utilizedCount).toBe(0);
    expect(result.ignoredCount).toBe(0);
    expect(result.events[1].event).toBe("l1_miss");
  });

  it("l1_miss takes priority over phrase match", () => {
    const chunk = makeChunk({
      id: "chunk-42",
      snippet: "The memory retrieval system uses cosine similarity for ranking results efficiently",
    });
    const result = computeAttribution({
      injectedChunks: [chunk],
      assistantOutput:
        "The memory retrieval system uses cosine similarity for ranking results efficiently.",
      toolMetas: [{ toolName: "memory_get", meta: JSON.stringify({ chunkId: "chunk-42" }) }],
      sessionId: "s1",
    });
    // l1_miss wins over utilized
    expect(result.l1MissCount).toBe(1);
    expect(result.utilizedCount).toBe(0);
  });

  it("handles multiple chunks with mixed attributions", () => {
    const chunks = [
      makeChunk({
        id: "c1",
        snippet: "The memory retrieval system uses cosine similarity for ranking results",
      }),
      makeChunk({
        id: "c2",
        snippet: "Vector databases store embeddings for efficient nearest neighbor search",
      }),
      makeChunk({ id: "c3", snippet: "Short." }),
    ];
    const result = computeAttribution({
      injectedChunks: chunks,
      assistantOutput:
        "The memory retrieval system uses cosine similarity for ranking results well.",
      toolMetas: [],
      sessionId: "s1",
    });
    expect(result.injectedCount).toBe(3);
    expect(result.utilizedCount).toBe(1); // c1 matched
    expect(result.ignoredCount).toBe(2); // c2 + c3 (too short)
    expect(result.events).toHaveLength(6); // 3 injected + 3 attribution
  });

  it("preserves factorIds and score on events", () => {
    const chunk = makeChunk({ factorIds: ["f1", "f2"], score: 0.92 });
    const result = computeAttribution({
      injectedChunks: [chunk],
      assistantOutput: "irrelevant",
      toolMetas: [],
      sessionId: "s1",
    });
    for (const e of result.events) {
      expect(e.factorIds).toEqual(["f1", "f2"]);
      expect(e.score).toBe(0.92);
      expect(e.sessionId).toBe("s1");
    }
  });

  it("handles malformed memory_get meta gracefully", () => {
    const chunk = makeChunk({ id: "c1" });
    const result = computeAttribution({
      injectedChunks: [chunk],
      assistantOutput: "irrelevant",
      toolMetas: [
        { toolName: "memory_get", meta: "not-json" },
        { toolName: "memory_get", meta: null },
      ],
      sessionId: "s1",
    });
    // Should not crash, chunk should be ignored (no phrase match either)
    expect(result.ignoredCount).toBe(1);
  });

  it("is case-insensitive for phrase matching", () => {
    const chunk = makeChunk({
      snippet: "The Memory Retrieval System Uses Cosine Similarity For Ranking",
    });
    const result = computeAttribution({
      injectedChunks: [chunk],
      assistantOutput: "the memory retrieval system uses cosine similarity for ranking is great",
      toolMetas: [],
      sessionId: "s1",
    });
    expect(result.utilizedCount).toBe(1);
  });
});
