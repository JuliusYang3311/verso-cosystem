/**
 * Task Dispatcher — dependency-aware async task queue with auto-fix.
 *
 * Manages a DAG of subtasks. Consumer loops call `next()` to get the next
 * ready task. If no task is ready but work remains, the call blocks until
 * a dependency completes and unblocks new tasks.
 *
 * When a task fails and blocks dependents (deadlock), the dispatcher
 * automatically creates fix tasks (up to MAX_AUTO_RETRIES per source task).
 * If a source task exhausts its retries, its blocked dependents are cancelled
 * and the dispatcher reports the exhausted tasks for Orchestrator re-planning.
 *
 * Lifecycle:
 *   const dispatcher = new TaskDispatcher(subtasks);
 *   // N concurrent loops:
 *   while (true) {
 *     const task = await dispatcher.next();
 *     if (!task) return;
 *     ... execute task ...
 *     dispatcher.onTaskDone();
 *   }
 *   // After all loops exit:
 *   dispatcher.exhaustedTasks  // tasks that need Orchestrator re-planning
 *   dispatcher.autoFixCount    // number of auto-fix tasks created
 */

import type { Subtask, FixTask } from "./types.js";
import { isSubtaskReady } from "./types.js";

const MAX_AUTO_RETRIES = 2;

export class TaskDispatcher {
  private ready: Subtask[] = [];
  private claimed = new Set<string>();
  private finished = false;
  private waiters: Array<(task: Subtask | null) => void> = [];

  /** Tasks that exhausted auto-retry — Orchestrator must re-plan these. */
  readonly exhaustedTasks: Array<{ id: string; title: string; retryCount: number }> = [];
  /** Auto-fix FixTask records (for orch.fixTasks). */
  readonly autoFixTasks: FixTask[] = [];
  /** Number of auto-fix subtasks created during this dispatch. */
  get autoFixCount(): number {
    return this.autoFixTasks.length;
  }

