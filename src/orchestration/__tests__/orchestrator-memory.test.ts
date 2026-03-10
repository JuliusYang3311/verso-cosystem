// src/orchestration/__tests__/orchestrator-memory.test.ts — Unit tests for memory management

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createOrchestrationMemoryDir,
  initOrchestrationMemory,
  cleanupOrchestrationMemory,
} from "../orchestrator-memory.js";

describe("Orchestrator Memory", () => {
  let testWorkspace: string;

  beforeEach(() => {
    testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "verso-mem-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  describe("createOrchestrationMemoryDir", () => {
    it("should create memory directory", () => {
      const memoryDir = createOrchestrationMemoryDir(testWorkspace, "test-orch-1");
      expect(fs.existsSync(memoryDir)).toBe(true);
      expect(memoryDir).toContain(".verso-missions");
      expect(memoryDir).toContain("test-orch-1");
      expect(memoryDir).toContain("memory");
    });

    it("should create nested directories", () => {
      const memoryDir = createOrchestrationMemoryDir(testWorkspace, "test-orch-2");
      const missionDir = path.join(testWorkspace, ".verso-missions", "test-orch-2");
      expect(fs.existsSync(missionDir)).toBe(true);
      expect(fs.existsSync(memoryDir)).toBe(true);
    });
  });

  describe("initOrchestrationMemory", () => {
    it("should initialize memory context with directory", async () => {
      const context = await initOrchestrationMemory({
        orchId: "test-init-1",
        sourceWorkspaceDir: testWorkspace,
        agentId: "main",
      });

      expect(context.memoryDir).toBeDefined();
      expect(fs.existsSync(context.memoryDir)).toBe(true);
      expect(context.memoryDir).toContain("test-init-1");

      // Cleanup
      if (context.memoryManager) {
        await context.memoryManager.close();
      }
    });

    it("should throw error for invalid workspace path", async () => {
      // Use invalid workspace to trigger error
      await expect(
        initOrchestrationMemory({
          orchId: "test-error",
          sourceWorkspaceDir: "/invalid/path/that/does/not/exist",
          agentId: "main",
        }),
      ).rejects.toThrow();
    });
  });

  describe("cleanupOrchestrationMemory", () => {
    it("should cleanup memory directory", async () => {
      const context = await initOrchestrationMemory({
        orchId: "test-cleanup-1",
        sourceWorkspaceDir: testWorkspace,
        agentId: "main",
      });

      expect(fs.existsSync(context.memoryDir)).toBe(true);

      await cleanupOrchestrationMemory(context);

      expect(fs.existsSync(context.memoryDir)).toBe(false);
    });

    it("should handle cleanup of non-existent directory", async () => {
      const context = {
        memoryDir: path.join(testWorkspace, "non-existent"),
        memoryManager: null,
      };

      await expect(cleanupOrchestrationMemory(context)).resolves.not.toThrow();
    });

    it("should close memory manager before cleanup", async () => {
      const context = await initOrchestrationMemory({
        orchId: "test-cleanup-2",
        sourceWorkspaceDir: testWorkspace,
        agentId: "main",
      });

      if (context.memoryManager) {
        // Memory manager should be open
        expect(context.memoryManager).toBeDefined();
      }

      await cleanupOrchestrationMemory(context);

      // Directory should be removed
      expect(fs.existsSync(context.memoryDir)).toBe(false);
    });
  });
});
