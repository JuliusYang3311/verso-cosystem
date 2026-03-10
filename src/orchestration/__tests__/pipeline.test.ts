// src/orchestration/__tests__/pipeline.test.ts — End-to-end pipeline tests
//
// Tests the orchestration pipeline logic: dependency resolution, revise-plan
// operations (cancel cascade, add subtasks, rewire deps), and isSubtaskReady.
// These are pure unit tests — no I/O, no sessions.

import { describe, it, expect } from "vitest";
import { createSubtask, isSubtaskReady, createOrchestration, type Subtask } from "../types.js";

function makeTask(
  id: string,
  spec: Subtask["specialization"] = "code-implementer",
  dependsOn?: string[],
): Subtask {
  return createSubtask({
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: [`${id} done`],
    specialization: spec,
    dependsOn,
  });
}

// -----------------------------------------------------------------------
// isSubtaskReady
// -----------------------------------------------------------------------

describe("isSubtaskReady", () => {
  it("returns true for pending task with no dependencies", () => {
    const tasks = [makeTask("t1")];
    expect(isSubtaskReady(tasks[0], tasks)).toBe(true);
  });

  it("returns false for non-pending task", () => {
    const tasks = [makeTask("t1")];
    tasks[0].status = "running";
    expect(isSubtaskReady(tasks[0], tasks)).toBe(false);
  });

  it("returns false when dependency is pending", () => {
    const tasks = [makeTask("t1"), makeTask("t2", "code-implementer", ["t1"])];
    expect(isSubtaskReady(tasks[1], tasks)).toBe(false);
  });

  it("returns false when dependency is running", () => {
    const tasks = [makeTask("t1"), makeTask("t2", "code-implementer", ["t1"])];
    tasks[0].status = "running";
    expect(isSubtaskReady(tasks[1], tasks)).toBe(false);
  });

  it("returns true when dependency is completed", () => {
    const tasks = [makeTask("t1"), makeTask("t2", "code-implementer", ["t1"])];
    tasks[0].status = "completed";
    expect(isSubtaskReady(tasks[1], tasks)).toBe(true);
  });

  it("returns false when dependency is failed", () => {
    const tasks = [makeTask("t1"), makeTask("t2", "code-implementer", ["t1"])];
    tasks[0].status = "failed";
    expect(isSubtaskReady(tasks[1], tasks)).toBe(false);
  });

  it("requires ALL dependencies completed", () => {
    const tasks = [
      makeTask("t1"),
      makeTask("t2"),
      makeTask("t3", "code-implementer", ["t1", "t2"]),
    ];
    tasks[0].status = "completed";
    // t2 still pending
    expect(isSubtaskReady(tasks[2], tasks)).toBe(false);

    tasks[1].status = "completed";
    expect(isSubtaskReady(tasks[2], tasks)).toBe(true);
  });

  it("returns false when dependency ID references non-existent task", () => {
    const tasks = [makeTask("t1", "code-implementer", ["nonexistent"])];
    expect(isSubtaskReady(tasks[0], tasks)).toBe(false);
  });
});

// -----------------------------------------------------------------------
// revise-plan operations (simulated — same logic as handleRevisePlan)
// -----------------------------------------------------------------------