  constructor(private subtasks: Subtask[]) {
    for (const s of subtasks) {
      if (isSubtaskReady(s, subtasks)) this.ready.push(s);
    }
    this.refreshFinished();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Get the next ready task, or wait until one becomes available.
   * Returns null when all tasks are completed/failed/cancelled (no work left).
   */
  async next(): Promise<Subtask | null> {
    const task = this.tryClaimReady();
    if (task) return task;
    if (this.finished) return null;
    return new Promise<Subtask | null>((resolve) => this.waiters.push(resolve));
  }

  /**
   * Signal that a task just completed or failed.
   * Discovers newly-unblocked dependents and wakes waiting consumers.
   * If a failure creates a deadlock, auto-creates fix tasks or cancels blocked tasks.
   */
  onTaskDone(): void {
    // 1. Discover newly ready tasks
    for (const s of this.subtasks) {
      if (s.status === "pending" && !this.claimed.has(s.id) && isSubtaskReady(s, this.subtasks)) {
        if (!this.ready.includes(s)) this.ready.push(s);
      }
    }

    // 2. Handle deadlocks: pending tasks whose dependencies failed
    this.resolveBlockedTasks();

    this.refreshFinished();
    this.wakeWaiters();
  }

  // ---------------------------------------------------------------------------
  // Auto-fix: resolve blocked tasks when dependencies fail
  // ---------------------------------------------------------------------------

  /**
   * Find pending tasks blocked by failed dependencies.
   * For each failed dep:
   *   - retryCount < MAX_AUTO_RETRIES → create auto-fix subtask, rewire dependencies
   *   - retryCount >= MAX_AUTO_RETRIES → cancel blocked tasks, record as exhausted
   */
  private resolveBlockedTasks(): void {
    // Collect all failed task IDs
    const failedIds = new Set(this.subtasks.filter((s) => s.status === "failed").map((s) => s.id));
    if (failedIds.size === 0) return;

    // Find pending tasks blocked by a failed dependency
    const blockedTasks = this.subtasks.filter(
      (s) =>
        s.status === "pending" &&
        !this.claimed.has(s.id) &&
        s.dependsOn?.some((depId) => failedIds.has(depId)),
    );
    if (blockedTasks.length === 0) return;

    // Collect unique failed deps that are blocking something
    const failedDepsToResolve = new Set<string>();
    for (const bt of blockedTasks) {
      for (const depId of bt.dependsOn ?? []) {
        if (failedIds.has(depId)) failedDepsToResolve.add(depId);
      }
    }

    const sourceToFixMap = new Map<string, string>();

    for (const failedDepId of failedDepsToResolve) {
      const failedDep = this.subtasks.find((s) => s.id === failedDepId);
      if (!failedDep) continue;

      if (failedDep.retryCount >= MAX_AUTO_RETRIES) {
        // Exhausted — record for Orchestrator, don't auto-fix
        if (!this.exhaustedTasks.some((t) => t.id === failedDep.id)) {
          this.exhaustedTasks.push({
            id: failedDep.id,
            title: failedDep.title,
            retryCount: failedDep.retryCount,
          });
        }
        continue;
      }

      // Create auto-fix subtask
      const fixId = `fix-auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      sourceToFixMap.set(failedDepId, fixId);

      const fixSubtask: Subtask = {
        id: fixId,
        title: `Fix: ${failedDep.title}`,
        description: `Fix failed task: ${failedDep.title}\n\nOriginal error: ${failedDep.error ?? "Unknown error"}\n\nOriginal task description:\n${failedDep.description}`,
        acceptanceCriteria: failedDep.acceptanceCriteria,
        specialization: failedDep.specialization || "code-implementer",
        status: "pending",
        dependsOn: failedDep.dependsOn,
        retryCount: failedDep.retryCount + 1,
        createdAtMs: Date.now(),
      };

      // Add to subtask list (dispatcher manages this array)
      this.subtasks.push(fixSubtask);
      this.ready.push(fixSubtask);

      // Record FixTask for orch.fixTasks
      this.autoFixTasks.push({
        id: fixId,
        sourceSubtaskId: failedDepId,
        description: fixSubtask.description,
        status: "pending",
        createdAtMs: Date.now(),
      });

      // Cancel the original failed task
      failedDep.status = "cancelled";
    }

    // Cancel blocked tasks whose failed deps are exhausted (no fix coming)
    for (const bt of blockedTasks) {
      const hasExhaustedDep = bt.dependsOn?.some((depId) => {
        const dep = this.subtasks.find((s) => s.id === depId);
        return dep && dep.status === "failed" && dep.retryCount >= MAX_AUTO_RETRIES;
      });
      if (hasExhaustedDep) {
        bt.status = "cancelled";
      }
    }

    // Rewire dependencies BEFORE cascade — pending tasks now point to fix tasks,
    // so the cascade won't incorrectly cancel tasks that were saved by a fix.
    for (const bt of this.subtasks) {
      if (bt.status === "pending" && bt.dependsOn) {
        bt.dependsOn = bt.dependsOn.map((depId) => sourceToFixMap.get(depId) ?? depId);
      }
    }

    // Cascade: cancel pending tasks whose dependencies are cancelled (post-rewire).
    // e.g., t1 exhausted → t2 cancelled → t3 depends on t2 → also cancel t3
    let cascadeChanged = true;
    while (cascadeChanged) {
      cascadeChanged = false;
      for (const s of this.subtasks) {
        if (
          s.status === "pending" &&
          s.dependsOn?.some((depId) => {
            const dep = this.subtasks.find((d) => d.id === depId);
            return dep?.status === "cancelled";
          })
        ) {
          s.status = "cancelled";
          cascadeChanged = true;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private tryClaimReady(): Subtask | null {
    while (this.ready.length > 0) {
      const task = this.ready.shift()!;
      if (!this.claimed.has(task.id) && task.status === "pending") {
        this.claimed.add(task.id);
        task.status = "running";
        task.startedAtMs = Date.now();
        return task;
      }
    }
    return null;
  }

  private refreshFinished(): void {
    this.finished = this.subtasks.every((s) => s.status !== "pending" && s.status !== "running");
  }

  private wakeWaiters(): void {
    while (this.waiters.length > 0 && this.ready.length > 0) {
      const task = this.tryClaimReady();
      if (task) {
        this.waiters.shift()!(task);
      } else {
        break;
      }
    }
    if (this.finished) {
      while (this.waiters.length > 0) this.waiters.shift()!(null);
    }
  }
}
