/**
 * dynamic-context extension tests
 *
 * Tests the SDK extension layer (extension.ts):
 *   - Registration of "context" event handler
 *   - No-op when runtime is absent
 *   - Memory search → <memory-context> block assembly
 *   - Injection format: [path:start-end] (score=X.XX)\nsnippet
 *   - Error fallback: memory search throws → returns original messages unchanged
 *   - loadContextParams fallback: no evolver file → defaults used, handler still works
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { MemorySearchResult } from "../../memory/types.js";
import dynamicContextExtension from "./dynamic-context/extension.js";
import { setDynamicContextRuntime } from "./dynamic-context/runtime.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture the "context" event handler registered by the extension. */
function buildExtension() {
  let contextHandler:
    | ((event: unknown, ctx: unknown) => Promise<{ messages: AgentMessage[] } | undefined>)
    | undefined;

  const api = {
    on(event: string, handler: typeof contextHandler) {
      if (event === "context") {
        contextHandler = handler as typeof contextHandler;
      }
    },
  } as unknown as ExtensionAPI;

  dynamicContextExtension(api);

  return {
    callContext: (event: unknown, ctx: unknown) => {
      if (!contextHandler) throw new Error("handler not registered");
      return contextHandler(event, ctx);
    },
  };
}

function makeSessionManager(): object {
  return {};
}

function makeCtx(
  sessionManager: object,
  opts: { systemPrompt?: string; contextWindow?: number } = {},
): ExtensionContext {
  return {
    sessionManager,
    getSystemPrompt: () => opts.systemPrompt ?? "",
    model: { contextWindow: opts.contextWindow ?? 100_000 },
  } as unknown as ExtensionContext;
}

function makeEvent(messages: AgentMessage[]) {
  return { messages };
}

function makeUserMsg(content: string): AgentMessage {
  return { role: "user", content, timestamp: Date.now() } as AgentMessage;
}

function makeMemoryResult(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return {
    id: overrides.id ?? "chunk-1",
    path: overrides.path ?? "memory/notes.md",
    startLine: overrides.startLine ?? 10,
    endLine: overrides.endLine ?? 20,
    score: overrides.score ?? 0.85,
    snippet: overrides.snippet ?? "Key information from memory.",
    source: overrides.source ?? "memory",
  };
}

function makeMemoryManager(results: MemorySearchResult[] = []) {
  return {
    search: async (_query: string) => results,
  };
}

function makeThrowingMemoryManager(error: Error) {
  return {
    search: async (_query: string): Promise<MemorySearchResult[]> => {
      throw error;
    },
  };
}

