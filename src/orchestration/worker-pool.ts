/**
 * Persistent Worker Pool — pre-created worker sessions with fixed specializations.
 *
 * ## Worker State Machine
 *
 *   idle ─claim()─→ claimed ─(caller runs prompt)─→ settling ─(auto)─→ idle
 *                                                       │
 *                                                  session.abort()
 *                                                  ensures idle
 *
 * Only `idle` workers are eligible for claim(). The pool owns the entire
 * lifecycle: callers never touch session state directly.
 *
 * ## Claim Priority
 *
 *   1. Affinity — worker that completed a dependency task (idle longest first)
 *   2. Exact specialization match (idle longest first)
 *   3. Generic fallback (idle longest first)
 *   4. Wait — all eligible workers busy/settling, await next release
 *
 * Non-generic workers ONLY accept tasks matching their specialization.
 * Generic workers accept anything — they're the flexible overflow.
 *
 * ## Load Balancing
 *
 * At each priority level, candidates are sorted by idle duration (longest
 * first), with taskCount as tie-breaker. This prevents hammering one worker.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { VersoConfig } from "../config/types.js";
import type { MemorySearchManager } from "../memory/types.js";
import type { WorkerSpecialization } from "./specializations/types.js";
import { createVersoSession } from "../agents/session-factory.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max time to wait for a session to finish streaming after prompt returns. */
const SETTLE_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkerState = "idle" | "claimed" | "settling";

export type PoolWorker = {
  id: string;
  specialization: WorkerSpecialization;
  session: AgentSession;
  state: WorkerState;
  /** Number of tasks this worker has executed. */
  taskCount: number;
  /** IDs of subtasks this worker has completed (for dependency affinity). */
  completedTaskIds: string[];
  /** Timestamp when this worker last transitioned to idle. 0 = freshly created. */
  idleSince: number;
};

export type ClaimOptions = {
  /** IDs of tasks this subtask depends on. Used for affinity matching. */
  dependsOn?: string[];
  /** Worker IDs to exclude from claiming (e.g., after session failure). */
  exclude?: string[];
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

/**
 * Among candidates, pick the one idle longest (lowest idleSince).
 * Tie-break by fewest tasks executed (even load distribution).
 */
function pickBest(candidates: PoolWorker[]): PoolWorker | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  return candidates.reduce((best, w) => {
    if (w.idleSince < best.idleSince) return w;
    if (w.idleSince > best.idleSince) return best;
    return w.taskCount < best.taskCount ? w : best;
  });
}

/**
 * Settle a session: ensure isStreaming is false before returning it to the pool.
 * Uses session.abort() (SDK API: "abort current operation and wait for idle").
 * After a successful prompt this is typically a no-op, but guards against
 * residual streaming state from compaction, auto-retry, or follow-up queues.
 */
