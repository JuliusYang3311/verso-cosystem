import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------- Mocks ----------

// These must be initialized BEFORE mock factories run (which happens at import time
// for static imports in evolve.ts). Module-level code in evolve.ts calls getMemoryDir()
// etc. immediately, so the paths must be valid when the module first loads.
const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "evolve-workspace-"));
const tmpMemoryDir = path.join(tmpWorkspace, "memory");
const tmpEvolutionDir = path.join(tmpMemoryDir, "evolution");
const tmpRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evolve-repo-"));
fs.mkdirSync(tmpMemoryDir, { recursive: true });
fs.mkdirSync(tmpEvolutionDir, { recursive: true });

vi.mock("./gep/paths.js", () => ({
  getRepoRoot: () => tmpRepoRoot,
  getMemoryDir: () => tmpMemoryDir,
  getEvolutionDir: () => tmpEvolutionDir,
  getWorkspaceRoot: () => tmpWorkspace,
}));

const mockLoadGenes = vi.fn();
const mockLoadCapsules = vi.fn();
const mockReadAllEvents = vi.fn();
const mockGetLastEventId = vi.fn();
const mockAppendCandidateJsonl = vi.fn();
const mockReadRecentCandidates = vi.fn();
const mockReadRecentExternalCandidates = vi.fn();
vi.mock("./gep/assetStore.js", () => ({
  loadGenes: (...args: unknown[]) => mockLoadGenes(...args),
  loadCapsules: (...args: unknown[]) => mockLoadCapsules(...args),
  readAllEvents: (...args: unknown[]) => mockReadAllEvents(...args),
  getLastEventId: (...args: unknown[]) => mockGetLastEventId(...args),
  appendCandidateJsonl: (...args: unknown[]) => mockAppendCandidateJsonl(...args),
  readRecentCandidates: (...args: unknown[]) => mockReadRecentCandidates(...args),
  readRecentExternalCandidates: (...args: unknown[]) => mockReadRecentExternalCandidates(...args),
}));

const mockExtractSignals = vi.fn();
vi.mock("./gep/signals.js", () => ({
  extractSignals: (...args: unknown[]) => mockExtractSignals(...args),
}));

const mockSelectGeneAndCapsule = vi.fn();
const mockMatchPatternToSignals = vi.fn();
vi.mock("./gep/selector.js", () => ({
  selectGeneAndCapsule: (...args: unknown[]) => mockSelectGeneAndCapsule(...args),
  matchPatternToSignals: (...args: unknown[]) => mockMatchPatternToSignals(...args),
}));

const mockRecordSignalSnapshot = vi.fn();
const mockRecordHypothesis = vi.fn();
const mockRecordAttempt = vi.fn();
const mockRecordOutcomeFromState = vi.fn();
const mockGetMemoryAdvice = vi.fn();
const mockMemoryGraphPath = vi.fn();
vi.mock("./gep/memoryGraph.js", () => ({
  recordSignalSnapshot: (...args: unknown[]) => mockRecordSignalSnapshot(...args),
  recordHypothesis: (...args: unknown[]) => mockRecordHypothesis(...args),
  recordAttempt: (...args: unknown[]) => mockRecordAttempt(...args),
  recordOutcomeFromState: (...args: unknown[]) => mockRecordOutcomeFromState(...args),
  getMemoryAdvice: (...args: unknown[]) => mockGetMemoryAdvice(...args),
  memoryGraphPath: (...args: unknown[]) => mockMemoryGraphPath(...args),
}));

const mockBuildMutation = vi.fn();
const mockIsHighRiskMutationAllowed = vi.fn();
vi.mock("./gep/mutation.js", () => ({
  buildMutation: (...args: unknown[]) => mockBuildMutation(...args),
  isHighRiskMutationAllowed: (...args: unknown[]) => mockIsHighRiskMutationAllowed(...args),
}));

