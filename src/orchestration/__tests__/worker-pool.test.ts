// src/orchestration/__tests__/worker-pool.test.ts — WorkerPool unit tests
//
// Tests the pool's claim/release logic, state machine transitions,
// specialization matching, affinity, generic fallback, load balancing,
// settling phase, exclude/retry, and wait queue behavior.
// Uses a lightweight mock (no real sessions).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkerPool, type PoolWorker, type WorkerState } from "../worker-pool.js";

// Build a pool directly from mock workers (bypass create() which needs real sessions)
function createMockPool(
  workers: Array<{
    id: string;
    specialization: PoolWorker["specialization"];
    idleSince?: number;
    taskCount?: number;
    completedTaskIds?: string[];
  }>,
): WorkerPool {
  const pool = new WorkerPool() as WorkerPool & { workers: PoolWorker[] };
  pool["workers"] = workers.map((w) => ({
    id: w.id,
    specialization: w.specialization,
    session: { abort: vi.fn().mockResolvedValue(undefined) } as unknown as PoolWorker["session"],
    state: "idle" as WorkerState,
    taskCount: w.taskCount ?? 0,
    completedTaskIds: w.completedTaskIds ?? [],
    idleSince: w.idleSince ?? 0,
  }));
  return pool;
}

describe("WorkerPool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Basic claim & release
  // -----------------------------------------------------------------------

  describe("claim and release", () => {
    it("claims an exact-match worker", async () => {
      const pool = createMockPool([
        { id: "impl-0", specialization: "code-implementer" },
        { id: "expl-0", specialization: "code-explorer" },
      ]);

      const worker = await pool.claim("code-implementer");
      expect(worker.id).toBe("impl-0");
      expect(worker.specialization).toBe("code-implementer");
      expect(worker.state).toBe("claimed");
    });

    it("releases worker and increments taskCount", async () => {
      const pool = createMockPool([{ id: "impl-0", specialization: "code-implementer" }]);

      const worker = await pool.claim("code-implementer");
      expect(pool.idle).toBe(0);

      pool.release(worker, "t1");
      // Worker is in settling state immediately after release
      expect(worker.state).toBe("settling");
      expect(worker.taskCount).toBe(1);
      expect(worker.completedTaskIds).toContain("t1");

      // After settling resolves, worker becomes idle
      await vi.runAllTimersAsync();
      expect(worker.state).toBe("idle");
      expect(pool.idle).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // State machine transitions
  // -----------------------------------------------------------------------

  describe("state machine", () => {
    it("transitions idle → claimed → settling → idle", async () => {
      const pool = createMockPool([{ id: "w-0", specialization: "code-implementer" }]);

      const workers = (pool as unknown as { workers: PoolWorker[] }).workers;
      expect(workers[0].state).toBe("idle");

      const worker = await pool.claim("code-implementer");
      expect(worker.state).toBe("claimed");

      pool.release(worker);
      expect(worker.state).toBe("settling");

      await vi.runAllTimersAsync();
      expect(worker.state).toBe("idle");
    });

    it("settling worker is not claimable", async () => {
      const pool = createMockPool([{ id: "w-0", specialization: "code-implementer" }]);

      const worker = await pool.claim("code-implementer");
      pool.release(worker);
      expect(worker.state).toBe("settling");

      // Try to claim — should wait, not get the settling worker
      let claimed = false;
      void pool.claim("code-implementer").then(() => {
        claimed = true;
      });

      // Give microtasks a chance
      await Promise.resolve();
      expect(claimed).toBe(false);

      // Once settling completes, the waiter should resolve
      await vi.runAllTimersAsync();
      expect(claimed).toBe(true);
    });

    it("settling calls session.abort() when session is streaming", async () => {
      const pool = createMockPool([{ id: "w-0", specialization: "code-implementer" }]);
      const workers = (pool as unknown as { workers: PoolWorker[] }).workers;
      const session = workers[0].session as unknown as Record<string, unknown>;

      // Simulate isStreaming = true
      session.isStreaming = true;

      const worker = await pool.claim("code-implementer");
      pool.release(worker);

      await vi.runAllTimersAsync();
      expect(session.abort as ReturnType<typeof vi.fn>).toHaveBeenCalled();
      expect(worker.state).toBe("idle");
    });

    it("settling skips abort when session is not streaming", async () => {
      const pool = createMockPool([{ id: "w-0", specialization: "code-implementer" }]);
      const workers = (pool as unknown as { workers: PoolWorker[] }).workers;
      const session = workers[0].session as unknown as Record<string, unknown>;

      // isStreaming is falsy/undefined — abort should NOT be called
      session.isStreaming = false;

      const worker = await pool.claim("code-implementer");
      pool.release(worker);

      await vi.runAllTimersAsync();
      expect(session.abort as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
      expect(worker.state).toBe("idle");
    });
  });

  // -----------------------------------------------------------------------
  // Load balancing (pickBest)
  // -----------------------------------------------------------------------

  describe("load balancing", () => {
    it("prefers the worker idle longest", async () => {
      const pool = createMockPool([
        { id: "impl-0", specialization: "code-implementer", idleSince: 1000 },
        { id: "impl-1", specialization: "code-implementer", idleSince: 500 }, // idle longer
        { id: "impl-2", specialization: "code-implementer", idleSince: 2000 },
      ]);

      const worker = await pool.claim("code-implementer");
      expect(worker.id).toBe("impl-1"); // lowest idleSince = idle longest
    });

    it("breaks ties by fewest tasks executed", async () => {
      const pool = createMockPool([
        { id: "impl-0", specialization: "code-implementer", idleSince: 500, taskCount: 3 },
        { id: "impl-1", specialization: "code-implementer", idleSince: 500, taskCount: 1 }, // fewer tasks
        { id: "impl-2", specialization: "code-implementer", idleSince: 500, taskCount: 5 },
      ]);

      const worker = await pool.claim("code-implementer");
      expect(worker.id).toBe("impl-1"); // same idleSince, fewest tasks
    });
  });

  // -----------------------------------------------------------------------
  // Exclude (retry-with-fallback support)
  // -----------------------------------------------------------------------

  describe("exclude", () => {
    it("skips excluded workers during claim", async () => {
      const pool = createMockPool([
        { id: "impl-0", specialization: "code-implementer" },
        { id: "impl-1", specialization: "code-implementer" },
      ]);

      const worker = await pool.claim("code-implementer", { exclude: ["impl-0"] });
      expect(worker.id).toBe("impl-1");
    });

    it("falls back to generic when exact match excluded", async () => {
      const pool = createMockPool([
        { id: "impl-0", specialization: "code-implementer" },
        { id: "gen-0", specialization: "generic" },
      ]);

      const worker = await pool.claim("code-implementer", { exclude: ["impl-0"] });
      expect(worker.id).toBe("gen-0");
    });

    it("waits when all eligible workers excluded", async () => {
      const pool = createMockPool([{ id: "impl-0", specialization: "code-implementer" }]);

      let resolved = false;
      void pool.claim("code-implementer", { exclude: ["impl-0"] }).then(() => {
        resolved = true;
      });

      await Promise.resolve();
      expect(resolved).toBe(false);
    });

    it("excluded workers in wait queue are respected on release", async () => {
      const pool = createMockPool([
        { id: "impl-0", specialization: "code-implementer" },
        { id: "impl-1", specialization: "code-implementer" },
      ]);

      // Claim both
      const w0 = await pool.claim("code-implementer");
      const w1 = await pool.claim("code-implementer");

      // Queue a waiter that excludes impl-0
      let resolved: PoolWorker | null = null;
      void pool.claim("code-implementer", { exclude: ["impl-0"] }).then((w) => {
        resolved = w;
      });

      // Release impl-0 — should NOT satisfy waiter (excluded)
      pool.release(w0);
      await vi.runAllTimersAsync();
      expect(resolved).toBeNull();

      // Release impl-1 — should satisfy waiter
      pool.release(w1);
      await vi.runAllTimersAsync();
      expect(resolved?.id).toBe("impl-1");
    });
  });

  // -----------------------------------------------------------------------
  // Generic fallback
  // -----------------------------------------------------------------------

  describe("generic fallback", () => {
    it("falls back to generic when no exact match available", async () => {
      const pool = createMockPool([
        { id: "gen-0", specialization: "generic" },
        { id: "expl-0", specialization: "code-explorer" },
      ]);

      const worker = await pool.claim("code-implementer");
      expect(worker.id).toBe("gen-0");
      expect(worker.specialization).toBe("generic");
    });

    it("non-generic worker does NOT accept mismatched specialization", async () => {
      const pool = createMockPool([{ id: "expl-0", specialization: "code-explorer" }]);

      let resolved = false;
      const p = pool.claim("code-implementer").then((w) => {
        resolved = true;
        return w;
      });

      await Promise.resolve();
      expect(resolved).toBe(false);

      // Add a generic worker and release it to service the waiter
      const workers = (pool as unknown as { workers: PoolWorker[] }).workers;
      const mockWorker: PoolWorker = {
        id: "gen-0",
        specialization: "generic",
        session: {
          abort: vi.fn().mockResolvedValue(undefined),
        } as unknown as PoolWorker["session"],
        state: "claimed" as WorkerState,
        taskCount: 0,
        completedTaskIds: [],
        idleSince: 0,
      };
      workers.push(mockWorker);
      pool.release(mockWorker);

      await vi.runAllTimersAsync();
      const worker = await p;
      expect(worker.id).toBe("gen-0");
    });

    it("prefers exact match over generic", async () => {
      const pool = createMockPool([
        { id: "gen-0", specialization: "generic" },
        { id: "impl-0", specialization: "code-implementer" },
      ]);

      const worker = await pool.claim("code-implementer");
      expect(worker.id).toBe("impl-0");
    });
  });

  // -----------------------------------------------------------------------
  // Affinity
  // -----------------------------------------------------------------------

  describe("affinity", () => {
    it("prefers worker that completed a dependency task", async () => {
      const pool = createMockPool([
        { id: "impl-0", specialization: "code-implementer" },
        { id: "impl-1", specialization: "code-implementer" },
      ]);

      const w0 = await pool.claim("code-implementer");
      const w1 = await pool.claim("code-implementer");

      pool.release(w0, "t1");
      pool.release(w1, "t2");
      await vi.runAllTimersAsync();

      const affinity = await pool.claim("code-implementer", { dependsOn: ["t2"] });
      expect(affinity.id).toBe("impl-1");
    });

    it("affinity only works if worker can accept the specialization", async () => {
      const pool = createMockPool([
        { id: "expl-0", specialization: "code-explorer" },
        { id: "impl-0", specialization: "code-implementer" },
      ]);

      const w = await pool.claim("code-explorer");
      pool.release(w, "t1");
      await vi.runAllTimersAsync();

      const worker = await pool.claim("code-implementer", { dependsOn: ["t1"] });
      expect(worker.id).toBe("impl-0");
    });

    it("generic worker gets affinity match for any specialization", async () => {
      const pool = createMockPool([
        { id: "gen-0", specialization: "generic" },
        { id: "impl-0", specialization: "code-implementer" },
      ]);

      const w = await pool.claim("generic");
      pool.release(w, "t1");
      await vi.runAllTimersAsync();

      const worker = await pool.claim("code-implementer", { dependsOn: ["t1"] });
      expect(worker.id).toBe("gen-0");
    });
  });

  // -----------------------------------------------------------------------
  // Wait queue
  // -----------------------------------------------------------------------

  describe("wait queue", () => {
    it("queues claimers when all workers claimed, resolves on release", async () => {
      const pool = createMockPool([{ id: "impl-0", specialization: "code-implementer" }]);

      const w1 = await pool.claim("code-implementer");
      expect(pool.idle).toBe(0);

      let waitResolved = false;
      const waitPromise = pool.claim("code-implementer").then((w) => {
        waitResolved = true;
        return w;
      });

      await Promise.resolve();
      expect(waitResolved).toBe(false);

      pool.release(w1);
      await vi.runAllTimersAsync();

      const w2 = await waitPromise;
      expect(w2.id).toBe("impl-0");
      expect(waitResolved).toBe(true);
    });

    it("services wait queue with affinity priority on release", async () => {
      const pool = createMockPool([{ id: "impl-0", specialization: "code-implementer" }]);

      const w = await pool.claim("code-implementer");

      const waiter1Promise = pool.claim("code-implementer");
      const waiter2Promise = pool.claim("code-implementer", { dependsOn: ["t1"] });

      pool.release(w, "t1");
      await vi.runAllTimersAsync();

      const resolved = await waiter2Promise;
      expect(resolved.id).toBe("impl-0");

      pool.release(resolved);
      await vi.runAllTimersAsync();

      const resolved1 = await waiter1Promise;
      expect(resolved1.id).toBe("impl-0");
    });
  });

  // -----------------------------------------------------------------------
  // Pool metrics
  // -----------------------------------------------------------------------

  describe("pool metrics", () => {
    it("reports correct size and idle count", async () => {
      const pool = createMockPool([
        { id: "impl-0", specialization: "code-implementer" },
        { id: "impl-1", specialization: "code-implementer" },
        { id: "gen-0", specialization: "generic" },
      ]);

      expect(pool.size).toBe(3);
      expect(pool.idle).toBe(3);

      const w = await pool.claim("code-implementer");
      expect(pool.idle).toBe(2);

      pool.release(w);
      await vi.runAllTimersAsync();
      expect(pool.idle).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Destroy
  // -----------------------------------------------------------------------

  describe("destroy", () => {
    it("clears workers and wait queue", async () => {
      const pool = createMockPool([{ id: "impl-0", specialization: "code-implementer" }]);

      await pool.claim("code-implementer");
      // Queue a waiter
      void pool.claim("code-implementer");

      await pool.destroy();
      expect(pool.size).toBe(0);
    });
  });
});
