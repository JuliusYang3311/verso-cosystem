// src/orchestration/__tests__/store.test.ts — Unit tests for orchestration store

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Orchestration } from "../types.js";
import {
  saveOrchestration,
  loadOrchestration,
  listOrchestrations,
  deleteOrchestration,
  createMissionWorkspace,
  cleanupMissionWorkspace,
} from "../store.js";

describe("Orchestration Store", () => {
  let testDir: string;
  let originalStoreDir: string | undefined;

  beforeEach(() => {
    // Create temporary test directory
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "verso-orch-test-"));
    originalStoreDir = process.env.VERSO_ORCHESTRATION_STORE_DIR;
    process.env.VERSO_ORCHESTRATION_STORE_DIR = testDir;
  });

  afterEach(() => {
    // Cleanup
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    if (originalStoreDir) {
      process.env.VERSO_ORCHESTRATION_STORE_DIR = originalStoreDir;
    } else {
      delete process.env.VERSO_ORCHESTRATION_STORE_DIR;
    }
  });

  describe("saveOrchestration and loadOrchestration", () => {
    it("should save and load orchestration", async () => {
      const orch: Orchestration = {
        id: "test-123",
        userPrompt: "Build a todo app",
        status: "planning",
        orchestratorSessionKey: "agent:main:orch:test-123",
        agentId: "main",
        workspaceDir: "/tmp/test",
        sourceWorkspaceDir: "/workspace",
        fixTasks: [],
        acceptanceResults: [],
        maxFixCycles: 3,
        currentFixCycle: 0,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      };

      await saveOrchestration(orch);
      const loaded = await loadOrchestration("test-123");

      expect(loaded).toBeDefined();
      expect(loaded?.id).toBe("test-123");
      expect(loaded?.userPrompt).toBe("Build a todo app");
      expect(loaded?.status).toBe("planning");
    });

    it("should return null for non-existent orchestration", async () => {
      const loaded = await loadOrchestration("non-existent");
      expect(loaded).toBeNull();
    });

    it("should update existing orchestration", async () => {
      const orch: Orchestration = {
        id: "test-456",
        userPrompt: "Test",
        status: "planning",
        orchestratorSessionKey: "agent:main:orch:test-456",
        agentId: "main",
        workspaceDir: "/tmp/test",
        sourceWorkspaceDir: "/workspace",
        fixTasks: [],
        acceptanceResults: [],
        maxFixCycles: 3,
        currentFixCycle: 0,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      };

      await saveOrchestration(orch);

      orch.status = "completed";
      orch.completedAtMs = Date.now();
      await saveOrchestration(orch);

      const loaded = await loadOrchestration("test-456");
      expect(loaded?.status).toBe("completed");
      expect(loaded?.completedAtMs).toBeDefined();
    });
  });

  describe("listOrchestrations", () => {
    it("should list all orchestrations", async () => {
      const orch1: Orchestration = {
        id: "test-1",
        userPrompt: "Task 1",
        status: "completed",
        orchestratorSessionKey: "agent:main:orch:test-1",
        agentId: "main",
        workspaceDir: "/tmp/test1",
        sourceWorkspaceDir: "/workspace",
        fixTasks: [],
        acceptanceResults: [],
        maxFixCycles: 3,
        currentFixCycle: 0,
        createdAtMs: Date.now() - 2000,
        updatedAtMs: Date.now() - 2000,
      };

      const orch2: Orchestration = {
        id: "test-2",
        userPrompt: "Task 2",
        status: "running",
        orchestratorSessionKey: "agent:main:orch:test-2",
        agentId: "main",
        workspaceDir: "/tmp/test2",
        sourceWorkspaceDir: "/workspace",
        fixTasks: [],
        acceptanceResults: [],
        maxFixCycles: 3,
        currentFixCycle: 0,
        createdAtMs: Date.now() - 1000,
        updatedAtMs: Date.now() - 1000,
      };

      await saveOrchestration(orch1);
      await saveOrchestration(orch2);

      const list = await listOrchestrations();
      expect(list.length).toBe(2);
      // Should be sorted by updatedAtMs descending
      expect(list[0].id).toBe("test-2");
      expect(list[1].id).toBe("test-1");
    });

    it("should return empty array when no orchestrations exist", async () => {
      const list = await listOrchestrations();
      expect(list).toEqual([]);
    });
  });

  describe("deleteOrchestration", () => {
    it("should delete orchestration", async () => {
      const orch: Orchestration = {
        id: "test-delete",
        userPrompt: "Delete me",
        status: "failed",
        orchestratorSessionKey: "agent:main:orch:test-delete",
        agentId: "main",
        workspaceDir: "/tmp/test",
        sourceWorkspaceDir: "/workspace",
        fixTasks: [],
        acceptanceResults: [],
        maxFixCycles: 3,
        currentFixCycle: 0,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      };

      await saveOrchestration(orch);
      expect(await loadOrchestration("test-delete")).toBeDefined();

      const deleted = await deleteOrchestration("test-delete");
      expect(deleted).toBe(true);
      expect(await loadOrchestration("test-delete")).toBeNull();
    });

    it("should return false for non-existent orchestration", async () => {
      const deleted = await deleteOrchestration("non-existent");
      expect(deleted).toBe(false);
    });
  });

  describe("Mission Workspace", () => {
    it("should create mission workspace", () => {
      const workspace = createMissionWorkspace(testDir, "test-mission");
      expect(workspace).toContain(".verso-missions");
      expect(workspace).toContain("test-mission");
      expect(fs.existsSync(workspace)).toBe(true);
    });

    it("should cleanup mission workspace", async () => {
      const workspace = createMissionWorkspace(testDir, "test-cleanup");
      expect(fs.existsSync(workspace)).toBe(true);

      await cleanupMissionWorkspace(testDir, "test-cleanup");
      expect(fs.existsSync(workspace)).toBe(false);
    });

    it("should handle cleanup of non-existent workspace gracefully", async () => {
      await expect(cleanupMissionWorkspace(testDir, "non-existent")).resolves.not.toThrow();
    });
  });
});