function makeAssistantMsg(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "fake",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/** Records each query passed to search(). */
function makeSpyMemoryManager(results: MemorySearchResult[] = []) {
  const queries: string[] = [];
  return {
    manager: {
      search: async (query: string) => {
        queries.push(query);
        return results;
      },
    },
    queries,
  };
}

/** makeCtx variant with no model (to test 200_000 fallback). */
function makeCtxNoModel(sessionManager: object): ExtensionContext {
  return {
    sessionManager,
    getSystemPrompt: () => "",
    model: undefined,
  } as unknown as ExtensionContext;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("dynamicContextExtension registration", () => {
  it("registers a handler for the 'context' event", () => {
    let registered = false;
    const api = {
      on(event: string) {
        if (event === "context") registered = true;
      },
    } as unknown as ExtensionAPI;
    dynamicContextExtension(api);
    expect(registered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No runtime → no-op
// ---------------------------------------------------------------------------

describe("no runtime", () => {
  it("returns undefined when no runtime is set for the session", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    // No setDynamicContextRuntime call — runtime absent
    const ctx = makeCtx(sessionManager);
    const result = await ext.callContext(makeEvent([makeUserMsg("hello")]), ctx);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Empty messages → no-op
// ---------------------------------------------------------------------------

describe("empty messages", () => {
  it("returns undefined when messages array is empty", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    setDynamicContextRuntime(sessionManager, { memoryManager: null });
    const ctx = makeCtx(sessionManager);
    const result = await ext.callContext(makeEvent([]), ctx);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// No memory manager → returns recent messages, no memory block
// ---------------------------------------------------------------------------

describe("no memory manager", () => {
  it("returns messages without <memory-context> when memoryManager is null", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    setDynamicContextRuntime(sessionManager, { memoryManager: null });
    const ctx = makeCtx(sessionManager);
    const messages = [makeUserMsg("tell me something")];
    const result = await ext.callContext(makeEvent(messages), ctx);
    expect(result).not.toBeUndefined();
    const content = result!.messages
      .map((m) =>
        typeof (m as { content?: unknown }).content === "string"
          ? (m as { content: string }).content
          : "",
      )
      .join("\n");
    expect(content).not.toContain("<memory-context>");
  });
});

// ---------------------------------------------------------------------------
// Memory search → <memory-context> block
// ---------------------------------------------------------------------------

describe("<memory-context> injection", () => {
  it("prepends <memory-context> block when memory results are found", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    const results = [makeMemoryResult({ snippet: "Alpha is the first letter." })];
    setDynamicContextRuntime(sessionManager, {
      memoryManager: makeMemoryManager(results) as never,
    });
    const ctx = makeCtx(sessionManager);
    const result = await ext.callContext(makeEvent([makeUserMsg("tell me about alpha")]), ctx);
    expect(result).not.toBeUndefined();
    const first = result!.messages[0];
    const content = (first as { content: string }).content;
    expect(content).toContain("<memory-context>");
    expect(content).toContain("</memory-context>");
  });

  it("format: [path:start-end] (score=X.XX)\\nsnippet", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    const results = [
      makeMemoryResult({
        path: "memory/notes.md",
        startLine: 5,
        endLine: 15,
        score: 0.92,
        snippet: "Important fact about the project.",
      }),
    ];
    setDynamicContextRuntime(sessionManager, {
      memoryManager: makeMemoryManager(results) as never,
    });
    const ctx = makeCtx(sessionManager);
    const result = await ext.callContext(makeEvent([makeUserMsg("query")]), ctx);
    const content = (result!.messages[0] as { content: string }).content;
    expect(content).toContain("[memory/notes.md:5-15] (score=0.92)");
    expect(content).toContain("Important fact about the project.");
  });

  it("separates multiple results with ---", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    const results = [
      makeMemoryResult({ id: "c1", path: "a.md", startLine: 1, endLine: 5, snippet: "First." }),
      makeMemoryResult({ id: "c2", path: "b.md", startLine: 10, endLine: 20, snippet: "Second." }),
    ];
    setDynamicContextRuntime(sessionManager, {
      memoryManager: makeMemoryManager(results) as never,
    });
    const ctx = makeCtx(sessionManager);
    const result = await ext.callContext(makeEvent([makeUserMsg("query")]), ctx);
    const content = (result!.messages[0] as { content: string }).content;
    expect(content).toContain("---");
    expect(content).toContain("First.");
    expect(content).toContain("Second.");
  });

  it("<memory-context> message is the first message in the result", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    setDynamicContextRuntime(sessionManager, {
      memoryManager: makeMemoryManager([makeMemoryResult()]) as never,
    });
    const ctx = makeCtx(sessionManager);
    const messages = [makeUserMsg("hello"), makeUserMsg("world")];
    const result = await ext.callContext(makeEvent(messages), ctx);
    const first = result!.messages[0];
    expect((first as { content: string }).content).toContain("<memory-context>");
  });

  it("includes → memory_get({chunkId}) when chunk has an id", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    const results = [makeMemoryResult({ id: "chunk-abc-123" })];
    setDynamicContextRuntime(sessionManager, {
      memoryManager: makeMemoryManager(results) as never,
    });
    const ctx = makeCtx(sessionManager);
    const result = await ext.callContext(makeEvent([makeUserMsg("query")]), ctx);
    const content = (result!.messages[0] as { content: string }).content;
    expect(content).toContain(`memory_get({"chunkId": "chunk-abc-123"})`);
  });

  it("falls back to → memory_get({path, from, lines}) when chunk has no id", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    const results = [
      { ...makeMemoryResult({ path: "notes.md", startLine: 5, endLine: 20 }), id: undefined },
    ];
    setDynamicContextRuntime(sessionManager, {
      memoryManager: makeMemoryManager(results as MemorySearchResult[]) as never,
    });
    const ctx = makeCtx(sessionManager);
    const result = await ext.callContext(makeEvent([makeUserMsg("query")]), ctx);
    const content = (result!.messages[0] as { content: string }).content;
    expect(content).toContain(`memory_get({"path": "notes.md", "from": 5, "lines": 15})`);
  });

  it("no <memory-context> block when memory search returns empty results", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    setDynamicContextRuntime(sessionManager, {
      memoryManager: makeMemoryManager([]) as never,
    });
    const ctx = makeCtx(sessionManager);
    const result = await ext.callContext(makeEvent([makeUserMsg("query")]), ctx);
    const content = result!.messages
      .map((m) =>
        typeof (m as { content?: unknown }).content === "string"
          ? (m as { content: string }).content
          : "",
      )
      .join("\n");
    expect(content).not.toContain("<memory-context>");
  });
});

// ---------------------------------------------------------------------------
// Error fallback
// ---------------------------------------------------------------------------

describe("error fallback", () => {
  it("returns messages (no context block) when memory search throws", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    setDynamicContextRuntime(sessionManager, {
      memoryManager: makeThrowingMemoryManager(new Error("DB locked")) as never,
    });
    const ctx = makeCtx(sessionManager);
    const result = await ext.callContext(makeEvent([makeUserMsg("query")]), ctx);
    // Should not throw; may return messages or undefined (error caught)
    if (result !== undefined) {
      const content = result.messages
        .map((m) =>
          typeof (m as { content?: unknown }).content === "string"
            ? (m as { content: string }).content
            : "",
        )
        .join("\n");
      expect(content).not.toContain("<memory-context>");
    }
  });

  it("does not propagate errors from the extension handler", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    setDynamicContextRuntime(sessionManager, {
      memoryManager: makeThrowingMemoryManager(new Error("fatal error")) as never,
    });
    const ctx = makeCtx(sessionManager);
    await expect(ext.callContext(makeEvent([makeUserMsg("query")]), ctx)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadContextParams fallback
// ---------------------------------------------------------------------------

describe("loadContextParams fallback", () => {
  it("works correctly when no evolver context_params file exists (uses defaults)", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    setDynamicContextRuntime(sessionManager, {
      memoryManager: makeMemoryManager([makeMemoryResult()]) as never,
    });
    const ctx = makeCtx(sessionManager, { contextWindow: 50_000 });
    // Should not throw even when the evolver file is absent
    const result = await ext.callContext(makeEvent([makeUserMsg("what is the project?")]), ctx);
    expect(result).not.toBeUndefined();
    expect(result!.messages.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Query extraction
// ---------------------------------------------------------------------------

describe("query extraction", () => {
  it("does not call memory search when no user message exists", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    const spy = makeSpyMemoryManager([makeMemoryResult()]);
    setDynamicContextRuntime(sessionManager, { memoryManager: spy.manager as never });
    const ctx = makeCtx(sessionManager);
    // Only assistant messages — no user message to extract query from
    const result = await ext.callContext(makeEvent([makeAssistantMsg("I am the assistant.")]), ctx);
    expect(spy.queries).toHaveLength(0);
    // No <memory-context> injected since no search was performed
    const content = result!.messages
      .map((m) =>
        typeof (m as { content?: unknown }).content === "string"
          ? (m as { content: string }).content
          : "",
      )
      .join("\n");
    expect(content).not.toContain("<memory-context>");
  });

  it("finds the most recent user message even when last message is assistant", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    const spy = makeSpyMemoryManager([makeMemoryResult()]);
    setDynamicContextRuntime(sessionManager, { memoryManager: spy.manager as never });
    const ctx = makeCtx(sessionManager);
    const messages = [makeUserMsg("earlier user message"), makeAssistantMsg("assistant reply")];
    await ext.callContext(makeEvent(messages), ctx);
    expect(spy.queries).toHaveLength(1);
    expect(spy.queries[0]).toBe("earlier user message");
  });

  it("truncates query to 500 characters", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    const spy = makeSpyMemoryManager([]);
    setDynamicContextRuntime(sessionManager, { memoryManager: spy.manager as never });
    const ctx = makeCtx(sessionManager);
    const longContent = "x".repeat(600);
    await ext.callContext(makeEvent([makeUserMsg(longContent)]), ctx);
    expect(spy.queries).toHaveLength(1);
    expect(spy.queries[0]).toHaveLength(500);
    expect(spy.queries[0]).toBe("x".repeat(500));
  });
});

// ---------------------------------------------------------------------------
// contextLimit priority
// ---------------------------------------------------------------------------

describe("contextLimit priority", () => {
  it("runtime.contextLimit overrides ctx.model.contextWindow", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    // runtime.contextLimit = 500 (very tight) — only 1 short message can fit
    // ctx.model.contextWindow = 100_000 (large) — would fit everything
    // If runtime.contextLimit is respected, most messages get trimmed
    setDynamicContextRuntime(sessionManager, {
      memoryManager: makeMemoryManager([]) as never,
      contextLimit: 500,
    });
    const ctx = makeCtx(sessionManager, { contextWindow: 100_000 });
    const manyMessages = Array.from({ length: 20 }, (_, i) =>
      makeUserMsg(`message ${i} with some content to consume tokens`),
    );
    const result = await ext.callContext(makeEvent(manyMessages), ctx);
    expect(result).not.toBeUndefined();
    // With contextLimit=500, very few messages fit — fewer than all 20
    expect(result!.messages.length).toBeLessThan(20);
  });

  it("falls back to 200_000 when neither runtime.contextLimit nor ctx.model is set", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    setDynamicContextRuntime(sessionManager, {
      memoryManager: makeMemoryManager([]) as never,
      // contextLimit not set
    });
    const ctx = makeCtxNoModel(sessionManager);
    // Should not throw — 200_000 fallback is used
    const result = await ext.callContext(makeEvent([makeUserMsg("hello")]), ctx);
    expect(result).not.toBeUndefined();
    expect(result!.messages.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Budget trimming (tight context window)
// ---------------------------------------------------------------------------

describe("budget trimming", () => {
  it("keeps only the most recent messages when context window is tight", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    // budget = 5100 * 0.8 - reserveForReply(4000) = 80 tokens total
    // recentBudget ≈ 40 tokens → fits ~3 of the 10 messages (~12 tokens each)
    setDynamicContextRuntime(sessionManager, {
      memoryManager: makeMemoryManager([]) as never,
      contextLimit: 5100,
    });
    const ctx = makeCtx(sessionManager, { contextWindow: 5100 });
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeUserMsg(`message number ${i} with enough content to use tokens`),
    );
    const result = await ext.callContext(makeEvent(messages), ctx);
    expect(result).not.toBeUndefined();
    // Should have fewer than all 10 messages
    expect(result!.messages.length).toBeLessThan(10);
    // The most recent message should be preserved
    const contents = result!.messages.map((m) =>
      typeof (m as { content?: unknown }).content === "string"
        ? (m as { content: string }).content
        : "",
    );
    expect(contents.some((c) => c.includes("message number 9"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deduplication: chunks matching recent message content are excluded
// ---------------------------------------------------------------------------

describe("deduplication", () => {
  it("excludes chunks whose snippet prefix matches a recent message's content prefix", async () => {
    const ext = buildExtension();
    const sessionManager = makeSessionManager();
    const sharedContent = "This exact sentence is already present in the conversation history.";
    const results = [
      makeMemoryResult({
        id: "duped-chunk",
        snippet: sharedContent,
        score: 0.9,
      }),
      makeMemoryResult({
        id: "unique-chunk",
        path: "other.md",
        startLine: 100,
        endLine: 110,
        snippet: "Completely different content not seen in messages.",
        score: 0.88,
      }),
    ];
    setDynamicContextRuntime(sessionManager, {
      memoryManager: makeMemoryManager(results) as never,
    });
    const ctx = makeCtx(sessionManager, { contextWindow: 100_000 });
    // User message whose content matches the first chunk's snippet
    const messages = [makeUserMsg(sharedContent)];
    const result = await ext.callContext(makeEvent(messages), ctx);
    expect(result).not.toBeUndefined();
    const memCtxMsg = result!.messages.find((m) => {
      const c = (m as { content?: unknown }).content;
      return typeof c === "string" && c.includes("<memory-context>");
    });
    // The unique chunk should be injected
    expect(memCtxMsg).not.toBeUndefined();
    const content = (memCtxMsg as { content: string }).content;
    expect(content).toContain("unique-chunk");
    expect(content).toContain("Completely different content not seen in messages.");
    // The duplicated chunk should be excluded
    expect(content).not.toContain("duped-chunk");
    expect(content).not.toContain(sharedContent);
  });
});
