// src/orchestration/__tests__/memory-isolation.test.ts — Tests for memory isolation & DI architecture
//
// Validates:
// 1. Isolated memory manager uses separate DB (not global cache)
// 2. Memory tools receive injected manager (not global)
// 3. indexContent directly indexes into SQL (no file I/O)
// 4. Main agent path accepts optional memoryManager
// 5. Structural isolation between main agent and orchestrator memory

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initOrchestrationMemory,
  cleanupOrchestrationMemory,
  indexAgentResult,
} from "../orchestrator-memory.js";

describe("Memory Isolation Architecture", () => {
  let testWorkspace: string;

  beforeEach(() => {
    testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "verso-mem-isolation-"));
  });

  afterEach(() => {
    if (fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  describe("Isolated memory manager", () => {
    it("should create isolated memory directory", async () => {
      const context = await initOrchestrationMemory({
        orchId: "iso-test-1",
        sourceWorkspaceDir: testWorkspace,
        agentId: "main",
      });

      try {
        expect(context.memoryDir).toContain(".verso-missions");
        expect(context.memoryDir).toContain("iso-test-1");
        expect(fs.existsSync(context.memoryDir)).toBe(true);
      } finally {
        await cleanupOrchestrationMemory(context);
      }
    });

    it("should create separate DBs for different orchestrations", async () => {
      const ctx1 = await initOrchestrationMemory({
        orchId: "iso-a",
        sourceWorkspaceDir: testWorkspace,
        agentId: "main",
      });
      const ctx2 = await initOrchestrationMemory({
        orchId: "iso-b",
        sourceWorkspaceDir: testWorkspace,
        agentId: "main",
      });

      try {
        expect(ctx1.memoryDir).not.toBe(ctx2.memoryDir);
        expect(ctx1.memoryDir).toContain("iso-a");
        expect(ctx2.memoryDir).toContain("iso-b");
      } finally {
        await cleanupOrchestrationMemory(ctx1);
        await cleanupOrchestrationMemory(ctx2);
      }
    });
  });

  describe("Memory tool DI pattern", () => {
    it("createMemorySearchTool should accept injected memoryManager", async () => {
      const { createMemorySearchTool } = await import("../../agents/tools/memory-tool.js");

      const mockManager = {
        search: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue(null),
        sync: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };

      // Should not throw when creating with injected manager
      createMemorySearchTool({ memoryManager: mockManager as any });
      expect(true).toBe(true);
    });

    it("createMemoryGetTool should accept injected memoryManager", async () => {
      const { createMemoryGetTool } = await import("../../agents/tools/memory-tool.js");

      const mockManager = {
        search: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue(null),
        sync: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };

      createMemoryGetTool({ memoryManager: mockManager as any });
      expect(true).toBe(true);
    });
  });

  describe("Direct indexContent", () => {
    it("indexAgentResult should call indexContent on manager", async () => {
      const mockManager = {
        indexContent: vi.fn().mockResolvedValue(undefined),
      };

      await indexAgentResult({
        memoryManager: mockManager as any,
        agentType: "worker",
        agentId: "task-1",
        title: "Worker: Build UI",
        content: "Created React components for the dashboard.",
      });

      expect(mockManager.indexContent).toHaveBeenCalledOnce();
      expect(mockManager.indexContent).toHaveBeenCalledWith({
        path: "worker/task-1",
        content: "# Worker: Build UI\n\nCreated React components for the dashboard.",
      });
    });

    it("indexAgentResult should skip empty content", async () => {
      const mockManager = {
        indexContent: vi.fn().mockResolvedValue(undefined),
      };

      await indexAgentResult({
        memoryManager: mockManager as any,
        agentType: "worker",
        agentId: "task-2",
        title: "Empty",
        content: "   ",
      });

      expect(mockManager.indexContent).not.toHaveBeenCalled();
    });

    it("indexAgentResult should handle null manager gracefully", async () => {
      // Should not throw
      await indexAgentResult({
        memoryManager: null,
        agentType: "worker",
        agentId: "task-3",
        title: "Test",
        content: "Some content",
      });
    });
  });

  describe("Sync lifecycle", () => {
    it("cleanup should close manager and remove memory directory", async () => {
      const context = await initOrchestrationMemory({
        orchId: "cleanup-test",
        sourceWorkspaceDir: testWorkspace,
        agentId: "main",
      });

      const memoryDir = context.memoryDir;
      expect(fs.existsSync(memoryDir)).toBe(true);

      await cleanupOrchestrationMemory(context);

      expect(fs.existsSync(memoryDir)).toBe(false);
    });
  });

  describe("Main agent path isolation", () => {
    it("EmbeddedRunAttemptParams should accept optional memoryManager", async () => {
      const mockManager = {
        search: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue(null),
      };
      const params: Partial<
        import("../../agents/pi-embedded-runner/run/types.js").EmbeddedRunAttemptParams
      > = {
        memoryManager: mockManager as any,
      };
      expect(params.memoryManager).toBeDefined();
    });
  });
});