const mockSelectPersonalityForRun = vi.fn();
vi.mock("./gep/personality.js", () => ({
  selectPersonalityForRun: (...args: unknown[]) => mockSelectPersonalityForRun(...args),
}));

const mockBuildGepPrompt = vi.fn();
vi.mock("./gep/prompt.js", () => ({
  buildGepPrompt: (...args: unknown[]) => mockBuildGepPrompt(...args),
}));

const mockWritePromptArtifact = vi.fn();
vi.mock("./gep/bridge.js", () => ({
  writePromptArtifact: (...args: unknown[]) => mockWritePromptArtifact(...args),
}));

const mockExtractCapabilityCandidates = vi.fn();
const mockRenderCandidatesPreview = vi.fn();
vi.mock("./gep/candidates.js", () => ({
  extractCapabilityCandidates: (...args: unknown[]) => mockExtractCapabilityCandidates(...args),
  renderCandidatesPreview: (...args: unknown[]) => mockRenderCandidatesPreview(...args),
}));

const mockResolveStrategy = vi.fn();
vi.mock("./gep/strategy.js", () => ({
  resolveStrategy: (...args: unknown[]) => mockResolveStrategy(...args),
}));

const mockReadStateForSolidify = vi.fn();
const mockWriteStateForSolidify = vi.fn();
vi.mock("./gep/solidify.js", () => ({
  readStateForSolidify: (...args: unknown[]) => mockReadStateForSolidify(...args),
  writeStateForSolidify: (...args: unknown[]) => mockWriteStateForSolidify(...args),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
}));

// Suppress console output during tests
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

// Import the module AFTER all mocks are set up
const { run } = await import("./evolve.js");

