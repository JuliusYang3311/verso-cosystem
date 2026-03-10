// src/orchestration/__tests__/worker-pool.test.ts — WorkerPool unit tests
//
// Tests the pool's claim/release logic, specialization matching,
// affinity, generic fallback, and wait queue behavior.
// Uses a lightweight mock (no real sessions).

import { describe, it, expect } from "vitest";
import { WorkerPool, type PoolWorker } from "../worker-pool.js";

// Build a pool directly from mock workers (bypass create() which needs real sessions)
function createMockPool(
  workers: Array<{ id: string; specialization: PoolWorker["specialization"] }>,
): WorkerPool {
  const pool = new WorkerPool() as WorkerPool & { workers: PoolWorker[] };
  pool["workers"] = workers.map((w) => ({
    id: w.id,
    specialization: w.specialization,
    session: {} as PoolWorker["session"],
    busy: false,
    taskCount: 0,
    completedTaskIds: [],
  }));
  return pool;
}

describe("WorkerPool", () => {
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
    });

    it("releases worker and increments taskCount", async () => {
      const pool = createMockPool([{ id: "impl-0", specialization: "code-implementer" }]);

      const worker = await pool.claim("code-implementer");
      expect(pool.idle).toBe(0);

      pool.release(worker, "t1");
      expect(pool.idle).toBe(1);
      expect(worker.taskCount).toBe(1);
      expect(worker.completedTaskIds).toContain("t1");
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

      // This should wait (no match, no generic)
      let resolved = false;
      const p = pool.claim("code-implementer").then((w) => {
        resolved = true;
        return w;
      });

      await new Promise((r) => setTimeout(r, 20));
      expect(resolved).toBe(false);

      // Add a generic worker via release trick — manually push to workers
      const mockWorker: PoolWorker = {
        id: "gen-0",
        specialization: "generic",
        session: {} as PoolWorker["session"],
        busy: true,
        taskCount: 0,
        completedTaskIds: [],
      };
      (pool as unknown as { workers: PoolWorker[] }).workers.push(mockWorker);
      pool.release(mockWorker);

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

      // Claim both simultaneously so each gets a distinct worker
      const w0 = await pool.claim("code-implementer");
      const w1 = await pool.claim("code-implementer");
      expect(w0.id).toBe("impl-0");
      expect(w1.id).toBe("impl-1");

      // Release both — impl-0 completed "t1", impl-1 completed "t2"
      pool.release(w0, "t1");
      pool.release(w1, "t2");

      // Claim with affinity for "t2" — should pick impl-1
      const affinity = await pool.claim("code-implementer", { dependsOn: ["t2"] });
      expect(affinity.id).toBe("impl-1");
    });

    it("affinity only works if worker can accept the specialization", async () => {
      const pool = createMockPool([
        { id: "expl-0", specialization: "code-explorer" },
        { id: "impl-0", specialization: "code-implementer" },
      ]);

      // expl-0 completed t1
      const w = await pool.claim("code-explorer");
      pool.release(w, "t1");

      // Claim code-implementer with affinity for t1 — expl-0 can't accept it
      const worker = await pool.claim("code-implementer", { dependsOn: ["t1"] });
      expect(worker.id).toBe("impl-0"); // exact match, not affinity
    });

    it("generic worker gets affinity match for any specialization", async () => {
      const pool = createMockPool([
        { id: "gen-0", specialization: "generic" },
        { id: "impl-0", specialization: "code-implementer" },
      ]);

      // gen-0 completed t1
      const w = await pool.claim("generic");
      pool.release(w, "t1");

      // Claim code-implementer with affinity for t1 — generic can accept
      const worker = await pool.claim("code-implementer", { dependsOn: ["t1"] });
      expect(worker.id).toBe("gen-0");
    });
  });

  // -----------------------------------------------------------------------
  // Wait queue
  // -----------------------------------------------------------------------

  describe("wait queue", () => {
    it("queues claimers when all workers busy, resolves on release", async () => {
      const pool = createMockPool([{ id: "impl-0", specialization: "code-implementer" }]);

      const w1 = await pool.claim("code-implementer");
      expect(pool.idle).toBe(0);

      let waitResolved = false;
      const waitPromise = pool.claim("code-implementer").then((w) => {
        waitResolved = true;
        return w;
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(waitResolved).toBe(false);

      pool.release(w1);

      const w2 = await waitPromise;
      expect(w2.id).toBe("impl-0");
      expect(waitResolved).toBe(true);
    });

    it("services wait queue with affinity priority on release", async () => {
      const pool = createMockPool([{ id: "impl-0", specialization: "code-implementer" }]);

      const w = await pool.claim("code-implementer");

      // Two waiters: one with affinity, one without
      const waiter1Promise = pool.claim("code-implementer"); // no affinity
      const waiter2Promise = pool.claim("code-implementer", { dependsOn: ["t1"] }); // wants affinity

      // Release with completed task "t1" — waiter2 should get priority
      pool.release(w, "t1");

      // waiter2 should resolve first (affinity match)
      const resolved = await waiter2Promise;
      expect(resolved.id).toBe("impl-0");

      // Release again for waiter1
      pool.release(resolved);
      const resolved1 = await waiter1Promise;
      expect(resolved1.id).toBe("impl-0");
    });
  });

  // -----------------------------------------------------------------------
  // Pool size
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
      expect(pool.idle).toBe(3);
    });
  });
});
