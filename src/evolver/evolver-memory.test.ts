import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------- Mocks ----------

const mockCreateIsolated = vi.fn();
vi.mock("../memory/manager.js", () => ({
  MemoryIndexManager: {
    createIsolated: (...args: unknown[]) => mockCreateIsolated(...args),
  },
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({ memory: {} }),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { initEvolverMemory, indexCycleResult, indexAcceptanceResult, closeEvolverMemory } =
  await import("./evolver-memory.js");

// ---------- Helpers ----------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evolver-mem-test-"));
  mockCreateIsolated.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeMockManager() {
  return {
    indexContent: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    search: vi.fn(),
  };
}

// ---------- Tests ----------

describe("initEvolverMemory", () => {
  it("creates memory dir and returns manager with correct dbPath", async () => {
    const mockManager = makeMockManager();
    mockCreateIsolated.mockResolvedValue(mockManager);

    const ctx = await initEvolverMemory({ workspaceDir: tmpDir });

    const expectedDbPath = path.join(tmpDir, "memory", "evolver_memory.sql");
    expect(ctx.dbPath).toBe(expectedDbPath);
    expect(fs.existsSync(path.dirname(expectedDbPath))).toBe(true);
    expect(ctx.memoryManager).toBe(mockManager);

    expect(mockCreateIsolated).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "evolver",
        workspaceDir: tmpDir,
        dbPath: expectedDbPath,
        sources: ["memory"],
      }),
    );
  });

  it("uses custom agentId when provided", async () => {
    mockCreateIsolated.mockResolvedValue(makeMockManager());

    await initEvolverMemory({ workspaceDir: tmpDir, agentId: "custom-agent" });

    expect(mockCreateIsolated).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "custom-agent" }),
    );
  });

  it("passes config to createIsolated", async () => {
    mockCreateIsolated.mockResolvedValue(makeMockManager());
    const fakeConfig = { memory: { enabled: true } } as any;

    await initEvolverMemory({ workspaceDir: tmpDir, config: fakeConfig });

    expect(mockCreateIsolated).toHaveBeenCalledWith(expect.objectContaining({ cfg: fakeConfig }));
  });

  it("returns null manager when createIsolated returns null", async () => {
    mockCreateIsolated.mockResolvedValue(null);

    const ctx = await initEvolverMemory({ workspaceDir: tmpDir });

    expect(ctx.memoryManager).toBeNull();
    expect(fs.existsSync(path.dirname(ctx.dbPath))).toBe(true);
  });

  it("returns null manager on error", async () => {
    mockCreateIsolated.mockRejectedValue(new Error("boom"));

    const ctx = await initEvolverMemory({ workspaceDir: tmpDir });

    expect(ctx.memoryManager).toBeNull();
    expect(ctx.dbPath).toBe(path.join(tmpDir, "memory", "evolver_memory.sql"));
  });
});

describe("indexCycleResult", () => {
  it("calls indexContent with correct format", async () => {
    const manager = makeMockManager();

    await indexCycleResult({
      memoryManager: manager as any,
      cycleId: "c-001",
      gepPrompt: "Improve error handling",
      filesChanged: ["src/foo.ts", "src/bar.ts"],
      agentOutput: "Refactored try-catch blocks",
      ok: true,
    });

    expect(manager.indexContent).toHaveBeenCalledOnce();
    const call = manager.indexContent.mock.calls[0]![0];
    expect(call.path).toBe("cycle/c-001");
    expect(call.content).toContain("# Evolution Cycle c-001");
    expect(call.content).toContain("Status: success");
    expect(call.content).toContain("Files: src/foo.ts, src/bar.ts");
    expect(call.content).toContain("GEP Prompt Summary:");
    expect(call.content).toContain("Improve error handling");
    expect(call.content).toContain("Refactored try-catch blocks");
  });

  it("formats fail status correctly", async () => {
    const manager = makeMockManager();

    await indexCycleResult({
      memoryManager: manager as any,
      cycleId: "c-002",
      filesChanged: [],
      agentOutput: "Failed to compile",
      ok: false,
    });

    const call = manager.indexContent.mock.calls[0]![0];
    expect(call.content).toContain("Status: failed");
    expect(call.content).toContain("Files: none");
    expect(call.content).not.toContain("GEP Prompt Summary:");
  });

  it("is a no-op when memoryManager is null", async () => {
    await indexCycleResult({
      memoryManager: null,
      cycleId: "c-003",
      filesChanged: [],
      agentOutput: "test",
      ok: true,
    });
  });

  it("does not throw on indexContent error", async () => {
    const manager = makeMockManager();
    manager.indexContent.mockRejectedValue(new Error("index failed"));

    await indexCycleResult({
      memoryManager: manager as any,
      cycleId: "c-004",
      filesChanged: [],
      agentOutput: "test",
      ok: true,
    });
  });
});

