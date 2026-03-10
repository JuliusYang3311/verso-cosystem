// src/orchestration/__tests__/task-dispatcher.test.ts — TaskDispatcher unit tests
//
// Covers: normal dispatch, dependency resolution, auto-fix creation,
// exhausted retry, deadlock prevention, cascading cancel via auto-fix

import { describe, it, expect } from "vitest";
import { TaskDispatcher } from "../task-dispatcher.js";
import { createSubtask, type Subtask } from "../types.js";

function makeTask(
  id: string,
  opts?: { dependsOn?: string[]; retryCount?: number; status?: Subtask["status"] },
): Subtask {
  return createSubtask({
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: [`${id} done`],
    specialization: "code-implementer",
    dependsOn: opts?.dependsOn,
    ...(opts?.retryCount != null ? {} : {}),
  }) as Subtask & { retryCount: number };
}

// Helper: override retryCount after creation (createSubtask always sets 0)
function withRetryCount(task: Subtask, count: number): Subtask {
  task.retryCount = count;
  return task;
}

describe("TaskDispatcher", () => {
  // -----------------------------------------------------------------------
  // Basic dispatch
  // -----------------------------------------------------------------------

  describe("basic dispatch", () => {
    it("returns all independent tasks immediately", async () => {
      const tasks = [makeTask("t1"), makeTask("t2"), makeTask("t3")];
      const dispatcher = new TaskDispatcher(tasks);

      const claimed: Subtask[] = [];
      for (let i = 0; i < 3; i++) {
        const t = await dispatcher.next();
        expect(t).not.toBeNull();
        claimed.push(t!);
      }

      expect(claimed.map((t) => t.id).sort()).toEqual(["t1", "t2", "t3"]);
      expect(claimed.every((t) => t.status === "running")).toBe(true);
    });

    it("returns null when all tasks done", async () => {
      const tasks = [makeTask("t1")];
      const dispatcher = new TaskDispatcher(tasks);

      const t = await dispatcher.next();
      expect(t).not.toBeNull();
      t!.status = "completed";
      dispatcher.onTaskDone();

      const t2 = await dispatcher.next();
      expect(t2).toBeNull();
    });

    it("returns null immediately when no tasks", async () => {
      const dispatcher = new TaskDispatcher([]);
      const t = await dispatcher.next();
      expect(t).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Dependency resolution
  // -----------------------------------------------------------------------

  describe("dependency resolution", () => {
    it("blocks dependent task until dependency completes", async () => {
      const tasks = [makeTask("t1"), makeTask("t2", { dependsOn: ["t1"] })];
      const dispatcher = new TaskDispatcher(tasks);

      // Only t1 is ready
      const t1 = await dispatcher.next();
      expect(t1!.id).toBe("t1");

      // t2 should not be immediately available — start a race
      let t2Resolved = false;
      const t2Promise = dispatcher.next().then((t) => {
        t2Resolved = true;
        return t;
      });

      // Give microtask queue a tick
      await new Promise((r) => setTimeout(r, 10));
      expect(t2Resolved).toBe(false);

      // Complete t1 → t2 should unblock
      t1!.status = "completed";
      dispatcher.onTaskDone();

      const t2 = await t2Promise;
      expect(t2).not.toBeNull();
      expect(t2!.id).toBe("t2");
    });

    it("handles diamond dependency (t3 depends on t1 and t2)", async () => {
      const tasks = [makeTask("t1"), makeTask("t2"), makeTask("t3", { dependsOn: ["t1", "t2"] })];
      const dispatcher = new TaskDispatcher(tasks);

      const t1 = await dispatcher.next();
      const t2 = await dispatcher.next();
      expect(t1!.id).toBe("t1");
      expect(t2!.id).toBe("t2");

      // Complete only t1 — t3 still blocked
      t1!.status = "completed";
      dispatcher.onTaskDone();

      let t3Resolved = false;
      const t3Promise = dispatcher.next().then((t) => {
        t3Resolved = true;
        return t;
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(t3Resolved).toBe(false);

      // Complete t2 → t3 unblocks
      t2!.status = "completed";
      dispatcher.onTaskDone();

      const t3 = await t3Promise;
      expect(t3!.id).toBe("t3");
    });
  });

  // -----------------------------------------------------------------------
  // Auto-fix on failure (deadlock prevention)
  // -----------------------------------------------------------------------

  describe("auto-fix on failure", () => {
    it("creates a fix task when a failed task blocks a dependent", async () => {
      const tasks = [makeTask("t1"), makeTask("t2", { dependsOn: ["t1"] })];
      const dispatcher = new TaskDispatcher(tasks);

      const t1 = await dispatcher.next();
      expect(t1!.id).toBe("t1");

      // Fail t1 → should auto-create fix task
      t1!.status = "failed";
      t1!.error = "build error";
      dispatcher.onTaskDone();

      expect(dispatcher.autoFixCount).toBe(1);
      expect(dispatcher.autoFixTasks[0].sourceSubtaskId).toBe("t1");

      // Original task should be cancelled (replaced by fix)
      expect(t1!.status).toBe("cancelled");

      // Fix task should be claimable
      const fixTask = await dispatcher.next();
      expect(fixTask).not.toBeNull();
      expect(fixTask!.id).toMatch(/^fix-auto-/);
      expect(fixTask!.title).toContain("Fix: Task t1");
      expect(fixTask!.retryCount).toBe(1);

      // Complete fix task → t2 should unblock (deps rewired)
      fixTask!.status = "completed";
      dispatcher.onTaskDone();

      const t2 = await dispatcher.next();
      expect(t2).not.toBeNull();
      expect(t2!.id).toBe("t2");
    });

    it("marks tasks as exhausted after MAX_AUTO_RETRIES", async () => {
      const tasks = [
        withRetryCount(makeTask("t1"), 2), // Already at limit
        makeTask("t2", { dependsOn: ["t1"] }),
      ];
      const dispatcher = new TaskDispatcher(tasks);

      const t1 = await dispatcher.next();
      t1!.status = "failed";
      t1!.error = "still broken";
      dispatcher.onTaskDone();

      // No auto-fix should be created
      expect(dispatcher.autoFixCount).toBe(0);

      // Task should be marked as exhausted
      expect(dispatcher.exhaustedTasks).toHaveLength(1);
      expect(dispatcher.exhaustedTasks[0].id).toBe("t1");
      expect(dispatcher.exhaustedTasks[0].retryCount).toBe(2);

      // t2 should be cancelled (blocked by exhausted dep)
      expect(tasks[1].status).toBe("cancelled");

      // Dispatcher should finish (no more work)
      const next = await dispatcher.next();
      expect(next).toBeNull();
    });

    it("cascade-cancels transitive dependents when exhausted", async () => {
      // t1(will exhaust) → t2(pending) → t3(pending)
      // When t1 exhausts, t2 gets cancelled. t3 must also be cancelled (depends on t2).
      const tasks = [
        withRetryCount(makeTask("t1"), 2),
        makeTask("t2", { dependsOn: ["t1"] }),
        makeTask("t3", { dependsOn: ["t2"] }),
      ];
      const dispatcher = new TaskDispatcher(tasks);

      const t1 = await dispatcher.next();
      t1!.status = "failed";
      t1!.error = "exhausted";
      dispatcher.onTaskDone();

      expect(dispatcher.exhaustedTasks).toHaveLength(1);
      expect(tasks[1].status).toBe("cancelled"); // t2 direct dependent
      expect(tasks[2].status).toBe("cancelled"); // t3 transitive dependent

      const next = await dispatcher.next();
      expect(next).toBeNull();
    });

    it("chains auto-fix → fail → second fix (retryCount increments)", async () => {
      const tasks = [makeTask("t1"), makeTask("t2", { dependsOn: ["t1"] })];
      const dispatcher = new TaskDispatcher(tasks);

      // First failure → auto-fix created (retryCount 0 → 1)
      const t1 = await dispatcher.next();
      t1!.status = "failed";
      t1!.error = "first error";
      dispatcher.onTaskDone();

      const fix1 = await dispatcher.next();
      expect(fix1!.retryCount).toBe(1);

      // Second failure → another auto-fix (retryCount 1 → 2 = MAX)
      fix1!.status = "failed";
      fix1!.error = "second error";
      dispatcher.onTaskDone();

      // retryCount 1 < MAX(2), so one more fix is created
      expect(dispatcher.autoFixCount).toBe(2);

      const fix2 = await dispatcher.next();
      expect(fix2!.retryCount).toBe(2);

      // Third failure → exhausted (retryCount 2 >= MAX)
      fix2!.status = "failed";
      fix2!.error = "third error";
      dispatcher.onTaskDone();

      expect(dispatcher.exhaustedTasks).toHaveLength(1);
      expect(tasks.find((t) => t.id === "t2")!.status).toBe("cancelled");

      // Dispatcher finishes
      const final = await dispatcher.next();
      expect(final).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent consumer loops
  // -----------------------------------------------------------------------

  describe("concurrent consumers", () => {
    it("multiple consumers share tasks correctly", async () => {
      const tasks = [makeTask("t1"), makeTask("t2"), makeTask("t3")];
      const dispatcher = new TaskDispatcher(tasks);

      const results: string[] = [];

      const loop = async () => {
        while (true) {
          const t = await dispatcher.next();
          if (!t) return;
          results.push(t.id);
          // Simulate work
          await new Promise((r) => setTimeout(r, 5));
          t.status = "completed";
          dispatcher.onTaskDone();
        }
      };

      await Promise.all([loop(), loop(), loop()]);

      expect(results.sort()).toEqual(["t1", "t2", "t3"]);
    });

    it("consumers wait and resume when dependent tasks complete", async () => {
      // t1 → t3, t2 → t3 (diamond)
      const tasks = [makeTask("t1"), makeTask("t2"), makeTask("t3", { dependsOn: ["t1", "t2"] })];
      const dispatcher = new TaskDispatcher(tasks);

      const results: string[] = [];

      const loop = async () => {
        while (true) {
          const t = await dispatcher.next();
          if (!t) return;
          results.push(t.id);
          await new Promise((r) => setTimeout(r, 5));
          t.status = "completed";
          dispatcher.onTaskDone();
        }
      };

      // 3 consumers, but t3 can't start until t1+t2 done
      await Promise.all([loop(), loop(), loop()]);

      expect(results).toHaveLength(3);
      expect(results).toContain("t3");
      // t3 must be last
      expect(results.indexOf("t3")).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("failed task with no dependents does not create fix", async () => {
      const tasks = [makeTask("t1"), makeTask("t2")]; // independent
      const dispatcher = new TaskDispatcher(tasks);

      const t1 = await dispatcher.next();
      const t2 = await dispatcher.next();

      t1!.status = "failed";
      dispatcher.onTaskDone();

      // No fix created — nobody depends on t1
      expect(dispatcher.autoFixCount).toBe(0);

      t2!.status = "completed";
      dispatcher.onTaskDone();

      const next = await dispatcher.next();
      expect(next).toBeNull();
    });

    it("mixed deps: T1 fails+auto-fixed, T2 succeeds, T5 waits for both", async () => {
      // T1(frontend) ──┐
      //                 ├→ T5(integration, depends on T1 + T2)
      // T2(backend)  ──┘
      //
      // T1 fails → auto-fix created → fix succeeds → T5 unblocks
      // T2 succeeds independently
      const tasks = [makeTask("t1"), makeTask("t2"), makeTask("t5", { dependsOn: ["t1", "t2"] })];
      const dispatcher = new TaskDispatcher(tasks);

      // Claim t1 and t2 in parallel
      const t1 = await dispatcher.next();
      const t2 = await dispatcher.next();
      expect(t1!.id).toBe("t1");
      expect(t2!.id).toBe("t2");

      // T2 completes successfully
      t2!.status = "completed";
      dispatcher.onTaskDone();

      // T1 fails → auto-fix created, t5 deps rewired to [fix-t1, t2]
      t1!.status = "failed";
      t1!.error = "frontend build error";
      dispatcher.onTaskDone();

      expect(dispatcher.autoFixCount).toBe(1);
      expect(t1!.status).toBe("cancelled"); // original replaced by fix

      // Fix task should be claimable
      const fixTask = await dispatcher.next();
      expect(fixTask).not.toBeNull();
      expect(fixTask!.title).toContain("Fix: Task t1");

      // t5 should NOT be ready yet (fix still running)
      // Verify by checking status — it's still pending
      expect(tasks[2].status).toBe("pending");

      // Fix succeeds → t5 should unblock (both deps now completed)
      fixTask!.status = "completed";
      dispatcher.onTaskDone();

      const t5 = await dispatcher.next();
      expect(t5).not.toBeNull();
      expect(t5!.id).toBe("t5");

      // Complete t5 → all done
      t5!.status = "completed";
      dispatcher.onTaskDone();

      const end = await dispatcher.next();
      expect(end).toBeNull();
    });

    it("mixed deps: T1 exhausted, T2 succeeds, T5 still cancelled", async () => {
      // Same diamond but T1 exhausts retries → T5 must be cancelled
      // even though T2 is fine (can't run T5 without T1's output)
      const tasks = [
        withRetryCount(makeTask("t1"), 2),
        makeTask("t2"),
        makeTask("t5", { dependsOn: ["t1", "t2"] }),
      ];
      const dispatcher = new TaskDispatcher(tasks);

      const t1 = await dispatcher.next();
      const t2 = await dispatcher.next();

      t2!.status = "completed";
      dispatcher.onTaskDone();

      t1!.status = "failed";
      t1!.error = "exhausted";
      dispatcher.onTaskDone();

      expect(dispatcher.exhaustedTasks).toHaveLength(1);
      // t5 cancelled — depends on exhausted t1
      expect(tasks[2].status).toBe("cancelled");

      const end = await dispatcher.next();
      expect(end).toBeNull();
    });

    it("already-completed dependency does not block", async () => {
      const tasks = [makeTask("t1"), makeTask("t2", { dependsOn: ["t1"] })];
      // Manually complete t1 before creating dispatcher
      tasks[0].status = "completed";
      tasks[0].completedAtMs = Date.now();

      const dispatcher = new TaskDispatcher(tasks);

      // t2 should be immediately ready (t1 already completed)
      const t2 = await dispatcher.next();
      expect(t2!.id).toBe("t2");
    });
  });
});
