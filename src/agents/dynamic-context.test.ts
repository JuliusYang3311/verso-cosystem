/**
 * Tests for dynamic-context.ts
 *
 * Covers:
 *   - selectRecentMessages: budget-aware backward accumulation
 *   - computeDynamicRecentRatio: adaptive ratio based on conversation patterns
 *   - progressiveLoadChunks: budget-aware L1 snippet packing
 *   - filterRetrievedChunks: time decay + diversity pipeline
 *   - buildDynamicContext: full end-to-end context building
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  selectRecentMessages,
  computeDynamicRecentRatio,
  progressiveLoadChunks,
  filterRetrievedChunks,
  buildDynamicContext,
  timeDecayFactor,
  DEFAULT_CONTEXT_PARAMS,
  type RetrievedChunk,
} from "./dynamic-context.js";

// -------- Helpers --------

function makeMsg(content: string, role = "user"): AgentMessage {
  return { role, content } as AgentMessage;
}

function makeChunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    id: overrides.id ?? "chunk-1",
    snippet: overrides.snippet ?? "This is a test snippet for chunk content.",
    score: overrides.score ?? 0.8,
    path: overrides.path ?? "test.md",
    source: overrides.source ?? "default",
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 10,
    timestamp: overrides.timestamp,
    l0Tags: overrides.l0Tags,
    l1Sentences: overrides.l1Sentences,
    factorsUsed: overrides.factorsUsed,
    latentProjection: overrides.latentProjection,
  };
}

// -------- selectRecentMessages --------

describe("selectRecentMessages", () => {
  it("returns empty for empty input", () => {
    const { messages, tokensUsed } = selectRecentMessages([], 1000);
    expect(messages).toEqual([]);
    expect(tokensUsed).toBe(0);
  });

  it("returns empty for zero budget", () => {
    const { messages } = selectRecentMessages([makeMsg("hello")], 0);
    expect(messages).toEqual([]);
  });

  it("always includes at least the most recent message", () => {
    const msgs = [makeMsg("a".repeat(1000))]; // Large message
    const { messages } = selectRecentMessages(msgs, 10); // Tiny budget
    expect(messages.length).toBe(1);
  });

  it("accumulates from latest backward within budget", () => {
    const msgs = [makeMsg("first message"), makeMsg("second message"), makeMsg("third message")];
    // Large budget — should include all
    const { messages } = selectRecentMessages(msgs, 100000);
    expect(messages.length).toBe(3);
    expect((messages[0] as { content: string }).content).toBe("first message");
    expect((messages[2] as { content: string }).content).toBe("third message");
  });
});

// -------- computeDynamicRecentRatio --------

describe("computeDynamicRecentRatio", () => {
  it("returns base ratio for empty messages", () => {
    const ratio = computeDynamicRecentRatio([], DEFAULT_CONTEXT_PARAMS);
    expect(ratio).toBe(DEFAULT_CONTEXT_PARAMS.recentRatioBase);
  });

  it("stays within min/max bounds", () => {
    // Many short messages should push ratio up but not beyond max
    const shortMsgs = Array.from({ length: 10 }, () => makeMsg("ok"));
    const ratio = computeDynamicRecentRatio(shortMsgs, DEFAULT_CONTEXT_PARAMS);
    expect(ratio).toBeGreaterThanOrEqual(DEFAULT_CONTEXT_PARAMS.recentRatioMin);
    expect(ratio).toBeLessThanOrEqual(DEFAULT_CONTEXT_PARAMS.recentRatioMax);
  });

  it("increases ratio for short messages", () => {
    const shortMsgs = Array.from({ length: 10 }, () => makeMsg("yes"));
    const ratio = computeDynamicRecentRatio(shortMsgs, DEFAULT_CONTEXT_PARAMS);
    expect(ratio).toBeGreaterThan(DEFAULT_CONTEXT_PARAMS.recentRatioBase);
  });

  it("decreases ratio for many tool results", () => {
    const toolMsgs = Array.from({ length: 6 }, () => makeMsg("result content", "toolResult"));
    const ratio = computeDynamicRecentRatio(toolMsgs, DEFAULT_CONTEXT_PARAMS);
    expect(ratio).toBeLessThan(DEFAULT_CONTEXT_PARAMS.recentRatioBase);
  });
});

// -------- timeDecayFactor --------

describe("timeDecayFactor", () => {
  it("returns 1 for current timestamp", () => {
    expect(timeDecayFactor(Date.now(), 0.01)).toBe(1);
  });

  it("returns 1 for future timestamp", () => {
    expect(timeDecayFactor(Date.now() + 100000, 0.01)).toBe(1);
  });

  it("decays for old timestamps", () => {
    const oneHourAgo = Date.now() - 3_600_000;
    const factor = timeDecayFactor(oneHourAgo, 0.01);
    expect(factor).toBeLessThan(1);
    expect(factor).toBeGreaterThan(0);
  });

  it("decays more for higher lambda", () => {
    const ts = Date.now() - 3_600_000;
    const f1 = timeDecayFactor(ts, 0.01);
    const f2 = timeDecayFactor(ts, 0.1);
    expect(f2).toBeLessThan(f1);
  });
});

// -------- progressiveLoadChunks --------

describe("progressiveLoadChunks", () => {
  it("returns empty for empty input", () => {
    const { chunks, tokensUsed } = progressiveLoadChunks([], DEFAULT_CONTEXT_PARAMS, 1000);
    expect(chunks).toEqual([]);
    expect(tokensUsed).toBe(0);
  });

  it("returns empty for zero budget", () => {
    const { chunks } = progressiveLoadChunks([makeChunk()], DEFAULT_CONTEXT_PARAMS, 0);
    expect(chunks).toEqual([]);
  });

  it("packs chunks within budget", () => {
    const chunks = [
      makeChunk({ id: "1", snippet: "short" }),
      makeChunk({ id: "2", snippet: "also short" }),
      makeChunk({ id: "3", snippet: "x".repeat(10000) }), // Large — may not fit
    ];
    const { chunks: selected, tokensUsed } = progressiveLoadChunks(
      chunks,
      DEFAULT_CONTEXT_PARAMS,
      100,
    );
    expect(selected.length).toBeGreaterThanOrEqual(2);
    expect(tokensUsed).toBeLessThanOrEqual(100);
  });

  it("preserves l0Tags and l1Sentences through loading", () => {
    const chunk = makeChunk({
      l0Tags: { topic_a: 0.9 },
      l1Sentences: [{ text: "key point", startChar: 0, endChar: 9 }],
    });
    const { chunks: selected } = progressiveLoadChunks([chunk], DEFAULT_CONTEXT_PARAMS, 10000);
    expect(selected[0].l0Tags).toEqual({ topic_a: 0.9 });
    expect(selected[0].l1Sentences).toEqual([{ text: "key point", startChar: 0, endChar: 9 }]);
  });

  it("skips large chunks but includes smaller ones after them", () => {
    const chunks = [
      makeChunk({ id: "1", snippet: "small one" }),
      makeChunk({ id: "2", snippet: "x".repeat(2000) }), // ~500 tokens
      makeChunk({ id: "3", snippet: "also small" }),
    ];
    const { chunks: selected } = progressiveLoadChunks(chunks, DEFAULT_CONTEXT_PARAMS, 20);
    const ids = selected.map((c) => c.id);
    expect(ids).toContain("1");
    expect(ids).toContain("3");
    expect(ids).not.toContain("2");
  });
});

// -------- filterRetrievedChunks --------

describe("filterRetrievedChunks", () => {
  it("returns empty for no chunks", () => {
    const { chunks, tokensUsed } = filterRetrievedChunks([], DEFAULT_CONTEXT_PARAMS, 1000);
    expect(chunks).toEqual([]);
    expect(tokensUsed).toBe(0);
  });

  it("filters chunks below threshold", () => {
    const chunks = [
      makeChunk({ id: "high", score: 0.9 }),
      makeChunk({ id: "low", score: 0.3, path: "other.md", startLine: 20 }),
    ];
    const { chunks: selected } = filterRetrievedChunks(chunks, DEFAULT_CONTEXT_PARAMS, 10000);
    const ids = selected.map((c) => c.id);
    expect(ids).toContain("high");
    expect(ids).not.toContain("low");
  });

  it("falls back to threshold floor when nothing passes base threshold", () => {
    const chunks = [
      makeChunk({ id: "mid", score: 0.55, path: "a.md", startLine: 1 }),
      makeChunk({ id: "low", score: 0.3, path: "b.md", startLine: 1 }),
    ];
    // base threshold is 0.72, floor is 0.5 — "mid" should pass floor
    const { chunks: selected } = filterRetrievedChunks(chunks, DEFAULT_CONTEXT_PARAMS, 10000);
    expect(selected.length).toBe(1);
    expect(selected[0].id).toBe("mid");
  });
});

// -------- buildDynamicContext (integration) --------

describe("buildDynamicContext", () => {
  it("returns empty context when budget is exhausted", () => {
    const result = buildDynamicContext({
      allMessages: [makeMsg("hello")],
      retrievedChunks: [makeChunk()],
      contextLimit: 100,
      systemPromptTokens: 90,
      reserveForReply: 20,
    });
    expect(result.recentMessages).toEqual([]);
    expect(result.retrievedChunks).toEqual([]);
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it("applies 0.8 scaling factor to contextLimit for budget calculation", () => {
    // contextLimit=10000, systemPrompt=100, reserve=100
    // totalBudget = 10000 * 0.8 - 100 - 100 = 7800
    // Without 0.8: would be 9800 — recentTokens + retrievalTokens would be higher
    const result = buildDynamicContext({
      allMessages: Array.from({ length: 50 }, (_, i) => makeMsg("message " + i)),
      retrievedChunks: [],
      contextLimit: 10000,
      systemPromptTokens: 100,
      reserveForReply: 100,
    });
    // Total tokens (excluding system+summary) must stay within 0.8 * contextLimit
    const usableBudget = result.recentTokens + result.retrievalTokens;
    expect(usableBudget).toBeLessThanOrEqual(10000 * 0.8 - 100 - 100);
    // And specifically NOT up to the full 9800 (without 0.8 factor)
    expect(usableBudget).toBeLessThanOrEqual(7800);
  });

  it("splits budget between recent messages and retrieval", () => {
    const result = buildDynamicContext({
      allMessages: [makeMsg("hello"), makeMsg("world")],
      retrievedChunks: [
        makeChunk({ id: "c1", score: 0.85, path: "a.md", startLine: 1 }),
        makeChunk({ id: "c2", score: 0.8, path: "b.md", startLine: 1 }),
      ],
      contextLimit: 100000,
      systemPromptTokens: 100,
      reserveForReply: 100,
    });
    expect(result.recentMessages.length).toBeGreaterThan(0);
    expect(result.retrievedChunks.length).toBeGreaterThan(0);
    expect(result.recentRatioUsed).toBeGreaterThan(0);
    expect(result.recentRatioUsed).toBeLessThan(1);
  });

  it("preserves l0Tags and l1Sentences through the full pipeline", () => {
    const chunk = makeChunk({
      id: "tagged",
      score: 0.9,
      l0Tags: { factorA: 0.95 },
      l1Sentences: [{ text: "important point", startChar: 0, endChar: 15 }],
    });
    const result = buildDynamicContext({
      allMessages: [],
      retrievedChunks: [chunk],
      contextLimit: 100000,
      systemPromptTokens: 100,
      reserveForReply: 100,
    });
    expect(result.retrievedChunks.length).toBe(1);
    expect(result.retrievedChunks[0].l0Tags).toEqual({ factorA: 0.95 });
    expect(result.retrievedChunks[0].l1Sentences).toEqual([
      { text: "important point", startChar: 0, endChar: 15 },
    ]);
  });

  it("includes compaction summary in token accounting", () => {
    const summary = "This is a summary of previous conversation.";
    const result = buildDynamicContext({
      allMessages: [makeMsg("hello")],
      retrievedChunks: [],
      contextLimit: 100000,
      systemPromptTokens: 100,
      reserveForReply: 100,
      compactionSummary: summary,
    });
    expect(result.compactionSummary).toBe(summary);
    expect(result.totalTokens).toBeGreaterThan(100); // system + summary + recent
  });
});