async function settleSession(session: AgentSession): Promise<void> {
  const s = session as unknown as Record<string, unknown>;
  if (!s.isStreaming) return;

  if (typeof session.abort === "function") {
    try {
      await Promise.race([
        session.abort(),
        new Promise<void>((r) => setTimeout(r, SETTLE_TIMEOUT_MS)),
      ]);
    } catch {
      // Best-effort — don't propagate abort failures
    }
  }
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

export class WorkerPool {
  private workers: PoolWorker[] = [];
  private waitQueue: Array<{
    specialization: WorkerSpecialization;
    dependsOn?: string[];
    exclude?: Set<string>;
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
            state: "idle" as WorkerState,
            taskCount: 0,
            completedTaskIds: [],
            idleSince: 0,
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

  /** Number of idle workers ready to be claimed. */
  get idle(): number {
    return this.workers.filter((w) => w.state === "idle").length;
  }

  /**
   * Claim a worker for the given specialization.
   *
   * Only considers workers in the `idle` state. Returns a worker in `claimed`
   * state — the caller is responsible for calling `release()` when done.
   */
  async claim(specialization: WorkerSpecialization, opts?: ClaimOptions): Promise<PoolWorker> {
    const dependsOn = opts?.dependsOn;
    const excludeSet = opts?.exclude ? new Set(opts.exclude) : undefined;

    const isEligible = (w: PoolWorker): boolean =>
      w.state === "idle" && (!excludeSet || !excludeSet.has(w.id));

    // 1. Affinity — idle worker that completed a dependency AND can accept
    if (dependsOn && dependsOn.length > 0) {
      const candidates = this.workers.filter(
        (w) =>
          isEligible(w) &&
          canAccept(w, specialization) &&
          w.completedTaskIds.some((id) => dependsOn.includes(id)),
      );
      const pick = pickBest(candidates);
      if (pick) {
        pick.state = "claimed";
        return pick;
      }
    }

    // 2. Exact specialization match
    const exactCandidates = this.workers.filter(
      (w) => isEligible(w) && w.specialization === specialization,
    );
    const exact = pickBest(exactCandidates);
    if (exact) {
      exact.state = "claimed";
      return exact;
    }

    // 3. Generic fallback
    if (specialization !== "generic") {
      const genericCandidates = this.workers.filter(
        (w) => isEligible(w) && w.specialization === "generic",
      );
      const generic = pickBest(genericCandidates);
      if (generic) {
        generic.state = "claimed";
        return generic;
      }
    }

    // 4. Wait for release
    return new Promise<PoolWorker>((resolve) => {
      this.waitQueue.push({ specialization, dependsOn, exclude: excludeSet, resolve });
    });
  }

  /**
   * Release a worker back to the pool.
   *
   * Transitions: claimed → settling → idle.
   * The settling phase calls session.abort() to ensure the session is fully
   * idle before making the worker available again. This is async but the
   * caller does not need to await it — the pool manages the transition.
   *
   * @param completedTaskId — ID of the subtask just completed (for affinity).
   */
  release(worker: PoolWorker, completedTaskId?: string): void {
    worker.taskCount++;
    if (completedTaskId) {
      worker.completedTaskIds.push(completedTaskId);
    }

    // Transition to settling — worker is not claimable during this phase
    worker.state = "settling";

    // Settle the session asynchronously, then mark idle
    void settleSession(worker.session).finally(() => {
      worker.state = "idle";
      worker.idleSince = Date.now();

      // Service wait queue now that we have an idle worker
      if (this.waitQueue.length > 0) {
        this.serviceWaitQueue(worker);
      }
    });
  }

  /** Try to match a just-idled worker to a waiting claimer. */
  private serviceWaitQueue(worker: PoolWorker): void {
    if (worker.state !== "idle") return;

    const isNotExcluded = (waiter: { exclude?: Set<string> }) =>
      !waiter.exclude || !waiter.exclude.has(worker.id);

    // 1. Affinity — waiter whose dependsOn includes something this worker completed
    const affinityIdx = this.waitQueue.findIndex(
      (w) =>
        isNotExcluded(w) &&
        canAccept(worker, w.specialization) &&
        w.dependsOn?.some((id) => worker.completedTaskIds.includes(id)),
    );
    if (affinityIdx >= 0) {
      const waiter = this.waitQueue.splice(affinityIdx, 1)[0];
      worker.state = "claimed";
      waiter.resolve(worker);
      return;
    }

    // 2. Exact specialization match
    const exactIdx = this.waitQueue.findIndex(
      (w) => isNotExcluded(w) && w.specialization === worker.specialization,
    );
    if (exactIdx >= 0) {
      const waiter = this.waitQueue.splice(exactIdx, 1)[0];
      worker.state = "claimed";
      waiter.resolve(worker);
      return;
    }

    // 3. Generic fallback — only if this worker is generic
    if (worker.specialization === "generic") {
      const idx = this.waitQueue.findIndex((w) => isNotExcluded(w));
      if (idx >= 0) {
        const waiter = this.waitQueue.splice(idx, 1)[0];
        worker.state = "claimed";
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
