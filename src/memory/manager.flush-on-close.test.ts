/**
 * Tests for flush-on-close behavior of MemoryIndexManager.
 *
 * Verifies that session turns buffered below the delta threshold are flushed
 * to the SQLite index when close() is called, rather than being silently lost.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

vi.mock("chokidar", () => ({
  default: {
    watch: vi.fn(() => ({
      on: vi.fn(),
      close: vi.fn(async () => undefined),
    })),
  },
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      embedQuery: async () => Array.from({ length: 8 }, () => 0.1),
      embedBatch: async (texts: string[]) => texts.map(() => Array.from({ length: 8 }, () => 0.1)),
    },
  }),
}));

function makeConfig(workspaceDir: string, indexPath: string) {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "mock-embed",
          store: { path: indexPath },
          sync: {
            watch: false,
            onSessionStart: false,
            onSearch: false,
            // High thresholds — turns will NOT flush mid-session in these tests.
            sessions: { deltaBytes: 100_000, deltaMessages: 50 },
          },
        },
      },
      list: [{ id: "main", default: true }],
    },
  };
}

describe("MemoryIndexManager flush-on-close", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "verso-flush-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
  });

  afterEach(async () => {
    // Manager may already be closed by the test; ignore double-close errors.
    try {
      await manager?.close();
    } catch {
      // already closed
    }
    manager = null;
    await fs.rm(workspaceDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("flushes buffered session turns to the index on close()", async () => {
    const cfg = makeConfig(workspaceDir, indexPath);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    manager = result.manager!;

    // Add a turn — below the 50-message threshold, so buffer is NOT flushed yet.
    await manager.indexSessionTurn({
      sessionId: "session-abc",
      userText: "What is the capital of France?",
      assistantText: "The capital of France is Paris.",
    });

    // Spy on indexContent to verify it is called during close().
    const indexContentSpy = vi.spyOn(manager, "indexContent");

    // close() should drain the buffer.
    await manager.close();

    expect(indexContentSpy).toHaveBeenCalledOnce();
    const [call] = indexContentSpy.mock.calls;
    expect(call?.[0].path).toBe("sessions/session-abc");
    expect(call?.[0].content).toContain("Paris");
    expect(call?.[0].source).toBe("sessions");
  });

  it("flushes multiple independent session buffers on close()", async () => {
    const cfg = makeConfig(workspaceDir, indexPath);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    manager = result.manager!;

    await manager.indexSessionTurn({ sessionId: "s1", userText: "hello", assistantText: "hi" });
    await manager.indexSessionTurn({ sessionId: "s2", userText: "foo", assistantText: "bar" });

    const indexContentSpy = vi.spyOn(manager, "indexContent");
    await manager.close();

    expect(indexContentSpy).toHaveBeenCalledTimes(2);
    const paths = indexContentSpy.mock.calls.map((c) => c[0].path);
    expect(paths).toContain("sessions/s1");
    expect(paths).toContain("sessions/s2");
  });

  it("does nothing on close() when buffer is empty", async () => {
    const cfg = makeConfig(workspaceDir, indexPath);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    manager = result.manager!;

    // No indexSessionTurn calls — buffer is empty.
    const indexContentSpy = vi.spyOn(manager, "indexContent");
    await manager.close();

    expect(indexContentSpy).not.toHaveBeenCalled();
  });

  it("does not flush already-flushed sessions (threshold hit mid-session)", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            sync: {
              watch: false,
              onSessionStart: false,
              onSearch: false,
              // Very low threshold — flush after 1 message.
              sessions: { deltaBytes: 1, deltaMessages: 1 },
            },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    manager = result.manager!;

    // This turn hits the threshold immediately and flushes the buffer.
    await manager.indexSessionTurn({ sessionId: "s-eager", userText: "a", assistantText: "b" });

    // At this point the buffer for "s-eager" is already cleared.
    const indexContentSpy = vi.spyOn(manager, "indexContent");
    await manager.close();

    // close() should NOT re-flush an already-flushed session.
    expect(indexContentSpy).not.toHaveBeenCalled();
  });
});
