/**
 * Tests for orchestrator-memory.ts
 *
 * Verifies:
 *   - createOrchestrationMemoryDir: directory created at expected path
 *   - indexAgentResult: no-op when manager/content absent; calls indexContent correctly
 *   - cleanupOrchestrationMemory: closes manager and removes directory
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupOrchestrationMemory,
  createOrchestrationMemoryDir,
  indexAgentResult,
} from "./orchestrator-memory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verso-orch-mem-test-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// createOrchestrationMemoryDir
// ---------------------------------------------------------------------------

describe("createOrchestrationMemoryDir", () => {
  it("creates directory at <workspace>/.verso-missions/<orchId>/memory/", () => {
    const orchId = "orch-001";
    const memDir = createOrchestrationMemoryDir(tmpDir, orchId);

    const expected = path.join(tmpDir, ".verso-missions", orchId, "memory");
    expect(memDir).toBe(expected);
    expect(fs.existsSync(memDir)).toBe(true);
    expect(fs.statSync(memDir).isDirectory()).toBe(true);
  });

  it("returns the same path if called twice (idempotent)", () => {
    const orchId = "orch-idempotent";
    const first = createOrchestrationMemoryDir(tmpDir, orchId);
    const second = createOrchestrationMemoryDir(tmpDir, orchId);
    expect(first).toBe(second);
    expect(fs.existsSync(second)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// indexAgentResult
// ---------------------------------------------------------------------------

describe("indexAgentResult", () => {
  it("is a no-op when memoryManager is null", async () => {
    // Should resolve without error
    await expect(
      indexAgentResult({
        memoryManager: null,
        agentType: "worker",
        agentId: "agent-1",
        title: "Task done",
        content: "Some result content.",
      }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when content is empty", async () => {
    const indexContent = vi.fn().mockResolvedValue(undefined);
    const manager = { indexContent } as never;

    await indexAgentResult({
      memoryManager: manager,
      agentType: "worker",
      agentId: "agent-1",
      title: "Empty result",
      content: "   ",
    });

    expect(indexContent).not.toHaveBeenCalled();
  });

  it("calls indexContent with path = <agentType>/<agentId> and formatted content", async () => {
    const indexContent = vi.fn().mockResolvedValue(undefined);
    const manager = { indexContent } as never;

    await indexAgentResult({
      memoryManager: manager,
      agentType: "orchestrator",
      agentId: "orch-abc",
      title: "Plan complete",
      content: "The orchestrator finished its planning phase.",
    });

    expect(indexContent).toHaveBeenCalledOnce();
    const [arg] = indexContent.mock.calls[0] as [{ path: string; content: string }];
    expect(arg.path).toBe("orchestrator/orch-abc");
    expect(arg.content).toContain("# Plan complete");
    expect(arg.content).toContain("The orchestrator finished its planning phase.");
  });

  it("does not throw when indexContent rejects (non-fatal)", async () => {
    const indexContent = vi.fn().mockRejectedValue(new Error("DB write failed"));
    const manager = { indexContent } as never;

    await expect(
      indexAgentResult({
        memoryManager: manager,
        agentType: "acceptance",
        agentId: "acc-1",
        title: "Acceptance check",
        content: "All acceptance criteria passed.",
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cleanupOrchestrationMemory
// ---------------------------------------------------------------------------

describe("cleanupOrchestrationMemory", () => {
  it("calls close() on the memory manager", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const manager = { close } as never;
    const memoryDir = createOrchestrationMemoryDir(tmpDir, "orch-cleanup-1");

    await cleanupOrchestrationMemory({ memoryDir, memoryManager: manager });

    expect(close).toHaveBeenCalledOnce();
  });

  it("removes the memory directory after cleanup", async () => {
    const memoryDir = createOrchestrationMemoryDir(tmpDir, "orch-cleanup-2");
    expect(fs.existsSync(memoryDir)).toBe(true);

    await cleanupOrchestrationMemory({ memoryDir, memoryManager: null });

    expect(fs.existsSync(memoryDir)).toBe(false);
  });

  it("handles null memoryManager gracefully (no close call)", async () => {
    const memoryDir = createOrchestrationMemoryDir(tmpDir, "orch-cleanup-3");

    // Should not throw even without a manager
    await expect(
      cleanupOrchestrationMemory({ memoryDir, memoryManager: null }),
    ).resolves.toBeUndefined();
  });

  it("throws if close() rejects (error is surfaced)", async () => {
    const close = vi.fn().mockRejectedValue(new Error("close failed"));
    const manager = { close } as never;
    const memoryDir = createOrchestrationMemoryDir(tmpDir, "orch-cleanup-4");

    await expect(cleanupOrchestrationMemory({ memoryDir, memoryManager: manager })).rejects.toThrow(
      "Cleanup errors",
    );
  });
});
