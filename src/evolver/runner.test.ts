import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------- Mocks ----------

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockEvolveRun = vi.fn();
vi.mock("./evolve.js", () => ({
  run: (...args: unknown[]) => mockEvolveRun(...args),
}));

const mockCreateTmpdirSandbox = vi.fn();
const mockCleanupTmpdir = vi.fn();
vi.mock("./gep/sandbox-runner.js", () => ({
  createTmpdirSandbox: (...args: unknown[]) => mockCreateTmpdirSandbox(...args),
  cleanupTmpdir: (...args: unknown[]) => mockCleanupTmpdir(...args),
}));

const mockRunCodingAgentInSandbox = vi.fn();
vi.mock("./sandbox-agent.js", () => ({
  runCodingAgentInSandbox: (...args: unknown[]) => mockRunCodingAgentInSandbox(...args),
}));

const mockRunEvolverAcceptance = vi.fn();
vi.mock("./acceptance.js", () => ({
  runEvolverAcceptance: (...args: unknown[]) => mockRunEvolverAcceptance(...args),
}));

vi.mock("./evolver-review.js", () => ({
  writePendingReview: vi.fn(),
  readPendingReview: vi.fn(),
  clearPendingReview: vi.fn(),
}));

const mockCallGateway = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => mockCallGateway(...args),
}));

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
}));

const mockInitEvolverMemory = vi
  .fn()
  .mockResolvedValue({ dbPath: "/tmp/evolver_memory.sql", memoryManager: null });
const mockCloseEvolverMemory = vi.fn().mockResolvedValue(undefined);
const mockIndexCycleResult = vi.fn().mockResolvedValue(undefined);
const mockIndexAcceptanceResult = vi.fn().mockResolvedValue(undefined);
vi.mock("./evolver-memory.js", () => ({
  initEvolverMemory: (...args: unknown[]) => mockInitEvolverMemory(...args),
  closeEvolverMemory: (...args: unknown[]) => mockCloseEvolverMemory(...args),
  indexCycleResult: (...args: unknown[]) => mockIndexCycleResult(...args),
  indexAcceptanceResult: (...args: unknown[]) => mockIndexAcceptanceResult(...args),
}));

// Mock model resolution
const mockResolveConfiguredModelRef = vi
  .fn()
  .mockReturnValue({ provider: "anthropic", model: "claude-sonnet-4" });
vi.mock("../agents/model-selection.js", () => ({
  resolveConfiguredModelRef: (...args: unknown[]) => mockResolveConfiguredModelRef(...args),
}));

const mockResolveModel = vi.fn().mockReturnValue({
  model: { id: "claude-sonnet-4", provider: "anthropic" },
  error: undefined,
  authStorage: { setRuntimeApiKey: vi.fn() },
  modelRegistry: {},
});
vi.mock("../agents/pi-embedded-runner/model.js", () => ({
  resolveModel: (...args: unknown[]) => mockResolveModel(...args),
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: vi.fn().mockResolvedValue({ apiKey: "sk-test" }),
}));

vi.mock("../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: () => "/mock/agent-dir",
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({}),
}));

// Mock session factory — returns mock sessions
const mockSandboxSession = {
  prompt: vi.fn().mockResolvedValue(undefined),
  getLastAssistantText: vi.fn().mockReturnValue(""),
  abort: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn(),
};
const mockAcceptanceSession = {
  prompt: vi.fn().mockResolvedValue(undefined),
  getLastAssistantText: vi.fn().mockReturnValue(""),
  abort: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn(),
};
let sessionCreateCount = 0;
const mockCreateVersoSession = vi.fn().mockImplementation(() => {
  sessionCreateCount++;
  const session = sessionCreateCount === 1 ? mockSandboxSession : mockAcceptanceSession;
  return Promise.resolve({ session, sessionManager: {}, settingsManager: {}, extensionPaths: [] });
});
vi.mock("../agents/session-factory.js", () => ({
  createVersoSession: (...args: unknown[]) => mockCreateVersoSession(...args),
}));

// Mock SessionManager.inMemory()
vi.mock("@mariozechner/pi-coding-agent", () => ({
  SessionManager: { inMemory: vi.fn(() => ({ type: "in-memory" })) },
}));

// Mock tools
vi.mock("../agents/tools/web-search.js", () => ({ createWebSearchTool: () => null }));
vi.mock("../agents/tools/web-fetch.js", () => ({ createWebFetchTool: () => null }));
vi.mock("../agents/tools/memory-tool.js", () => ({
  createMemorySearchTool: () => null,
  createMemoryGetTool: () => null,
}));

const { runDaemonLoop } = await import("./runner.js");

// ---------- Tests ----------

