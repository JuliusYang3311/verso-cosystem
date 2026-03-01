// src/orchestration/__tests__/integration.test.ts — Integration tests for orchestration workflow

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Orchestration } from "../types.js";
import { initOrchestrationMemory, cleanupOrchestrationMemory } from "../orchestrator-memory.js";
import {
  saveOrchestration,
  loadOrchestration,
  deleteOrchestration,
  createMissionWorkspace,
  cleanupMissionWorkspace,
} from "../store.js";

describe("Orchestration Integration Tests", () => {
  let testWorkspace: string;
  let originalStoreDir: string | undefined;

  beforeEach(() => {
    testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "verso-integration-"));
    originalStoreDir = process.env.VERSO_ORCHESTRATION_STORE_DIR;
    process.env.VERSO_ORCHESTRATION_STORE_DIR = testWorkspace;
  });

  afterEach(() => {
    if (fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
    if (originalStoreDir) {
      process.env.VERSO_ORCHESTRATION_STORE_DIR = originalStoreDir;
    } else {
      delete process.env.VERSO_ORCHESTRATION_STORE_DIR;
    }
  });

  describe("Full Orchestration Lifecycle", () => {
    it("should complete full lifecycle: create → execute → cleanup", async () => {
      const orchId = "integration-test-1";

      // 1. Create orchestration record
      const orch: Orchestration = {
        id: orchId,
        userPrompt: "Build a simple Express API",
        status: "planning",
        orchestratorSessionKey: `agent:main:orch:${orchId}`,
        agentId: "main",
        workspaceDir: createMissionWorkspace(testWorkspace, orchId),
        sourceWorkspaceDir: testWorkspace,
        fixTasks: [],
        acceptanceResults: [],
        maxFixCycles: 3,
        currentFixCycle: 0,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      };

      await saveOrchestration(orch);
      expect(await loadOrchestration(orchId)).toBeDefined();

      // 2. Initialize memory
      const memoryContext = await initOrchestrationMemory({
        orchId,
        sourceWorkspaceDir: testWorkspace,
        agentId: "main",
      });

      expect(fs.existsSync(memoryContext.memoryDir)).toBe(true);
      expect(fs.existsSync(orch.workspaceDir)).toBe(true);

      // 3. Simulate task execution (update status)
      orch.status = "dispatching";
      orch.plan = {
        summary: "Create Express API with routes",
        subtasks: [
          {
            id: "t1",
            title: "Setup Express server",
            description: "Initialize Express app with basic middleware",
            acceptanceCriteria: ["Server starts on port 3000", "Health endpoint responds"],
            status: "pending",
            retryCount: 0,
            createdAtMs: Date.now(),
          },
          {
            id: "t2",
            title: "Create API routes",
            description: "Add CRUD routes for resources",
            acceptanceCriteria: ["GET /api/items returns 200", "POST /api/items creates item"],
            status: "pending",
            retryCount: 0,
            createdAtMs: Date.now(),
          },
        ],
      };
      await saveOrchestration(orch);

      // 4. Simulate worker execution
      orch.status = "running";
      if (orch.plan) {
        orch.plan.subtasks[0].status = "running";
        orch.plan.subtasks[0].startedAtMs = Date.now();
      }
      await saveOrchestration(orch);

      // 5. Complete tasks
      if (orch.plan) {
        orch.plan.subtasks[0].status = "completed";
        orch.plan.subtasks[0].completedAtMs = Date.now();
        orch.plan.subtasks[0].resultSummary = "Express server created successfully";

        orch.plan.subtasks[1].status = "completed";
        orch.plan.subtasks[1].completedAtMs = Date.now();
        orch.plan.subtasks[1].resultSummary = "API routes implemented";
      }

      // 6. Run acceptance
      orch.status = "acceptance";
      orch.acceptanceResults = [
        {
          passed: true,
          verdicts: [
            { subtaskId: "t1", passed: true, reason: "All criteria met" },
            { subtaskId: "t2", passed: true, reason: "All criteria met" },
          ],
          summary: "All acceptance criteria passed",
          testedAtMs: Date.now(),
        },
      ];
      await saveOrchestration(orch);

      // 7. Complete orchestration
      orch.status = "completed";
      orch.completedAtMs = Date.now();
      await saveOrchestration(orch);

      const completed = await loadOrchestration(orchId);
      expect(completed?.status).toBe("completed");
      expect(completed?.plan?.subtasks.every((t) => t.status === "completed")).toBe(true);

      // 8. Cleanup
      await cleanupOrchestrationMemory(memoryContext);
      await cleanupMissionWorkspace(testWorkspace, orchId);
      await deleteOrchestration(orchId);

      expect(fs.existsSync(memoryContext.memoryDir)).toBe(false);
      expect(fs.existsSync(orch.workspaceDir)).toBe(false);
      expect(await loadOrchestration(orchId)).toBeNull();
    });

    it("should handle failure with fix cycles", async () => {
      const orchId = "integration-test-2";

      const orch: Orchestration = {
        id: orchId,
        userPrompt: "Build a React component",
        status: "planning",
        orchestratorSessionKey: `agent:main:orch:${orchId}`,
        agentId: "main",
        workspaceDir: createMissionWorkspace(testWorkspace, orchId),
        sourceWorkspaceDir: testWorkspace,
        fixTasks: [],
        acceptanceResults: [],
        maxFixCycles: 3,
        currentFixCycle: 0,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      };

      await saveOrchestration(orch);

      // Create plan
      orch.plan = {
        summary: "Create React component",
        subtasks: [
          {
            id: "t1",
            title: "Create component",
            description: "Build React component with props",
            acceptanceCriteria: ["Component renders", "Props are typed"],
            status: "completed",
            retryCount: 0,
            createdAtMs: Date.now(),
            completedAtMs: Date.now(),
          },
        ],
      };

      // First acceptance fails
      orch.status = "acceptance";
      orch.acceptanceResults = [
        {
          passed: false,
          verdicts: [{ subtaskId: "t1", passed: false, reason: "TypeScript errors" }],
          summary: "Acceptance failed",
          testedAtMs: Date.now(),
        },
      ];
      await saveOrchestration(orch);

      // Create fix task
      orch.status = "fixing";
      orch.currentFixCycle = 1;
      orch.fixTasks = [
        {
          id: "fix-c1-1",
          sourceSubtaskId: "t1",
          description: "Fix TypeScript errors in component",
          status: "completed",
          createdAtMs: Date.now(),
          completedAtMs: Date.now(),
        },
      ];
      await saveOrchestration(orch);

      // Second acceptance passes
      orch.status = "acceptance";
      orch.acceptanceResults.push({
        passed: true,
        verdicts: [{ subtaskId: "t1", passed: true, reason: "All criteria met" }],
        summary: "Acceptance passed after fix",
        testedAtMs: Date.now(),
      });
      await saveOrchestration(orch);

      // Complete
      orch.status = "completed";
      orch.completedAtMs = Date.now();
      await saveOrchestration(orch);

      const completed = await loadOrchestration(orchId);
      expect(completed?.status).toBe("completed");
      expect(completed?.currentFixCycle).toBe(1);
      expect(completed?.fixTasks.length).toBe(1);

      // Cleanup
      await cleanupMissionWorkspace(testWorkspace, orchId);
      await deleteOrchestration(orchId);
    });

    it("should handle max fix cycles exceeded", async () => {
      const orchId = "integration-test-3";

      const orch: Orchestration = {
        id: orchId,
        userPrompt: "Build buggy code",
        status: "planning",
        orchestratorSessionKey: `agent:main:orch:${orchId}`,
        agentId: "main",
        workspaceDir: createMissionWorkspace(testWorkspace, orchId),
        sourceWorkspaceDir: testWorkspace,
        fixTasks: [],
        acceptanceResults: [],
        maxFixCycles: 3,
        currentFixCycle: 0,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      };

      await saveOrchestration(orch);

      // Simulate 3 failed fix cycles
      for (let cycle = 1; cycle <= 3; cycle++) {
        orch.currentFixCycle = cycle;
        orch.status = "fixing";
        orch.fixTasks.push({
          id: `fix-c${cycle}-1`,
          sourceSubtaskId: "t1",
          description: `Fix attempt ${cycle}`,
          status: "completed",
          createdAtMs: Date.now(),
          completedAtMs: Date.now(),
        });

        orch.acceptanceResults.push({
          passed: false,
          verdicts: [{ subtaskId: "t1", passed: false, reason: "Still failing" }],
          summary: `Cycle ${cycle} failed`,
          testedAtMs: Date.now(),
        });

        await saveOrchestration(orch);
      }

      // Max cycles exceeded, mark as failed
      orch.status = "failed";
      orch.error = "Max fix cycles (3) exceeded";
      orch.completedAtMs = Date.now();
      await saveOrchestration(orch);

      const failed = await loadOrchestration(orchId);
      expect(failed?.status).toBe("failed");
      expect(failed?.currentFixCycle).toBe(3);
      expect(failed?.error).toContain("Max fix cycles");

      // Cleanup
      await cleanupMissionWorkspace(testWorkspace, orchId);
      await deleteOrchestration(orchId);
    });
  });

  describe("Memory Isolation", () => {
    it("should isolate memory between orchestrations", async () => {
      const orch1Id = "mem-test-1";
      const orch2Id = "mem-test-2";

      const mem1 = await initOrchestrationMemory({
        orchId: orch1Id,
        sourceWorkspaceDir: testWorkspace,
        agentId: "main",
      });

      const mem2 = await initOrchestrationMemory({
        orchId: orch2Id,
        sourceWorkspaceDir: testWorkspace,
        agentId: "main",
      });

      // Different memory directories
      expect(mem1.memoryDir).not.toBe(mem2.memoryDir);
      expect(fs.existsSync(mem1.memoryDir)).toBe(true);
      expect(fs.existsSync(mem2.memoryDir)).toBe(true);

      // Cleanup one should not affect the other
      await cleanupOrchestrationMemory(mem1);
      expect(fs.existsSync(mem1.memoryDir)).toBe(false);
      expect(fs.existsSync(mem2.memoryDir)).toBe(true);

      await cleanupOrchestrationMemory(mem2);
      expect(fs.existsSync(mem2.memoryDir)).toBe(false);
    });
  });
});