describe("indexAcceptanceResult", () => {
  it("calls indexContent with correct format", async () => {
    const manager = makeMockManager();

    await indexAcceptanceResult({
      memoryManager: manager as any,
      cycleId: "c-001",
      passed: true,
      confidence: 92,
      reasoning: "All tests pass and coverage improved",
      verifyCmd: "npm test",
      issues: ["[minor] Minor lint warning"],
    });

    expect(manager.indexContent).toHaveBeenCalledOnce();
    const call = manager.indexContent.mock.calls[0]![0];
    expect(call.path).toBe("acceptance/c-001");
    expect(call.content).toContain("# Acceptance c-001");
    expect(call.content).toContain("Passed: true (confidence: 92)");
    expect(call.content).toContain("Verify Command: npm test");
    expect(call.content).toContain("Reasoning: All tests pass and coverage improved");
    expect(call.content).toContain("- [minor] Minor lint warning");
  });

  it("omits optional fields when not provided", async () => {
    const manager = makeMockManager();

    await indexAcceptanceResult({
      memoryManager: manager as any,
      cycleId: "c-002",
      passed: false,
      confidence: 30,
      reasoning: "Build failed",
    });

    const call = manager.indexContent.mock.calls[0]![0];
    expect(call.content).not.toContain("Verify Command:");
    expect(call.content).not.toContain("Issues:");
    expect(call.content).toContain("Passed: false (confidence: 30)");
  });

  it("is a no-op when memoryManager is null", async () => {
    await indexAcceptanceResult({
      memoryManager: null,
      cycleId: "c-003",
      passed: true,
      confidence: 1,
      reasoning: "ok",
    });
  });

  it("does not throw on indexContent error", async () => {
    const manager = makeMockManager();
    manager.indexContent.mockRejectedValue(new Error("index failed"));

    await indexAcceptanceResult({
      memoryManager: manager as any,
      cycleId: "c-004",
      passed: true,
      confidence: 1,
      reasoning: "ok",
    });
  });
});

describe("closeEvolverMemory", () => {
  it("closes the memory manager", async () => {
    const manager = makeMockManager();

    await closeEvolverMemory({
      dbPath: path.join(tmpDir, "evolver_memory.sql"),
      memoryManager: manager as any,
    });

    expect(manager.close).toHaveBeenCalledOnce();
  });

  it("does not delete memory directory", async () => {
    const manager = makeMockManager();
    const memDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memDir, { recursive: true });

    await closeEvolverMemory({
      dbPath: path.join(memDir, "evolver_memory.sql"),
      memoryManager: manager as any,
    });

    expect(fs.existsSync(memDir)).toBe(true);
  });

  it("is a no-op when memoryManager is null", async () => {
    await closeEvolverMemory({
      dbPath: path.join(tmpDir, "evolver_memory.sql"),
      memoryManager: null,
    });
  });

  it("does not re-throw on close error (logs instead)", async () => {
    const manager = makeMockManager();
    manager.close.mockRejectedValue(new Error("close failed"));

    // Should not throw — new implementation logs instead
    await closeEvolverMemory({
      dbPath: path.join(tmpDir, "evolver_memory.sql"),
      memoryManager: manager as any,
    });
  });
});
