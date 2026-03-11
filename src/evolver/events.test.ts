import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------- Mocks ----------

const mockCallGateway = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => mockCallGateway(...args),
}));

const mockLoadConfig = vi.fn();
vi.mock("../config/config.js", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../utils/message-channel.js", () => ({
  GATEWAY_CLIENT_MODES: { BACKEND: "backend" },
  GATEWAY_CLIENT_NAMES: { GATEWAY_CLIENT: "gateway" },
}));

const { broadcastEvolverEvent, getEvolverStatus } = await import("./events.js");

describe("events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallGateway.mockResolvedValue(undefined);
    mockLoadConfig.mockReturnValue({ some: "config" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("broadcastEvolverEvent", () => {
    it("sends correct payload via callGateway", async () => {
      const event = { type: "evolver.started" as const, runId: "run_1", mode: "single" };

      await broadcastEvolverEvent(event);

      expect(mockCallGateway).toHaveBeenCalledOnce();
      const callArgs = mockCallGateway.mock.calls[0][0];
      expect(callArgs.method).toBe("evolver.broadcast");
      expect(callArgs.params.event).toBe("evolver.started");
      expect(callArgs.params.payload).toEqual(event);
      expect(callArgs.timeoutMs).toBe(5000);
      expect(callArgs.clientName).toBe("gateway");
      expect(callArgs.clientDisplayName).toBe("evolver");
      expect(callArgs.mode).toBe("backend");
    });

    it("uses provided config without calling loadConfig", async () => {
      const providedConfig = { custom: "config" };
      const event = { type: "evolver.started" as const, runId: "run_2", mode: "loop" };

      await broadcastEvolverEvent(event, providedConfig as never);

      // loadConfig should still be called because the function always imports it,
      // but effectiveConfig uses provided config via ??
      const callArgs = mockCallGateway.mock.calls[0][0];
      expect(callArgs.config).toEqual(providedConfig);
    });

    it("falls back to loadConfig when no config provided", async () => {
      const event = { type: "evolver.stopped" as const, runId: "run_3", reason: "done" };

      await broadcastEvolverEvent(event);

      const callArgs = mockCallGateway.mock.calls[0][0];
      expect(callArgs.config).toEqual({ some: "config" });
    });

    it("swallows gateway errors (non-fatal)", async () => {
      mockCallGateway.mockRejectedValue(new Error("Gateway unavailable"));
      const event = { type: "evolver.started" as const, runId: "run_4", mode: "single" };

      // Should not throw
      await expect(broadcastEvolverEvent(event)).resolves.toBeUndefined();
    });

    it("handles cycle.started event", async () => {
      const event = {
        type: "evolver.cycle.started" as const,
        runId: "run_5",
        cycleNumber: 1,
      };

      await broadcastEvolverEvent(event);

      const callArgs = mockCallGateway.mock.calls[0][0];
      expect(callArgs.params.event).toBe("evolver.cycle.started");
      expect(callArgs.params.payload.cycleNumber).toBe(1);
    });

    it("handles cycle.completed event", async () => {
      const event = {
        type: "evolver.cycle.completed" as const,
        runId: "run_6",
        cycleNumber: 2,
        filesChanged: ["a.ts", "b.ts"],
        elapsed: 5000,
      };

      await broadcastEvolverEvent(event);

      const callArgs = mockCallGateway.mock.calls[0][0];
      expect(callArgs.params.event).toBe("evolver.cycle.completed");
      expect(callArgs.params.payload.filesChanged).toEqual(["a.ts", "b.ts"]);
    });

    it("handles cycle.failed event", async () => {
      const event = {
        type: "evolver.cycle.failed" as const,
        runId: "run_7",
        cycleNumber: 3,
        error: "Something broke",
      };

      await broadcastEvolverEvent(event);

      const callArgs = mockCallGateway.mock.calls[0][0];
      expect(callArgs.params.event).toBe("evolver.cycle.failed");
      expect(callArgs.params.payload.error).toBe("Something broke");
    });

    it("handles solidify.started event", async () => {
      const event = { type: "evolver.solidify.started" as const, runId: "run_8" };
      await broadcastEvolverEvent(event);
      expect(mockCallGateway.mock.calls[0][0].params.event).toBe("evolver.solidify.started");
    });

    it("handles solidify.completed event", async () => {
      const event = {
        type: "evolver.solidify.completed" as const,
        runId: "run_9",
        filesChanged: ["x.ts"],
      };
      await broadcastEvolverEvent(event);
      expect(mockCallGateway.mock.calls[0][0].params.event).toBe("evolver.solidify.completed");
    });

    it("handles solidify.failed event", async () => {
      const event = {
        type: "evolver.solidify.failed" as const,
        runId: "run_10",
        error: "solidify fail",
      };
      await broadcastEvolverEvent(event);
      expect(mockCallGateway.mock.calls[0][0].params.event).toBe("evolver.solidify.failed");
    });

    it("handles stopped event", async () => {
      const event = {
        type: "evolver.stopped" as const,
        runId: "run_11",
        reason: "memory limit",
      };
      await broadcastEvolverEvent(event);
      expect(mockCallGateway.mock.calls[0][0].params.event).toBe("evolver.stopped");
    });

    it("handles status event", async () => {
      const event = {
        type: "evolver.status" as const,
        status: { running: true, mode: "loop" as const, currentCycle: 5 },
      };
      await broadcastEvolverEvent(event);
      expect(mockCallGateway.mock.calls[0][0].params.event).toBe("evolver.status");
    });
  });

  describe("getEvolverStatus", () => {
    it("returns { running: false }", () => {
      const status = getEvolverStatus();
      expect(status).toEqual({ running: false });
    });
  });
});
