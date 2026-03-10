/**
 * Persistent Worker Pool — pre-created worker sessions with fixed specializations.
 *
 * Default distribution (14 workers):
 *   code-explorer: 2, code-architect: 2, code-implementer: 4,
 *   code-reviewer: 2, researcher: 2, generic: 2
 *
 * Claiming priority:
 *   1. Dependency affinity — prefer the worker that completed a dependency task
 *      (only if specialization also matches or worker is generic)
 *   2. Exact specialization match — idle worker of the same type
 *   3. Generic fallback — idle generic worker (accepts any specialization)
 *   4. Wait — all eligible workers busy, await next release
 *
 * Non-generic workers ONLY accept tasks matching their specialization.
 * Generic workers accept anything — they're the flexible overflow.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { VersoConfig } from "../config/types.js";
import type { MemorySearchManager } from "../memory/types.js";
import type { WorkerSpecialization } from "./specializations/types.js";
import { createVersoSession } from "../agents/session-factory.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PoolWorker = {
  id: string;
  specialization: WorkerSpecialization;
  session: AgentSession;
  busy: boolean;
  /** Number of tasks this worker has executed. */
  taskCount: number;
  /** IDs of subtasks this worker has completed (for dependency affinity). */
  completedTaskIds: string[];
};

export type ClaimOptions = {
  /** IDs of tasks this subtask depends on. Used for affinity matching. */
  dependsOn?: string[];
};

/** Default worker distribution — 14 workers total. */
export const DEFAULT_WORKER_DISTRIBUTION: Array<{
  specialization: WorkerSpecialization;
  count: number;
}> = [
  { specialization: "code-explorer", count: 2 },
  { specialization: "code-architect", count: 2 },
  { specialization: "code-implementer", count: 4 },
  { specialization: "code-reviewer", count: 2 },
  { specialization: "researcher", count: 2 },
  { specialization: "generic", count: 2 },
];