describe("revise-plan operations", () => {
  // Simulate the cancel-cascade logic from handleRevisePlan
  function cancelCascade(tasks: Subtask[], cancelIds: string[]): number {
    const toCancel = new Set(cancelIds);

    // Cascade through pending AND failed nodes (match orchestrator-tools.ts)
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of tasks) {
        if ((s.status === "pending" || s.status === "failed") && !toCancel.has(s.id)) {
          const blocked = s.dependsOn?.some((depId) => toCancel.has(depId));
          if (blocked) {
            toCancel.add(s.id);
            changed = true;
          }
        }
      }
    }

    let count = 0;
    for (const s of tasks) {
      if (toCancel.has(s.id) && (s.status === "pending" || s.status === "failed")) {
        s.status = "cancelled";
        count++;
      }
    }
    return count;
  }

  describe("cancel cascade", () => {
    it("cancels a single task", () => {
      const tasks = [makeTask("t1"), makeTask("t2")];
      const count = cancelCascade(tasks, ["t1"]);
      expect(count).toBe(1);
      expect(tasks[0].status).toBe("cancelled");
      expect(tasks[1].status).toBe("pending");
    });

    it("cascades to blocked dependents", () => {
      // t1 → t2 → t3
      const tasks = [
        makeTask("t1"),
        makeTask("t2", "code-implementer", ["t1"]),
        makeTask("t3", "code-implementer", ["t2"]),
      ];
      const count = cancelCascade(tasks, ["t1"]);
      expect(count).toBe(3);
      expect(tasks.every((t) => t.status === "cancelled")).toBe(true);
    });

    it("does not cascade through completed tasks", () => {
      // t1 → t2 (completed) → t3
      const tasks = [
        makeTask("t1"),
        makeTask("t2", "code-implementer", ["t1"]),
        makeTask("t3", "code-implementer", ["t2"]),
      ];
      tasks[1].status = "completed"; // t2 already done

      const count = cancelCascade(tasks, ["t1"]);
      // Only t1 cancelled — t2 completed (not cancellable), t3 depends on t2 (completed) not on cancelled set
      expect(count).toBe(1);
      expect(tasks[0].status).toBe("cancelled");
      expect(tasks[1].status).toBe("completed");
      expect(tasks[2].status).toBe("pending");
    });

    it("does not cancel running tasks", () => {
      const tasks = [makeTask("t1")];
      tasks[0].status = "running";
      const count = cancelCascade(tasks, ["t1"]);
      expect(count).toBe(0); // running tasks can't be cancelled
    });

    it("cancels failed tasks (they can be cancelled by revise-plan)", () => {
      const tasks = [makeTask("t1")];
      tasks[0].status = "failed";
      const count = cancelCascade(tasks, ["t1"]);
      expect(count).toBe(1);
      expect(tasks[0].status).toBe("cancelled");
    });

    it("cascades through failed intermediate nodes to reach pending tasks", () => {
      // t1(failed, exhausted) → t2(failed) → t3(pending)
      // Cancel t1 must propagate through t2(failed) to reach t3(pending)
      const tasks = [
        makeTask("t1"),
        makeTask("t2", "code-implementer", ["t1"]),
        makeTask("t3", "code-implementer", ["t2"]),
      ];
      tasks[0].status = "failed";
      tasks[0].retryCount = 2;
      tasks[1].status = "failed";

      const count = cancelCascade(tasks, ["t1"]);
      expect(count).toBe(3); // t1(failed) + t2(failed) + t3(pending)
      expect(tasks[0].status).toBe("cancelled");
      expect(tasks[1].status).toBe("cancelled");
      expect(tasks[2].status).toBe("cancelled");
    });

    it("handles diamond cascade correctly", () => {
      // t1 → t3, t2 → t3 (diamond), cancel t1 only
      const tasks = [
        makeTask("t1"),
        makeTask("t2"),
        makeTask("t3", "code-implementer", ["t1", "t2"]),
      ];

      const count = cancelCascade(tasks, ["t1"]);
      // t3 depends on t1 (cancelled) → cascaded
      expect(count).toBe(2); // t1 + t3
      expect(tasks[0].status).toBe("cancelled");
      expect(tasks[1].status).toBe("pending");
      expect(tasks[2].status).toBe("cancelled");
    });
  });

  describe("add subtasks", () => {
    it("creates revision tasks with r-prefixed IDs", () => {
      const tasks: Subtask[] = [makeTask("t1"), makeTask("t2")];

      // Simulate addSubtasks from handleRevisePlan
      const existingRevisionIds = tasks
        .filter((s) => s.id.startsWith("r"))
        .map((s) => parseInt(s.id.slice(1), 10))
        .filter((n) => !isNaN(n));
      let counter = existingRevisionIds.length > 0 ? Math.max(...existingRevisionIds) + 1 : 1;

      const newTask = createSubtask({
        id: `r${counter++}`,
        title: "Replace t1",
        description: "Replacement approach",
        acceptanceCriteria: ["works"],
        specialization: "code-architect",
        dependsOn: undefined,
      });
      tasks.push(newTask);

      expect(newTask.id).toBe("r1");
      expect(newTask.specialization).toBe("code-architect");
    });

    it("increments r-counter past existing revision tasks", () => {
      const tasks: Subtask[] = [
        makeTask("t1"),
        createSubtask({
          id: "r1",
          title: "Rev 1",
          description: "",
          acceptanceCriteria: [],
          specialization: "generic",
        }),
        createSubtask({
          id: "r2",
          title: "Rev 2",
          description: "",
          acceptanceCriteria: [],
          specialization: "generic",
        }),
      ];

      const existingRevisionIds = tasks
        .filter((s) => s.id.startsWith("r"))
        .map((s) => parseInt(s.id.slice(1), 10))
        .filter((n) => !isNaN(n));
      const counter = existingRevisionIds.length > 0 ? Math.max(...existingRevisionIds) + 1 : 1;

      expect(counter).toBe(3); // r3 next
    });
  });

  describe("rewire dependencies", () => {
    it("replaces old dependency with new one", () => {
      const tasks = [makeTask("t1"), makeTask("t2", "code-implementer", ["t1"])];

      // Simulate rewire: t2 depends on r1 instead of t1
      const task = tasks.find((s) => s.id === "t2")!;
      const idx = task.dependsOn!.indexOf("t1");
      task.dependsOn![idx] = "r1";

      expect(task.dependsOn).toEqual(["r1"]);
    });

    it("combined cancel + add + rewire flow", () => {
      // Full revise-plan scenario:
      // Original: t1 → t2 → t3
      // t1 exhausted → cancel t1, add r1 as replacement, rewire t2 to depend on r1
      const tasks: Subtask[] = [
        makeTask("t1"),
        makeTask("t2", "code-implementer", ["t1"]),
        makeTask("t3", "code-implementer", ["t2"]),
      ];
      tasks[0].status = "failed";
      tasks[0].retryCount = 2;

      // Step 1: Cancel t1 (+ cascade t2, t3)
      const cancelled = cancelCascade(tasks, ["t1"]);
      expect(cancelled).toBe(3);

      // Step 2: Add r1 (replacement for t1)
      const r1 = createSubtask({
        id: "r1",
        title: "Replace t1",
        description: "Different approach",
        acceptanceCriteria: ["works"],
        specialization: "code-implementer",
      });
      tasks.push(r1);

      // Step 3: Add r2 (replacement for t2, depends on r1)
      const r2 = createSubtask({
        id: "r2",
        title: "Replace t2",
        description: "Depends on r1",
        acceptanceCriteria: ["works"],
        specialization: "code-implementer",
        dependsOn: ["r1"],
      });
      tasks.push(r2);

      // Step 4: Add r3 (replacement for t3, depends on r2)
      const r3 = createSubtask({
        id: "r3",
        title: "Replace t3",
        description: "Depends on r2",
        acceptanceCriteria: ["works"],
        specialization: "code-reviewer",
        dependsOn: ["r2"],
      });
      tasks.push(r3);

      // Verify state
      expect(tasks.filter((t) => t.status === "cancelled")).toHaveLength(3);
      expect(tasks.filter((t) => t.status === "pending")).toHaveLength(3);
      expect(isSubtaskReady(r1, tasks)).toBe(true);
      expect(isSubtaskReady(r2, tasks)).toBe(false);
      expect(isSubtaskReady(r3, tasks)).toBe(false);

      // Complete r1 → r2 becomes ready
      r1.status = "completed";
      expect(isSubtaskReady(r2, tasks)).toBe(true);
      expect(isSubtaskReady(r3, tasks)).toBe(false);

      // Complete r2 → r3 becomes ready
      r2.status = "completed";
      expect(isSubtaskReady(r3, tasks)).toBe(true);
    });

    it("diamond revise-plan: cancel T1 + cascaded T5, add r1 + r2, T2 reused", () => {
      // Original DAG:
      //   T1(frontend) ──┐
      //                   ├→ T5(integration, depends on T1 + T2)
      //   T2(backend)  ──┘
      //
      // T1 exhausted → revise-plan:
      //   cancelTaskIds: ["T1"]  → T1 cancelled, T5 cascaded (depends on cancelled T1)
      //   addSubtasks: [r1 (replace T1), r2 (replace T5, dependsOn: [r1, T2])]
      //   T2 already completed — reused by r2
      const tasks: Subtask[] = [
        makeTask("T1", "code-implementer"),
        makeTask("T2", "code-implementer"),
        makeTask("T5", "code-implementer", ["T1", "T2"]),
      ];
      tasks[0].status = "failed";
      tasks[0].retryCount = 2; // exhausted
      tasks[1].status = "completed"; // T2 succeeded

      // Step 1: Cancel T1 → T5 cascaded (depends on cancelled T1)
      const cancelled = cancelCascade(tasks, ["T1"]);
      expect(cancelled).toBe(2); // T1 + T5
      expect(tasks[0].status).toBe("cancelled"); // T1
      expect(tasks[1].status).toBe("completed"); // T2 untouched
      expect(tasks[2].status).toBe("cancelled"); // T5 cascaded

      // Step 2: Add r1 (new frontend approach) and r2 (new integration, depends on r1 + T2)
      const r1 = createSubtask({
        id: "r1",
        title: "New frontend approach",
        description: "Replace T1 with different strategy",
        acceptanceCriteria: ["frontend works"],
        specialization: "code-implementer",
      });
      tasks.push(r1);

      const r2 = createSubtask({
        id: "r2",
        title: "New integration",
        description: "Replace T5, reuses T2 backend",
        acceptanceCriteria: ["integration works"],
        specialization: "code-implementer",
        dependsOn: ["r1", "T2"],
      });
      tasks.push(r2);

      // Verify: r1 ready (no deps), r2 blocked on r1 (T2 already completed)
      expect(isSubtaskReady(r1, tasks)).toBe(true);
      expect(isSubtaskReady(r2, tasks)).toBe(false);

      // Complete r1 → r2 should unblock (r1 completed + T2 already completed)
      r1.status = "completed";
      expect(isSubtaskReady(r2, tasks)).toBe(true);

      // Complete r2 → all done
      r2.status = "completed";
      const allDone = tasks.every((t) => t.status === "completed" || t.status === "cancelled");
      expect(allDone).toBe(true);
    });
  });
});