describe("runner", () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  let mockExit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-test-"));
    vi.clearAllMocks();
    sessionCreateCount = 0;

    for (const key of [
      "VERSO_WORKSPACE",
      "OPENCLAW_WORKSPACE",
      "MEMORY_DIR",
      "EVOLVER_MODEL",
      "EVOLVER_AGENT_DIR",
      "EVOLVER_MAX_CYCLES_PER_PROCESS",
      "EVOLVER_MIN_SLEEP_MS",
      "EVOLVER_MAX_SLEEP_MS",
    ]) {
      savedEnv[key] = process.env[key];
    }

    // Force the loop to exit after one cycle
    process.env.EVOLVER_MAX_CYCLES_PER_PROCESS = "1";
    process.env.EVOLVER_MIN_SLEEP_MS = "0";
    process.env.EVOLVER_MAX_SLEEP_MS = "0";

    mockExit = vi.fn(() => {
      throw new Error("__EXIT__");
    }) as any;
    vi.stubGlobal("process", {
      ...process,
      exit: mockExit,
      env: process.env,
      memoryUsage: process.memoryUsage,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    vi.unstubAllGlobals();
  });

  async function runOneCycle(opts?: Partial<Parameters<typeof runDaemonLoop>[0]>) {
    await runDaemonLoop({ mode: "loop", workspace: tmpDir, ...opts }).catch((e: Error) => {
      if (!e.message.includes("__EXIT__")) throw e;
    });
  }

  describe("init phase", () => {
    it("creates 2 persistent sessions (sandbox + acceptance) at startup", async () => {
      mockEvolveRun.mockResolvedValue(null);

      await runOneCycle();

      // Two calls to createVersoSession: sandbox + acceptance
      expect(mockCreateVersoSession).toHaveBeenCalledTimes(2);
    });

    it("passes SessionManager.inMemory() to both sessions", async () => {
      mockEvolveRun.mockResolvedValue(null);

      await runOneCycle();

      for (const call of mockCreateVersoSession.mock.calls) {
        expect(call[0].sessionManager).toEqual({ type: "in-memory" });
      }
    });

    it("initializes evolver memory at daemon start", async () => {
      const fakeMemCtx = {
        dbPath: "/tmp/evolver_memory.sql",
        memoryManager: { search: vi.fn(), indexContent: vi.fn() },
      };
      mockInitEvolverMemory.mockResolvedValue(fakeMemCtx);
      mockEvolveRun.mockResolvedValue(null);

      await runOneCycle();

      expect(mockInitEvolverMemory).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceDir: tmpDir }),
      );
    });

    it("passes memoryManager to createVersoSession", async () => {
      const fakeMM = { search: vi.fn(), indexContent: vi.fn() };
      mockInitEvolverMemory.mockResolvedValue({ dbPath: "/tmp/x.sql", memoryManager: fakeMM });
      mockEvolveRun.mockResolvedValue(null);

      await runOneCycle();

      for (const call of mockCreateVersoSession.mock.calls) {
        expect(call[0].memoryManager).toBe(fakeMM);
      }
    });

    it("gracefully degrades when memory init fails", async () => {
      mockInitEvolverMemory.mockRejectedValue(new Error("DB corrupt"));
      mockEvolveRun.mockResolvedValue(null);
      mockCloseEvolverMemory.mockResolvedValue(undefined);

      await runOneCycle();

      expect(mockInitEvolverMemory).toHaveBeenCalled();
      // Sessions still created (with null memoryManager)
      expect(mockCreateVersoSession).toHaveBeenCalledTimes(2);
      for (const call of mockCreateVersoSession.mock.calls) {
        expect(call[0].memoryManager).toBeNull();
      }
    });
  });

  describe("cycle: sandbox agent", () => {
    it("passes persistent sandbox session to runCodingAgentInSandbox", async () => {
      const sandboxDir = path.join(tmpDir, "sandbox");
      fs.mkdirSync(sandboxDir, { recursive: true });

      mockEvolveRun.mockResolvedValue({ prompt: "test prompt", meta: {} });
      mockCreateTmpdirSandbox.mockReturnValue({ ok: true, sandboxDir });
      mockRunCodingAgentInSandbox.mockResolvedValue({ ok: true, filesChanged: ["a.ts"] });
      mockRunEvolverAcceptance.mockResolvedValue({
        passed: true,
        confidence: 90,
        reasoning: "good",
      });
      mockCallGateway.mockResolvedValue({});

      await runOneCycle();

      expect(mockRunCodingAgentInSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "test prompt",
          sandboxDir,
          session: mockSandboxSession,
        }),
      );
    });

    it("skips cycle when evolve.run returns null", async () => {
      mockEvolveRun.mockResolvedValue(null);

      await runOneCycle();

      expect(mockRunCodingAgentInSandbox).not.toHaveBeenCalled();
      expect(mockRunEvolverAcceptance).not.toHaveBeenCalled();
    });

    it("cleans up sandbox on agent failure", async () => {
      const sandboxDir = path.join(tmpDir, "sandbox");
      fs.mkdirSync(sandboxDir, { recursive: true });

      mockEvolveRun.mockResolvedValue({ prompt: "test", meta: {} });
      mockCreateTmpdirSandbox.mockReturnValue({ ok: true, sandboxDir });
      mockRunCodingAgentInSandbox.mockResolvedValue({
        ok: false,
        filesChanged: [],
        error: "timeout",
      });

      await runOneCycle();

      expect(mockCleanupTmpdir).toHaveBeenCalledWith(sandboxDir);
      expect(mockRunEvolverAcceptance).not.toHaveBeenCalled();
    });
  });

  describe("cycle: acceptance", () => {
    it("passes persistent acceptance session to runEvolverAcceptance", async () => {
      const sandboxDir = path.join(tmpDir, "sandbox");
      fs.mkdirSync(sandboxDir, { recursive: true });

      mockEvolveRun.mockResolvedValue({ prompt: "prompt", meta: {} });
      mockCreateTmpdirSandbox.mockReturnValue({ ok: true, sandboxDir });
      mockRunCodingAgentInSandbox.mockResolvedValue({ ok: true, filesChanged: ["a.ts"] });
      mockRunEvolverAcceptance.mockResolvedValue({
        passed: false,
        confidence: 30,
        reasoning: "bad",
      });
      mockCallGateway.mockResolvedValue({});

      await runOneCycle();

      expect(mockRunEvolverAcceptance).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceDir: sandboxDir,
          filesChanged: ["a.ts"],
          session: mockAcceptanceSession,
        }),
      );
    });
  });

  describe("cycle: memory indexing", () => {
    it("indexes cycle and acceptance results", async () => {
      const fakeMM = { search: vi.fn(), indexContent: vi.fn() };
      mockInitEvolverMemory.mockResolvedValue({ dbPath: "/tmp/x.sql", memoryManager: fakeMM });

      const sandboxDir = path.join(tmpDir, "sandbox");
      fs.mkdirSync(sandboxDir, { recursive: true });

      mockEvolveRun.mockResolvedValue({ prompt: "test prompt", meta: {} });
      mockCreateTmpdirSandbox.mockReturnValue({ ok: true, sandboxDir });
      mockRunCodingAgentInSandbox.mockResolvedValue({ ok: true, filesChanged: ["x.ts"] });
      mockRunEvolverAcceptance.mockResolvedValue({
        passed: true,
        confidence: 85,
        reasoning: "looks good",
      });
      mockCallGateway.mockResolvedValue({});

      await runOneCycle();

      expect(mockIndexCycleResult).toHaveBeenCalledWith(
        expect.objectContaining({
          memoryManager: fakeMM,
          cycleId: "1",
          ok: true,
          filesChanged: ["x.ts"],
        }),
      );
      expect(mockIndexAcceptanceResult).toHaveBeenCalledWith(
        expect.objectContaining({
          memoryManager: fakeMM,
          cycleId: "1",
          passed: true,
          confidence: 85,
        }),
      );
    });

    it("does not index when memory manager is null", async () => {
      mockInitEvolverMemory.mockResolvedValue({ dbPath: "/tmp/x.sql", memoryManager: null });

      const sandboxDir = path.join(tmpDir, "sandbox");
      fs.mkdirSync(sandboxDir, { recursive: true });

      mockEvolveRun.mockResolvedValue({ prompt: "prompt", meta: {} });
      mockCreateTmpdirSandbox.mockReturnValue({ ok: true, sandboxDir });
      mockRunCodingAgentInSandbox.mockResolvedValue({ ok: true, filesChanged: ["a.ts"] });
      mockRunEvolverAcceptance.mockResolvedValue({ passed: true, confidence: 80, reasoning: "ok" });
      mockCallGateway.mockResolvedValue({});

      await runOneCycle();

      expect(mockIndexCycleResult).not.toHaveBeenCalled();
      expect(mockIndexAcceptanceResult).not.toHaveBeenCalled();
    });
  });

  describe("exit phase", () => {
    it("closes evolver memory and disposes sessions on exit", async () => {
      const fakeMemCtx = { dbPath: "/tmp/x.sql", memoryManager: { search: vi.fn() } };
      mockInitEvolverMemory.mockResolvedValue(fakeMemCtx);
      mockEvolveRun.mockResolvedValue(null);

      await runOneCycle();

      expect(mockCloseEvolverMemory).toHaveBeenCalledWith(fakeMemCtx);
      expect(mockSandboxSession.dispose).toHaveBeenCalled();
      expect(mockAcceptanceSession.dispose).toHaveBeenCalled();
    });

    it("does not close memory when init failed", async () => {
      mockInitEvolverMemory.mockRejectedValue(new Error("DB corrupt"));
      mockEvolveRun.mockResolvedValue(null);

      await runOneCycle();

      expect(mockCloseEvolverMemory).not.toHaveBeenCalled();
    });
  });

  describe("helper logic", () => {
    // Test isPendingSolidify logic
    describe("isPendingSolidify", () => {
      it("last_run with run_id but no last_solidify → pending", () => {
        const state = { last_run: { run_id: "run_1" } };
        const lastRun = state.last_run;
        const lastSolid = (state as any).last_solidify ?? null;
        const pending =
          lastRun.run_id && (!lastSolid?.run_id || lastSolid.run_id !== lastRun.run_id);
        expect(!!pending).toBe(true);
      });

      it("matching run_ids → not pending", () => {
        const state = { last_run: { run_id: "run_1" }, last_solidify: { run_id: "run_1" } };
        const pending =
          state.last_run.run_id && state.last_solidify.run_id !== state.last_run.run_id;
        expect(!!pending).toBe(false);
      });

      it("different run_ids → pending", () => {
        const state = { last_run: { run_id: "run_2" }, last_solidify: { run_id: "run_1" } };
        const pending =
          state.last_run.run_id && state.last_solidify.run_id !== state.last_run.run_id;
        expect(!!pending).toBe(true);
      });
    });

    // Test parseMs logic
    describe("parseMs", () => {
      function parseMs(v: string | number | undefined | null, fallback: number): number {
        const n = parseInt(String(v == null ? "" : v), 10);
        return Number.isFinite(n) ? Math.max(0, n) : fallback;
      }

      it("parses a valid number string", () => {
        expect(parseMs("5000", 1000)).toBe(5000);
      });
      it("returns fallback for empty string", () => {
        expect(parseMs("", 1000)).toBe(1000);
      });
      it("returns fallback for undefined", () => {
        expect(parseMs(undefined, 2000)).toBe(2000);
      });
      it("returns fallback for null", () => {
        expect(parseMs(null, 3000)).toBe(3000);
      });
      it("clamps negative to 0", () => {
        expect(parseMs("-5", 1000)).toBe(0);
      });
      it("parses a number directly", () => {
        expect(parseMs(42, 1000)).toBe(42);
      });
      it("returns fallback for NaN", () => {
        expect(parseMs("notanumber", 500)).toBe(500);
      });
    });

    // Test deploySandboxToWorkspace logic
    describe("deploySandboxToWorkspace", () => {
      function deploySandboxToWorkspace(
        sandboxDir: string,
        workspace: string,
        filesChanged: string[],
      ): void {
        const DEPLOY_SKIP_PREFIXES = ["memory/", "memory\\"];
        for (const file of filesChanged) {
          if (DEPLOY_SKIP_PREFIXES.some((p) => file.startsWith(p))) continue;
          const src = path.join(sandboxDir, file);
          const dst = path.join(workspace, file);
          if (fs.existsSync(src) && fs.statSync(src).isFile()) {
            const dir = path.dirname(dst);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.copyFileSync(src, dst);
          }
        }
      }

      it("copies files from sandbox to workspace", () => {
        const sandbox = path.join(tmpDir, "sandbox");
        const workspace = path.join(tmpDir, "workspace");
        fs.mkdirSync(path.join(sandbox, "src"), { recursive: true });
        fs.mkdirSync(workspace, { recursive: true });
        fs.writeFileSync(path.join(sandbox, "src", "foo.ts"), "content");

        deploySandboxToWorkspace(sandbox, workspace, ["src/foo.ts"]);

        expect(fs.readFileSync(path.join(workspace, "src", "foo.ts"), "utf8")).toBe("content");
      });

      it("skips memory/ files", () => {
        const sandbox = path.join(tmpDir, "sandbox");
        const workspace = path.join(tmpDir, "workspace");
        fs.mkdirSync(path.join(sandbox, "memory"), { recursive: true });
        fs.mkdirSync(workspace, { recursive: true });
        fs.writeFileSync(path.join(sandbox, "memory", "data.json"), "secret");

        deploySandboxToWorkspace(sandbox, workspace, ["memory/data.json"]);

        expect(fs.existsSync(path.join(workspace, "memory", "data.json"))).toBe(false);
      });
    });
  });
});
