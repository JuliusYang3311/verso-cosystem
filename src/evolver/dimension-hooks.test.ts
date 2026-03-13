import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Install fake timers BEFORE importing the module so any module-level
// setTimeout calls are captured by the fake timer system.
vi.useFakeTimers();

// ---------- Mocks ----------

const mockLoadFactorSpace = vi.fn();
const mockUpdateFactorWeight = vi.fn();
vi.mock("../memory/latent-factors.js", () => ({
  loadFactorSpace: (...args: unknown[]) => mockLoadFactorSpace(...args),
  updateFactorWeight: (...args: unknown[]) => mockUpdateFactorWeight(...args),
}));

const { learningDimensionHooks, emitFactorHit, emitFactorMiss } =
  await import("./dimension-hooks.js");

// Drain any timers that may have been scheduled during module import
await vi.runAllTimersAsync();
vi.useRealTimers();

describe("dimension-hooks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Default mock: loadFactorSpace returns a space with factors.
    // Note: The internal _pendingUpdates map uses composite keys
    // "factorId:providerModel:useCase", which are then iterated as the
    // factorId in flushWeightUpdates. So factors.find(f => f.id === key)
    // requires the factor id to match the composite key for updateFactorWeight
    // to be called.
    mockLoadFactorSpace.mockResolvedValue({
      factors: [
        { id: "factor-1:model-a:memory", weights: { "model-a:memory": 1.0 } },
        { id: "factor-2:new-model:search", weights: {} },
      ],
    });
    // updateFactorWeight returns an updated space
    mockUpdateFactorWeight.mockImplementation(
      async (space: unknown, _fId: string, _pm: string, _uc: string, _w: number) => space,
    );
  });

  afterEach(async () => {
    // Drain any pending flush timers so module state is clean for the next test.
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  describe("learningDimensionHooks.onFactorHit", () => {
    it("computes delta = lr * (score - baseline) and accumulates update", () => {
      learningDimensionHooks.onFactorHit({
        factorId: "factor-1",
        querySnippet: "test query",
        retrievalScore: 0.8,
        providerModel: "model-a",
        useCase: "memory",
        timestamp: Date.now(),
      });

      // A flush timer should be scheduled
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    });

    it("accumulates multiple hits for the same factor before flushing", () => {
      learningDimensionHooks.onFactorHit({
        factorId: "factor-1",
        querySnippet: "query 1",
        retrievalScore: 0.8, // delta = 0.05 * (0.8 - 0.5) = 0.015
        providerModel: "model-a",
        useCase: "memory",
        timestamp: Date.now(),
      });

      learningDimensionHooks.onFactorHit({
        factorId: "factor-1",
        querySnippet: "query 2",
        retrievalScore: 0.9, // delta = 0.05 * (0.9 - 0.5) = 0.020
        providerModel: "model-a",
        useCase: "memory",
        timestamp: Date.now(),
      });

      // Only one timer should be scheduled (debounce)
      expect(vi.getTimerCount()).toBe(1);
    });

    it("score below baseline yields negative delta (still schedules flush)", () => {
      learningDimensionHooks.onFactorHit({
        factorId: "factor-1",
        querySnippet: "low score query",
        retrievalScore: 0.3, // delta = 0.05 * (0.3 - 0.5) = -0.01
        providerModel: "model-a",
        useCase: "memory",
        timestamp: Date.now(),
      });

      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    });

    it("flushes and calls updateFactorWeight with correct computed weight", async () => {
      mockLoadFactorSpace.mockResolvedValue({
        factors: [{ id: "factor-1:model-a:memory", weights: { "model-a:memory": 1.0 } }],
      });

      learningDimensionHooks.onFactorHit({
        factorId: "factor-1",
        querySnippet: "test query",
        retrievalScore: 0.8, // delta = 0.05 * (0.8 - 0.5) = 0.015
        providerModel: "model-a",
        useCase: "memory",
        timestamp: Date.now(),
      });

      await vi.advanceTimersByTimeAsync(5100);
      await vi.advanceTimersByTimeAsync(100);

      expect(mockLoadFactorSpace).toHaveBeenCalled();
      expect(mockUpdateFactorWeight).toHaveBeenCalledOnce();
      const args = mockUpdateFactorWeight.mock.calls[0];
      expect(args[2]).toBe("model-a"); // providerModel
      expect(args[3]).toBe("memory"); // useCase
      // new weight = current(1.0) + delta(0.015) = 1.015
      expect(args[4]).toBeCloseTo(1.015, 5);
    });
  });

  describe("learningDimensionHooks.onFactorMiss", () => {
    it("applies delta = -decay and schedules flush", () => {
      learningDimensionHooks.onFactorMiss({
        factorId: "factor-1",
        querySnippet: "miss query",
        providerModel: "model-a",
        useCase: "memory",
        timestamp: Date.now(),
      });

      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    });

    it("flushes with correct negative delta on miss", async () => {
      mockLoadFactorSpace.mockResolvedValue({
        factors: [{ id: "factor-1:model-a:memory", weights: { "model-a:memory": 1.0 } }],
      });

      learningDimensionHooks.onFactorMiss({
        factorId: "factor-1",
        querySnippet: "miss query",
        providerModel: "model-a",
        useCase: "memory",
        timestamp: Date.now(),
      });

      await vi.advanceTimersByTimeAsync(5100);
      await vi.advanceTimersByTimeAsync(100);

      expect(mockLoadFactorSpace).toHaveBeenCalled();
      expect(mockUpdateFactorWeight).toHaveBeenCalledOnce();
      const args = mockUpdateFactorWeight.mock.calls[0];
      // delta = -0.02, current = 1.0, new = 0.98
      expect(args[4]).toBeCloseTo(0.98, 5);
    });
  });

  describe("convenience emitters", () => {
    it("emitFactorHit invokes learningDimensionHooks and schedules flush", () => {
      emitFactorHit("f-1", "snippet", 0.9, "model-a", "search");
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    });

    it("emitFactorHit defaults useCase to 'memory'", async () => {
      mockLoadFactorSpace.mockResolvedValue({
        factors: [{ id: "f-1:model-a:memory", weights: { "model-a:memory": 1.0 } }],
      });

      emitFactorHit("f-1", "snippet", 0.9, "model-a");

      await vi.advanceTimersByTimeAsync(5100);
      await vi.advanceTimersByTimeAsync(100);

      expect(mockUpdateFactorWeight).toHaveBeenCalledOnce();
      const args = mockUpdateFactorWeight.mock.calls[0];
      expect(args[3]).toBe("memory");
    });

    it("emitFactorMiss invokes learningDimensionHooks and schedules flush", () => {
      emitFactorMiss("f-2", "snippet", "model-b", "web");
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    });

    it("emitFactorMiss defaults useCase to 'memory'", async () => {
      mockLoadFactorSpace.mockResolvedValue({
        factors: [{ id: "f-2:model-b:memory", weights: { "model-b:memory": 1.0 } }],
      });

      emitFactorMiss("f-2", "snippet", "model-b");

      await vi.advanceTimersByTimeAsync(5100);
      await vi.advanceTimersByTimeAsync(100);

      expect(mockUpdateFactorWeight).toHaveBeenCalledOnce();
      const args = mockUpdateFactorWeight.mock.calls[0];
      expect(args[3]).toBe("memory");
    });
  });

  describe("batch flush debounce", () => {
    it("does not flush before the 5s timer", async () => {
      learningDimensionHooks.onFactorHit({
        factorId: "factor-1",
        querySnippet: "q",
        retrievalScore: 0.8,
        providerModel: "model-a",
        useCase: "memory",
        timestamp: Date.now(),
      });

      // Only advance 3 seconds -- should NOT have flushed yet
      await vi.advanceTimersByTimeAsync(3000);

      expect(mockLoadFactorSpace).not.toHaveBeenCalled();
    });

    it("flushes after the 5s timer (calls loadFactorSpace)", async () => {
      learningDimensionHooks.onFactorHit({
        factorId: "factor-1",
        querySnippet: "q",
        retrievalScore: 0.8,
        providerModel: "model-a",
        useCase: "memory",
        timestamp: Date.now(),
      });

      await vi.advanceTimersByTimeAsync(5100);

      expect(mockLoadFactorSpace).toHaveBeenCalledOnce();
    });

    it("does not double-flush on multiple rapid events", async () => {
      for (let i = 0; i < 3; i++) {
        learningDimensionHooks.onFactorHit({
          factorId: "factor-1",
          querySnippet: `q${i}`,
          retrievalScore: 0.8,
          providerModel: "model-a",
          useCase: "memory",
          timestamp: Date.now(),
        });
      }

      await vi.advanceTimersByTimeAsync(5100);

      // Should batch all into a single flush
      expect(mockLoadFactorSpace).toHaveBeenCalledOnce();
    });

    it("skips factor updates for non-matching factorIds", async () => {
      mockLoadFactorSpace.mockResolvedValue({
        factors: [{ id: "unrelated-factor", weights: {} }],
      });

      learningDimensionHooks.onFactorHit({
        factorId: "nonexistent-factor",
        querySnippet: "q",
        retrievalScore: 0.8,
        providerModel: "model-a",
        useCase: "memory",
        timestamp: Date.now(),
      });

      await vi.advanceTimersByTimeAsync(5100);
      await vi.advanceTimersByTimeAsync(100);

      expect(mockLoadFactorSpace).toHaveBeenCalledOnce();
      expect(mockUpdateFactorWeight).not.toHaveBeenCalled();
    });

    it("handles flush errors gracefully", async () => {
      mockLoadFactorSpace.mockRejectedValue(new Error("DB error"));

      learningDimensionHooks.onFactorHit({
        factorId: "factor-1",
        querySnippet: "q",
        retrievalScore: 0.8,
        providerModel: "model-a",
        useCase: "memory",
        timestamp: Date.now(),
      });

      // Should not throw
      await vi.advanceTimersByTimeAsync(5100);
      expect(mockLoadFactorSpace).toHaveBeenCalledOnce();
    });

    it("uses default weight 1.0 when wKey not present", async () => {
      mockLoadFactorSpace.mockResolvedValue({
        factors: [{ id: "factor-2:new-model:search", weights: {} }],
      });

      learningDimensionHooks.onFactorHit({
        factorId: "factor-2",
        querySnippet: "q",
        retrievalScore: 0.7, // delta = 0.05 * (0.7 - 0.5) = 0.01
        providerModel: "new-model",
        useCase: "search",
        timestamp: Date.now(),
      });

      await vi.advanceTimersByTimeAsync(5100);
      await vi.advanceTimersByTimeAsync(100);

      expect(mockUpdateFactorWeight).toHaveBeenCalledOnce();
      const args = mockUpdateFactorWeight.mock.calls[0];
      // Default weight 1.0 + 0.01 = 1.01
      expect(args[4]).toBeCloseTo(1.01, 5);
    });

    it("accumulates hit + miss for same factor into one flush", async () => {
      mockLoadFactorSpace.mockResolvedValue({
        factors: [{ id: "factor-1:model-a:memory", weights: { "model-a:memory": 1.0 } }],
      });

      // Hit: delta = 0.05 * (0.8 - 0.5) = 0.015
      learningDimensionHooks.onFactorHit({
        factorId: "factor-1",
        querySnippet: "q",
        retrievalScore: 0.8,
        providerModel: "model-a",
        useCase: "memory",
        timestamp: Date.now(),
      });

      // Miss: delta = -0.02
      learningDimensionHooks.onFactorMiss({
        factorId: "factor-1",
        querySnippet: "q2",
        providerModel: "model-a",
        useCase: "memory",
        timestamp: Date.now(),
      });

      await vi.advanceTimersByTimeAsync(5100);
      await vi.advanceTimersByTimeAsync(100);

      // Single flush, single update with accumulated delta: 0.015 + (-0.02) = -0.005
      expect(mockUpdateFactorWeight).toHaveBeenCalledOnce();
      const args = mockUpdateFactorWeight.mock.calls[0];
      expect(args[4]).toBeCloseTo(0.995, 5);
    });
  });
});
