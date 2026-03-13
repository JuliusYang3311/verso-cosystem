// src/orchestration/worker-runner.test.ts — Tests for extractToolMetas()

import { describe, it, expect } from "vitest";
import { extractToolMetas } from "./worker-runner.js";

describe("extractToolMetas", () => {
  it("returns empty array for null/undefined session", () => {
    expect(extractToolMetas(null)).toEqual([]);
    expect(extractToolMetas(undefined)).toEqual([]);
    expect(extractToolMetas({})).toEqual([]);
  });

  it("returns empty array when no messages", () => {
    expect(extractToolMetas({ messages: [] })).toEqual([]);
  });

  it("ignores user messages", () => {
    const session = {
      messages: [
        {
          role: "user",
          content: [{ type: "tool_use", name: "memory_get", input: { chunkId: "c1" } }],
        },
      ],
    };
    expect(extractToolMetas(session)).toEqual([]);
  });

  it("extracts memory_get tool calls from assistant messages", () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me look that up." },
            { type: "tool_use", name: "memory_get", input: { chunkId: "chunk-42" } },
          ],
        },
      ],
    };
    const result = extractToolMetas(session);
    expect(result).toEqual([{ toolName: "memory_get", meta: '{"chunkId":"chunk-42"}' }]);
  });

  it("extracts memory_search tool calls", () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", name: "memory_search", input: { query: "auth flow" } }],
        },
      ],
    };
    const result = extractToolMetas(session);
    expect(result).toEqual([{ toolName: "memory_search", meta: '{"query":"auth flow"}' }]);
  });

  it("ignores non-memory tool calls (bash, read, etc.)", () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", name: "bash", input: { command: "ls" } },
            { type: "tool_use", name: "read", input: { path: "/foo" } },
            { type: "tool_use", name: "memory_get", input: { chunkId: "c1" } },
          ],
        },
      ],
    };
    const result = extractToolMetas(session);
    expect(result).toHaveLength(1);
    expect(result[0].toolName).toBe("memory_get");
  });

  it("handles multiple messages with multiple tool calls", () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", name: "memory_get", input: { chunkId: "c1" } },
            { type: "tool_use", name: "memory_search", input: { query: "q1" } },
          ],
        },
        { role: "user", content: "thanks" },
        {
          role: "assistant",
          content: [{ type: "tool_use", name: "memory_get", input: { chunkId: "c2" } }],
        },
      ],
    };
    const result = extractToolMetas(session);
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.toolName)).toEqual(["memory_get", "memory_search", "memory_get"]);
  });

  it("handles content blocks with missing/null fields gracefully", () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: [
            null,
            { type: "tool_use", name: "", input: {} },
            { type: "tool_use" }, // missing name
            { type: "text", text: "hello" },
            { type: "tool_use", name: "memory_get", input: null },
          ],
        },
      ],
    };
    const result = extractToolMetas(session);
    // Only the last one has a valid tool name "memory_get"
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ toolName: "memory_get", meta: undefined });
  });

  it("handles string content (non-array) gracefully", () => {
    const session = {
      messages: [{ role: "assistant", content: "Just text, no tool calls" }],
    };
    expect(extractToolMetas(session)).toEqual([]);
  });

  it("handles circular/non-serializable input gracefully", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const session = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", name: "memory_get", input: circular }],
        },
      ],
    };
    // Should not throw, meta will be undefined due to JSON.stringify failure
    const result = extractToolMetas(session);
    expect(result).toHaveLength(1);
    expect(result[0].toolName).toBe("memory_get");
    // meta is undefined because JSON.stringify threw
    expect(result[0].meta).toBeUndefined();
  });
});
