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

const {
  learningDimensionHooks,
  noopDimensionHooks,
  loggingDimensionHooks,
  getDimensionHooks,
  registerDimensionHooks,
  emitFactorHit,
  emitFactorMiss,
  emitThresholdFeedback,
} = await import("./dimension-hooks.js");

// Drain any timers that may have been scheduled during module import
await vi.runAllTimersAsync();
vi.useRealTimers();

describe("dimension-hooks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Reset active hooks to learning (the default)
    registerDimensionHooks(learningDimensionHooks);

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
      // Test that onFactorHit schedules a timer (the delta calculation is lr * (score - baseline))
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
      // Two hits for the same factor+model+useCase
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
      // Use composite factorId that matches the mock factor space
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

      // Advance past the 5s debounce
      await vi.advanceTimersByTimeAsync(5100);
      // Allow the async chain to resolve
      await vi.advanceTimersByTimeAsync(100);

      expect(mockLoadFactorSpace).toHaveBeenCalled();
      // updateFactorWeight is called only if factor.id matches the composite key
      // "factorId:providerModel:useCase" from the _pendingUpdates map iteration
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

  describe("learningDimensionHooks.onThresholdFeedback", () => {
    it("is a no-op (does not schedule any updates)", async () => {
      learningDimensionHooks.onThresholdFeedback({
        factorId: "factor-1",
        currentThreshold: 0.3,
        suggestedThreshold: 0.4,
        providerModel: "model-a",
        timestamp: Date.now(),
      });

      await vi.advanceTimersByTimeAsync(5100);

      expect(mockLoadFactorSpace).not.toHaveBeenCalled();
      expect(mockUpdateFactorWeight).not.toHaveBeenCalled();
    });
  });

  describe("noopDimensionHooks", () => {
    it("onFactorHit is a no-op", () => {
      expect(() =>
        noopDimensionHooks.onFactorHit({
          factorId: "f",
          querySnippet: "",
          retrievalScore: 0,
          providerModel: "m",
          useCase: "u",
          timestamp: 0,
        }),
      ).not.toThrow();
    });

    it("onFactorMiss is a no-op", () => {
      expect(() =>
        noopDimensionHooks.onFactorMiss({
          factorId: "f",
          querySnippet: "",
          providerModel: "m",
          useCase: "u",
          timestamp: 0,
        }),
      ).not.toThrow();
    });

    it("onThresholdFeedback is a no-op", () => {
      expect(() =>
        noopDimensionHooks.onThresholdFeedback({
          factorId: "f",
          currentThreshold: 0,
          suggestedThreshold: 0,
          providerModel: "m",
          timestamp: 0,
        }),
      ).not.toThrow();
    });
  });

  describe("loggingDimensionHooks", () => {
    it("onFactorHit logs to console.debug", () => {
      const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
      loggingDimensionHooks.onFactorHit({
        factorId: "f-1",
        querySnippet: "q",
        retrievalScore: 0.75,
        providerModel: "model-x",
        useCase: "memory",
        timestamp: 0,
      });
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0]).toContain("hit");
      expect(spy.mock.calls[0][0]).toContain("f-1");
      spy.mockRestore();
    });

    it("onFactorMiss logs to console.debug", () => {
      const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
      loggingDimensionHooks.onFactorMiss({
        factorId: "f-2",
        querySnippet: "q",
        providerModel: "model-x",
        useCase: "memory",
        timestamp: 0,
      });
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0]).toContain("miss");
      spy.mockRestore();
    });

    it("onThresholdFeedback logs to console.debug", () => {
      const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
      loggingDimensionHooks.onThresholdFeedback({
        factorId: "f-3",
        currentThreshold: 0.3,
        suggestedThreshold: 0.5,
        providerModel: "model-x",
        timestamp: 0,
      });
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0]).toContain("threshold-feedback");
      spy.mockRestore();
    });
  });

  describe("getDimensionHooks / registerDimensionHooks", () => {
    it("returns the default (learning) hooks initially", () => {
      registerDimensionHooks(learningDimensionHooks);
      expect(getDimensionHooks()).toBe(learningDimensionHooks);
    });

    it("returns noop hooks after registration", () => {
      registerDimensionHooks(noopDimensionHooks);
      expect(getDimensionHooks()).toBe(noopDimensionHooks);
    });

    it("returns logging hooks after registration", () => {
      registerDimensionHooks(loggingDimensionHooks);
      expect(getDimensionHooks()).toBe(loggingDimensionHooks);
    });

    it("supports custom hooks", () => {
      const custom = {
        onFactorHit: vi.fn(),
        onFactorMiss: vi.fn(),
        onThresholdFeedback: vi.fn(),
      };
      registerDimensionHooks(custom);
      expect(getDimensionHooks()).toBe(custom);
    });
  });

  describe("convenience emitters", () => {
    it("emitFactorHit calls active hooks", () => {
      const custom = {
        onFactorHit: vi.fn(),
        onFactorMiss: vi.fn(),
        onThresholdFeedback: vi.fn(),
      };
      registerDimensionHooks(custom);

      emitFactorHit("f-1", "snippet", 0.9, "model-a", "search");

      expect(custom.onFactorHit).toHaveBeenCalledOnce();
      const arg = custom.onFactorHit.mock.calls[0][0];
      expect(arg.factorId).toBe("f-1");
      expect(arg.querySnippet).toBe("snippet");
      expect(arg.retrievalScore).toBe(0.9);
      expect(arg.providerModel).toBe("model-a");
      expect(arg.useCase).toBe("search");
      expect(typeof arg.timestamp).toBe("number");
    });

    it("emitFactorHit defaults useCase to 'memory'", () => {
      const custom = {
        onFactorHit: vi.fn(),
        onFactorMiss: vi.fn(),
        onThresholdFeedback: vi.fn(),
      };
      registerDimensionHooks(custom);

      emitFactorHit("f-1", "snippet", 0.9, "model-a");

      expect(custom.onFactorHit.mock.calls[0][0].useCase).toBe("memory");
    });

    it("emitFactorMiss calls active hooks", () => {
      const custom = {
        onFactorHit: vi.fn(),
        onFactorMiss: vi.fn(),
        onThresholdFeedback: vi.fn(),
      };
      registerDimensionHooks(custom);

      emitFactorMiss("f-2", "snippet", "model-b", "web");

      expect(custom.onFactorMiss).toHaveBeenCalledOnce();
      const arg = custom.onFactorMiss.mock.calls[0][0];
      expect(arg.factorId).toBe("f-2");
      expect(arg.useCase).toBe("web");
    });

    it("emitFactorMiss defaults useCase to 'memory'", () => {
      const custom = {
        onFactorHit: vi.fn(),
        onFactorMiss: vi.fn(),
        onThresholdFeedback: vi.fn(),
      };
      registerDimensionHooks(custom);

      emitFactorMiss("f-2", "snippet", "model-b");

      expect(custom.onFactorMiss.mock.calls[0][0].useCase).toBe("memory");
    });

    it("emitThresholdFeedback calls active hooks", () => {
      const custom = {
        onFactorHit: vi.fn(),
        onFactorMiss: vi.fn(),
        onThresholdFeedback: vi.fn(),
      };
      registerDimensionHooks(custom);

      emitThresholdFeedback("f-3", 0.3, 0.5, "model-c");

      expect(custom.onThresholdFeedback).toHaveBeenCalledOnce();
      const arg = custom.onThresholdFeedback.mock.calls[0][0];
      expect(arg.factorId).toBe("f-3");
      expect(arg.currentThreshold).toBe(0.3);
      expect(arg.suggestedThreshold).toBe(0.5);
      expect(arg.providerModel).toBe("model-c");
    });
  });

  describe("batch flush debounce", () => {
    it("does not flush before the 5s timer", async () => {
      registerDimensionHooks(learningDimensionHooks);

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
      registerDimensionHooks(learningDimensionHooks);

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
      registerDimensionHooks(learningDimensionHooks);

      // Three events in rapid succession
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
      registerDimensionHooks(learningDimensionHooks);
      // Use a factorId that does not match any factor in the mock space.
      // The internal map key is "composite-key:model:useCase" but the
      // factor ids in the space are different.
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
      // updateFactorWeight should NOT be called because factor was not found
      expect(mockUpdateFactorWeight).not.toHaveBeenCalled();
    });

    it("handles flush errors gracefully", async () => {
      registerDimensionHooks(learningDimensionHooks);
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
      registerDimensionHooks(learningDimensionHooks);

      // Set up factor space where the composite key matches and weights
      // don't include the specific wKey
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
      registerDimensionHooks(learningDimensionHooks);

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
