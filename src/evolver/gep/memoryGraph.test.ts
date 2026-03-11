import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let tmpDir: string;
let tmpEvoDir: string;

vi.mock("./paths.js", () => ({
  getEvolutionDir: () => tmpEvoDir,
  getMemoryDir: () => tmpDir,
  getWorkspaceRoot: () => tmpDir,
  getGepAssetsDir: () => tmpDir,
  getEvolverAssetsDir: () => tmpDir,
  getRepoRoot: () => process.cwd(),
}));

import {
  computeSignalKey,
  recordSignalSnapshot,
  recordHypothesis,
  recordAttempt,
  recordOutcomeFromState,
  getMemoryAdvice,
  tryReadMemoryGraphEvents,
} from "./memoryGraph.js";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memgraph-test-"));
  tmpEvoDir = path.join(tmpDir, "evolution");
  fs.mkdirSync(tmpEvoDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("computeSignalKey", () => {
  it("returns (none) for empty signals", () => {
    expect(computeSignalKey([])).toBe("(none)");
  });

  it("returns sorted, deduped signals joined by pipe", () => {
    const key = computeSignalKey(["b_signal", "a_signal", "b_signal"]);
    expect(key).toBe("a_signal|b_signal");
  });

  it("normalizes error signatures", () => {
    const key1 = computeSignalKey(["errsig:Error at /path/to/file.ts:42"]);
    const key2 = computeSignalKey(["errsig:Error at /different/path.ts:99"]);
    // Both should have errsig_norm: prefix after normalization
    expect(key1).toMatch(/^errsig_norm:/);
    // Same error pattern with different paths/numbers should produce same key
    expect(key1).toBe(key2);
  });

  it("different error patterns produce different keys", () => {
    const key1 = computeSignalKey(["errsig:TypeError cannot read property"]);
    const key2 = computeSignalKey(["errsig:ReferenceError x is not defined"]);
    expect(key1).not.toBe(key2);
  });
});

describe("recordSignalSnapshot", () => {
  it("appends a signal event to the graph", () => {
    const ev = recordSignalSnapshot({ signals: ["log_error", "test_fail"] });
    expect(ev.type).toBe("MemoryGraphEvent");
    expect(ev.kind).toBe("signal");
    expect(ev.signal).toBeTruthy();
    expect(ev.signal!.key).toBeTruthy();

    const events = tryReadMemoryGraphEvents();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("signal");
  });

  it("includes observations when provided", () => {
    const ev = recordSignalSnapshot({
      signals: ["test"],
      observations: { recent_error_count: 5 },
    });
    expect((ev as any).observed).toEqual({ recent_error_count: 5 });
  });
});

describe("recordHypothesis", () => {
  it("records hypothesis with gene selection", () => {
    const result = recordHypothesis({
      signals: ["log_error"],
      selectedGene: { id: "gene_repair", category: "repair" },
    });
    expect(result.hypothesisId).toMatch(/^hyp_/);
    expect(result.signalKey).toBeTruthy();

    const events = tryReadMemoryGraphEvents();
    expect(events.some((e) => e.kind === "hypothesis")).toBe(true);
  });

  it("works without gene selection", () => {
    const result = recordHypothesis({ signals: ["test"] });
    expect(result.hypothesisId).toMatch(/^hyp_/);
  });
});

describe("recordAttempt", () => {
  it("records attempt and creates state file", () => {
    const result = recordAttempt({
      signals: ["log_error"],
      selectedGene: { id: "gene_repair", category: "repair" },
    });
    expect(result.actionId).toMatch(/^act_/);
    expect(result.signalKey).toBeTruthy();

    // Check state file was created
    const statePath = path.join(tmpEvoDir, "memory_graph_state.json");
    expect(fs.existsSync(statePath)).toBe(true);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(state.last_action).toBeTruthy();
    expect(state.last_action.action_id).toBe(result.actionId);
    expect(state.last_action.outcome_recorded).toBe(false);
  });
});

describe("recordOutcomeFromState", () => {
  it("returns null when no last action exists", () => {
    const result = recordOutcomeFromState({ signals: [] });
    expect(result).toBeNull();
  });

  it("records outcome after attempt", () => {
    // First record an attempt with error
    recordAttempt({
      signals: ["log_error"],
      selectedGene: { id: "gene_repair", category: "repair" },
    });

    // Then record outcome with error cleared
    const outcome = recordOutcomeFromState({ signals: ["stable"] });
    expect(outcome).not.toBeNull();
    expect(outcome!.kind).toBe("outcome");
    expect(outcome!.outcome).toBeTruthy();
    expect(outcome!.outcome!.status).toBe("success");
    expect(outcome!.outcome!.note).toContain("error_cleared");
  });

  it("records failed outcome when error persists", () => {
    recordAttempt({
      signals: ["log_error"],
      selectedGene: { id: "gene_repair", category: "repair" },
    });

    const outcome = recordOutcomeFromState({ signals: ["log_error"] });
    expect(outcome).not.toBeNull();
    expect(outcome!.outcome!.status).toBe("failed");
  });

  it("does not record outcome twice", () => {
    recordAttempt({
      signals: ["log_error"],
      selectedGene: { id: "gene_repair", category: "repair" },
    });

    const first = recordOutcomeFromState({ signals: ["stable"] });
    expect(first).not.toBeNull();

    const second = recordOutcomeFromState({ signals: ["stable"] });
    expect(second).toBeNull();
  });
});

describe("getMemoryAdvice", () => {
  it("returns advice with empty history", () => {
    const advice = getMemoryAdvice({ signals: ["test"], genes: [] });
    expect(advice.currentSignalKey).toBeTruthy();
    expect(advice.preferredGeneId).toBeNull();
    expect(advice.bannedGeneIds).toBeInstanceOf(Set);
    expect(advice.bannedGeneIds.size).toBe(0);
  });

  it("prefers gene with successful history", () => {
    const genes = [
      { type: "Gene", id: "gene_a" },
      { type: "Gene", id: "gene_b" },
    ];
    const signals = ["log_error"];

    // Record multiple successful outcomes for gene_a
    for (let i = 0; i < 3; i++) {
      recordAttempt({
        signals,
        selectedGene: { id: "gene_a", category: "repair" },
      });
      recordOutcomeFromState({ signals: ["stable"] });
    }

    const advice = getMemoryAdvice({ signals, genes });
    expect(advice.preferredGeneId).toBe("gene_a");
  });

  it("bans genes with consistently poor outcomes", () => {
    const genes = [
      { type: "Gene", id: "gene_bad" },
      { type: "Gene", id: "gene_good" },
    ];
    const signals = ["log_error"];

    // Record many failed outcomes for gene_bad.
    // Banning requires: attempts >= 2 && best < 0.18
    // With Laplace smoothing: p = (success+1)/(total+2), value = p * decay
    // Need enough failures: e.g. 10 failures -> p = 1/12 = 0.083 < 0.18
    for (let i = 0; i < 10; i++) {
      recordAttempt({
        signals,
        selectedGene: { id: "gene_bad", category: "repair" },
      });
      recordOutcomeFromState({ signals: ["log_error"] });
    }

    const advice = getMemoryAdvice({ signals, genes });
    expect(advice.bannedGeneIds.has("gene_bad")).toBe(true);
  });

  it("does not ban genes when driftEnabled", () => {
    const genes = [{ type: "Gene", id: "gene_bad" }];
    const signals = ["log_error"];

    // Record failed outcomes
    for (let i = 0; i < 3; i++) {
      recordAttempt({
        signals,
        selectedGene: { id: "gene_bad", category: "repair" },
      });
      recordOutcomeFromState({ signals: ["log_error"] });
    }

    const advice = getMemoryAdvice({ signals, genes, driftEnabled: true });
    expect(advice.bannedGeneIds.has("gene_bad")).toBe(false);
    expect(advice.explanation).toContain("random_drift:enabled");
  });
});