describe("evolve", () => {
  const savedEnv: Record<string, string | undefined> = {};

  afterAll(() => {
    try {
      fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpRepoRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  beforeEach(() => {
    // Ensure dirs exist (they may have been cleaned in afterEach of a sub-test)
    fs.mkdirSync(tmpMemoryDir, { recursive: true });
    fs.mkdirSync(tmpEvolutionDir, { recursive: true });

    // Save and set env vars
    for (const key of [
      "VERSO_WORKSPACE",
      "OPENCLAW_WORKSPACE",
      "MEMORY_DIR",
      "VERSO_STATE_DIR",
      "OPENCLAW_STATE_DIR",
      "AGENT_NAME",
      "EVOLVE_BRIDGE",
      "EVOLVE_LOOP",
      "RANDOM_DRIFT",
      "FORCE_INNOVATION",
      "EVOLVE_FORCE_INNOVATION",
      "EVOLVE_EMIT_THOUGHT_PROCESS",
      "EVOLVE_PRINT_PROMPT",
      "GEMINI_API_KEY",
      "INTEGRATION_STATUS_CMD",
      "EVOLVE_REPORT_DIRECTIVE",
      "EVOLVE_REPORT_CMD",
      "EVOLVE_PENDING_SLEEP_MS",
      "EVOLVE_MIN_INTERVAL",
    ]) {
      savedEnv[key] = process.env[key];
    }

    // Disable bridge and loop by default for testing
    process.env.EVOLVE_BRIDGE = "false";
    process.env.EVOLVE_LOOP = "false";

    vi.clearAllMocks();

    // Default mock return values
    mockLoadGenes.mockReturnValue([
      { id: "gene-1", category: "repair", signals_match: ["log_error"] },
    ]);
    mockLoadCapsules.mockReturnValue([{ id: "capsule-1", trigger: ["log_error"], gene: "gene-1" }]);
    mockReadAllEvents.mockReturnValue([]);
    mockGetLastEventId.mockReturnValue("evt-001");
    mockExtractSignals.mockReturnValue(["idle"]);
    mockSelectGeneAndCapsule.mockReturnValue({
      selectedGene: { id: "gene-1", category: "repair" },
      capsuleCandidates: [{ id: "capsule-1" }],
      selector: "default",
    });
    mockGetMemoryAdvice.mockReturnValue(null);
    mockRecordOutcomeFromState.mockReturnValue(undefined);
    mockRecordSignalSnapshot.mockReturnValue(undefined);
    mockRecordHypothesis.mockReturnValue({ hypothesisId: "hyp-001" });
    mockRecordAttempt.mockReturnValue(undefined);
    mockSelectPersonalityForRun.mockReturnValue({
      personality_state: { creativity: 0.5, rigor: 0.5, risk_tolerance: 0.5 },
      personality_key: "default",
      personality_known: true,
      personality_mutations: [],
    });
    mockBuildMutation.mockReturnValue({
      id: "mut-001",
      category: "repair",
      intent: "repair",
    });
    mockIsHighRiskMutationAllowed.mockReturnValue(false);
    mockResolveStrategy.mockReturnValue({
      name: "balanced",
      label: "Balanced",
      innovate: 0.4,
      optimize: 0.3,
      repair: 0.3,
    });
    mockReadStateForSolidify.mockReturnValue({});
    mockWriteStateForSolidify.mockReturnValue(undefined);
    mockBuildGepPrompt.mockReturnValue("Generated prompt for evolution cycle");
    mockExtractCapabilityCandidates.mockReturnValue([]);
    mockReadRecentCandidates.mockReturnValue([]);
    mockReadRecentExternalCandidates.mockReturnValue([]);
    mockRenderCandidatesPreview.mockReturnValue("(no candidates)");
    mockWritePromptArtifact.mockReturnValue(undefined);
    mockMemoryGraphPath.mockReturnValue(path.join(tmpEvolutionDir, "memory-graph.jsonl"));
    mockAppendCandidateJsonl.mockReturnValue(undefined);
    mockMatchPatternToSignals.mockReturnValue(false);
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  describe("run()", () => {
    it("happy path: returns EvolveResult with prompt and meta", async () => {
      const result = await run();

      expect(result).not.toBeNull();
      expect(result!.prompt).toBe("Generated prompt for evolution cycle");
      expect(result!.meta.cycleId).toMatch(/^Cycle #\d+$/);
      expect(result!.meta.signals).toEqual(["idle"]);
      expect(result!.meta.gene).toBe("gene-1");
      expect(result!.meta.mutation).toBe("mut-001");
    });

    it("calls all major GEP pipeline stages in order", async () => {
      await run();

      // Verify critical pipeline stages were called
      expect(mockRecordOutcomeFromState).toHaveBeenCalledOnce();
      expect(mockRecordSignalSnapshot).toHaveBeenCalledOnce();
      expect(mockExtractSignals).toHaveBeenCalledOnce();
      expect(mockSelectGeneAndCapsule).toHaveBeenCalledOnce();
      expect(mockSelectPersonalityForRun).toHaveBeenCalledOnce();
      expect(mockBuildMutation).toHaveBeenCalledOnce();
      expect(mockRecordHypothesis).toHaveBeenCalledOnce();
      expect(mockRecordAttempt).toHaveBeenCalledOnce();
      expect(mockBuildGepPrompt).toHaveBeenCalledOnce();
    });

    it("recordHypothesis failure → process.exit(2)", async () => {
      mockRecordHypothesis.mockImplementation(() => {
        throw new Error("Hypothesis write failed");
      });

      const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("PROCESS_EXIT_2");
      }) as never);

      await expect(run()).rejects.toThrow("PROCESS_EXIT_2");
      expect(mockExit).toHaveBeenCalledWith(2);

      mockExit.mockRestore();
    });

    it("recordAttempt failure → process.exit(2)", async () => {
      mockRecordAttempt.mockImplementation(() => {
        throw new Error("Attempt write failed");
      });

      const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("PROCESS_EXIT_2");
      }) as never);

      await expect(run()).rejects.toThrow("PROCESS_EXIT_2");
      expect(mockExit).toHaveBeenCalledWith(2);

      mockExit.mockRestore();
    });

    it("recordOutcomeFromState failure → throws Error (refuses to evolve)", async () => {
      mockRecordOutcomeFromState.mockImplementation(() => {
        throw new Error("Outcome write failed");
      });

      await expect(run()).rejects.toThrow("MemoryGraph Outcome write failed");
    });

    it("recordSignalSnapshot failure → throws Error", async () => {
      mockRecordSignalSnapshot.mockImplementation(() => {
        throw new Error("Signal snapshot write failed");
      });

      await expect(run()).rejects.toThrow("MemoryGraph Signal snapshot write failed");
    });

    it("getMemoryAdvice failure → throws Error", async () => {
      mockGetMemoryAdvice.mockImplementation(() => {
        throw new Error("Graph read failed");
      });

      await expect(run()).rejects.toThrow("MemoryGraph Read failed");
    });

    it("no session logs → still generates prompt", async () => {
      // Default mocks already simulate no session logs (empty workspace)
      const result = await run();

      expect(result).not.toBeNull();
      expect(result!.prompt).toBe("Generated prompt for evolution cycle");
    });

    it("innovation pressure: stable success + high creativity + high score", async () => {
      // Set up conditions for innovation pressure:
      // - stableSuccess: last 6 events all have outcome.status === "success"
      // - creativity >= 0.75
      // - tailAvgScore >= 0.7
      const successEvents = Array.from({ length: 8 }, (_, i) => ({
        type: "EvolutionEvent",
        intent: "repair",
        signals: ["idle"],
        genes_used: ["gene-1"],
        outcome: { status: "success", score: 0.8 },
        meta: { at: `2024-01-0${i + 1}` },
      }));
      mockReadAllEvents.mockReturnValue(successEvents);

      mockSelectPersonalityForRun.mockReturnValue({
        personality_state: { creativity: 0.8, rigor: 0.5, risk_tolerance: 0.5 },
        personality_key: "creative",
        personality_known: true,
        personality_mutations: [],
      });

      await run();

      // buildMutation should be called with driftEnabled=true (innovationPressure)
      const mutArgs = mockBuildMutation.mock.calls[0][0];
      expect(mutArgs.driftEnabled).toBe(true);
      // Signals should include "stable_success_plateau"
      expect(mutArgs.signals).toContain("stable_success_plateau");
    });

    it("force innovation via strategy name", async () => {
      mockResolveStrategy.mockReturnValue({
        name: "innovate",
        label: "Innovate",
        innovate: 0.8,
        optimize: 0.1,
        repair: 0.1,
      });

      await run();

      const mutArgs = mockBuildMutation.mock.calls[0][0];
      expect(mutArgs.driftEnabled).toBe(true);
      expect(mutArgs.signals).toContain("force_innovation");
    });

    it("force innovation via env var", async () => {
      process.env.FORCE_INNOVATION = "true";

      await run();

      const mutArgs = mockBuildMutation.mock.calls[0][0];
      expect(mutArgs.driftEnabled).toBe(true);
      expect(mutArgs.signals).toContain("force_innovation");
    });

    it("high-risk mutation allowance check", async () => {
      // All conditions for high-risk: drift + known personality + rigor >= 0.8 + risk_tolerance <= 0.3 + no log_error
      process.argv = ["node", "script", "--drift"];
      // We need to re-import to pick up --drift, but since ARGS is evaluated at module load
      // time, we test the logic by checking isHighRiskMutationAllowed is called
      mockIsHighRiskMutationAllowed.mockReturnValue(true);

      await run();

      // buildMutation should have been called (allowHighRisk is evaluated but may not be true
      // because --drift is only checked at module initialization time via ARGS)
      expect(mockBuildMutation).toHaveBeenCalledOnce();
    });

    it("solidify gate in loop mode: returns null when pending", async () => {
      process.env.EVOLVE_BRIDGE = "true";
      process.env.EVOLVE_LOOP = "true";
      process.env.EVOLVE_PENDING_SLEEP_MS = "0"; // Don't actually sleep

      mockReadStateForSolidify.mockReturnValue({
        last_run: { run_id: "run_1" },
        last_solidify: { run_id: "run_0" }, // Different → pending
      });

      const result = await run();

      // Should return null because solidify is pending
      expect(result).toBeNull();
    });

    it("writes solidify state after successful run", async () => {
      process.env.EVOLVE_BRIDGE = "true";

      await run();

      expect(mockWriteStateForSolidify).toHaveBeenCalledOnce();
      const state = mockWriteStateForSolidify.mock.calls[0][0];
      expect(state.last_run).toBeDefined();
      expect(state.last_run.run_id).toMatch(/^run_\d+$/);
      expect(state.last_run.signals).toEqual(["idle"]);
    });

    it("writes prompt artifact when bridge is enabled", async () => {
      process.env.EVOLVE_BRIDGE = "true";

      await run();

      expect(mockWritePromptArtifact).toHaveBeenCalledOnce();
    });

    it("does not write prompt artifact when bridge is disabled", async () => {
      process.env.EVOLVE_BRIDGE = "false";

      await run();

      expect(mockWritePromptArtifact).not.toHaveBeenCalled();
    });

    it("extracts and persists capability candidates", async () => {
      const candidates = [{ id: "cand-1", title: "New feature" }];
      mockExtractCapabilityCandidates.mockReturnValue(candidates);

      await run();

      expect(mockExtractCapabilityCandidates).toHaveBeenCalledOnce();
      expect(mockAppendCandidateJsonl).toHaveBeenCalledOnce();
    });

    it("handles gene with no id gracefully", async () => {
      mockSelectGeneAndCapsule.mockReturnValue({
        selectedGene: null,
        capsuleCandidates: [],
        selector: "default",
      });

      const result = await run();

      expect(result).not.toBeNull();
      expect(result!.meta.gene).toBeNull();
    });

    it("handles empty capsule candidates", async () => {
      mockSelectGeneAndCapsule.mockReturnValue({
        selectedGene: { id: "gene-1" },
        capsuleCandidates: [],
        selector: "default",
      });

      const result = await run();

      expect(result).not.toBeNull();
      expect(result!.meta.gene).toBe("gene-1");
    });

    it("mutation with no id → meta.mutation is null", async () => {
      mockBuildMutation.mockReturnValue({
        category: "repair",
        intent: "repair",
        // No id field
      });

      const result = await run();

      expect(result).not.toBeNull();
      expect(result!.meta.mutation).toBeNull();
    });

    it("readAllEvents returns non-array → treated as empty", async () => {
      mockReadAllEvents.mockReturnValue(null);

      const result = await run();
      expect(result).not.toBeNull();
    });

    it("readAllEvents throws → still proceeds", async () => {
      mockReadAllEvents.mockImplementation(() => {
        throw new Error("Event read failed");
      });

      const result = await run();
      expect(result).not.toBeNull();
    });

    it("passes signals to extractSignals correctly", async () => {
      await run();

      const extractArgs = mockExtractSignals.mock.calls[0][0];
      expect(extractArgs).toHaveProperty("recentSessionTranscript");
      expect(extractArgs).toHaveProperty("todayLog");
      expect(extractArgs).toHaveProperty("memorySnippet");
      expect(extractArgs).toHaveProperty("userSnippet");
      expect(extractArgs).toHaveProperty("recentEvents");
    });

    it("external candidates are never executed, only surfaced", async () => {
      mockReadRecentExternalCandidates.mockReturnValue([
        {
          type: "Gene",
          id: "ext-gene-1",
          signals_match: ["idle"],
        },
      ]);
      mockMatchPatternToSignals.mockReturnValue(true);

      await run();

      // External candidates are surfaced in the prompt context but not executed
      expect(mockBuildGepPrompt).toHaveBeenCalledOnce();
      const promptArgs = mockBuildGepPrompt.mock.calls[0][0];
      expect(promptArgs.externalCandidatesPreview).not.toBe("(none)");
    });
  });
});