// -----------------------------------------------------------------------
// Orchestration lifecycle
// -----------------------------------------------------------------------

describe("Orchestration lifecycle", () => {
  it("creates orchestration in planning state", () => {
    const orch = createOrchestration({
      id: "test-1",
      userPrompt: "Build something",
      orchestratorSessionKey: "sk-1",
      agentId: "agent-1",
      workspaceDir: "/tmp/ws",
      sourceWorkspaceDir: "/tmp/src",
    });

    expect(orch.status).toBe("planning");
    expect(orch.currentFixCycle).toBe(0);
    expect(orch.fixTasks).toEqual([]);
    expect(orch.acceptanceResults).toEqual([]);
    expect(orch.plan).toBeUndefined();
  });

  it("respects maxFixCycles from params", () => {
    const orch = createOrchestration({
      id: "test-2",
      userPrompt: "Build something",
      orchestratorSessionKey: "sk-1",
      agentId: "agent-1",
      workspaceDir: "/tmp/ws",
      sourceWorkspaceDir: "/tmp/src",
      maxFixCycles: 5,
    });
    expect(orch.maxFixCycles).toBe(5);
  });

  it("uses default maxFixCycles when not specified", () => {
    const orch = createOrchestration({
      id: "test-3",
      userPrompt: "Build something",
      orchestratorSessionKey: "sk-1",
      agentId: "agent-1",
      workspaceDir: "/tmp/ws",
      sourceWorkspaceDir: "/tmp/src",
    });
    expect(orch.maxFixCycles).toBe(30);
  });
});