export type WorkerPoolConfig = {
  /** Worker distribution by specialization. Defaults to DEFAULT_WORKER_DISTRIBUTION. */
  workers?: Array<{ specialization: WorkerSpecialization; count: number }>;
  /** Working directory for worker sessions (sandbox). */
  cwd: string;
  /** Agent configuration directory. */
  agentDir: string;
  /** Model to use for workers. */
  model: Model<Api>;
  authStorage: unknown;
  modelRegistry: unknown;
  /** Verso config for extension registration. */
  config?: VersoConfig;
  /** Memory manager for dynamic context (Layer 1). */
  memoryManager?: MemorySearchManager | null;
  /** Custom tools for worker sessions. */
  customTools?: Parameters<typeof createVersoSession>[0]["customTools"];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a worker can accept a task of the given specialization. */
function canAccept(worker: PoolWorker, specialization: WorkerSpecialization): boolean {
  if (worker.specialization === "generic") return true;
  return worker.specialization === specialization;
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

export class WorkerPool {
  private workers: PoolWorker[] = [];
  private waitQueue: Array<{
    specialization: WorkerSpecialization;
    dependsOn?: string[];
    resolve: (worker: PoolWorker) => void;
  }> = [];

  /** Create and initialize the pool with pre-created sessions. */
  static async create(config: WorkerPoolConfig): Promise<WorkerPool> {
    const pool = new WorkerPool();
    const distribution = config.workers ?? DEFAULT_WORKER_DISTRIBUTION;

    const createPromises: Promise<PoolWorker>[] = [];
    let counter = 0;

    for (const { specialization, count } of distribution) {
      for (let i = 0; i < count; i++) {
        const id = `${specialization}-${counter++}`;
        createPromises.push(
          createVersoSession({
            cwd: config.cwd,
            agentDir: config.agentDir,
            model: config.model,
            authStorage: config.authStorage as Parameters<
              typeof createVersoSession
            >[0]["authStorage"],
            modelRegistry: config.modelRegistry as Parameters<
              typeof createVersoSession
            >[0]["modelRegistry"],
            config: config.config,
            memoryManager: config.memoryManager ?? null,
            customTools: config.customTools,
            provider: config.model.provider,
            modelId: config.model.id,
          }).then(({ session }) => ({
            id,
            specialization,
            session,
            busy: false,
            taskCount: 0,
            completedTaskIds: [],
          })),
        );
      }
    }

    pool.workers = await Promise.all(createPromises);
    return pool;
  }

  /** Number of workers in the pool. */
  get size(): number {
    return this.workers.length;
  }

  /** Number of idle workers. */
  get idle(): number {
    return this.workers.filter((w) => !w.busy).length;
  }

  /**
   * Claim a worker for the given specialization.
   *
   * Priority: affinity → exact match → generic fallback → wait.
   */
  async claim(specialization: WorkerSpecialization, opts?: ClaimOptions): Promise<PoolWorker> {
    const dependsOn = opts?.dependsOn;

    // 1. Affinity — idle worker that completed a dependency AND can accept this specialization
    if (dependsOn && dependsOn.length > 0) {
      const affinity = this.workers.find(
        (w) =>
          !w.busy &&
          canAccept(w, specialization) &&
          w.completedTaskIds.some((id) => dependsOn.includes(id)),
      );
      if (affinity) {
        affinity.busy = true;
        return affinity;
      }
    }

    // 2. Exact specialization match
    const exact = this.workers.find((w) => !w.busy && w.specialization === specialization);
    if (exact) {
      exact.busy = true;
      return exact;
    }

    // 3. Generic fallback (only if requested specialization isn't already generic — handled by step 2)
    if (specialization !== "generic") {
      const generic = this.workers.find((w) => !w.busy && w.specialization === "generic");
      if (generic) {
        generic.busy = true;
        return generic;
      }
    }

    // 4. Wait for release
    return new Promise<PoolWorker>((resolve) => {
      this.waitQueue.push({ specialization, dependsOn, resolve });
    });
  }

  /**
   * Release a worker back to the pool.
   * @param completedTaskId — ID of the subtask just completed (for affinity tracking).
   */
  release(worker: PoolWorker, completedTaskId?: string): void {
    worker.busy = false;
    worker.taskCount++;
    if (completedTaskId) {
      worker.completedTaskIds.push(completedTaskId);
    }

    if (this.waitQueue.length > 0) {
      this.serviceWaitQueue(worker);
    }
  }

  /** Try to match a just-released worker to a waiting claimer. */
  private serviceWaitQueue(worker: PoolWorker): void {
    // 1. Affinity — waiter whose dependsOn includes something this worker completed
    const affinityIdx = this.waitQueue.findIndex(
      (w) =>
        canAccept(worker, w.specialization) &&
        w.dependsOn?.some((id) => worker.completedTaskIds.includes(id)),
    );
    if (affinityIdx >= 0) {
      const waiter = this.waitQueue.splice(affinityIdx, 1)[0];
      worker.busy = true;
      waiter.resolve(worker);
      return;
    }

    // 2. Exact specialization match
    const exactIdx = this.waitQueue.findIndex((w) => w.specialization === worker.specialization);
    if (exactIdx >= 0) {
      const waiter = this.waitQueue.splice(exactIdx, 1)[0];
      worker.busy = true;
      waiter.resolve(worker);
      return;
    }

    // 3. Generic fallback — only if this worker is generic
    if (worker.specialization === "generic") {
      if (this.waitQueue.length > 0) {
        const waiter = this.waitQueue.splice(0, 1)[0]; // FIFO
        worker.busy = true;
        waiter.resolve(worker);
        return;
      }
    }

    // No match — worker stays idle
  }

  /** Destroy all sessions (best-effort cleanup). */
  async destroy(): Promise<void> {
    while (this.waitQueue.length > 0) {
      this.waitQueue.shift();
    }
    this.workers = [];
  }
}
