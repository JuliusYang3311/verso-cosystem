import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock paths.js to use temp directories
const tmpDir = path.join(os.tmpdir(), "personality-test-" + process.pid);
const memoryDir = path.join(tmpDir, "memory");
const evolutionDir = path.join(memoryDir, "evolution");

vi.mock("./paths.js", () => ({
  getMemoryDir: () => memoryDir,
  getEvolutionDir: () => evolutionDir,
}));

// Mock mutation.js (personality.ts imports hasOpportunitySignal from it)
vi.mock("./mutation.js", () => {
  const OPPORTUNITY_SIGNALS = [
    "user_feature_request",
    "user_improvement_suggestion",
    "perf_bottleneck",
    "capability_gap",
    "stable_success_plateau",
    "external_opportunity",
    "recurring_error",
    "unsupported_input_type",
    "evolution_stagnation_detected",
    "repair_loop_detected",
    "force_innovation_after_repair_loop",
  ];
  return {
    hasOpportunitySignal: (signals: unknown) => {
      const list: string[] = Array.isArray(signals) ? signals : [];
      return OPPORTUNITY_SIGNALS.some((s) => list.includes(s));
    },
    OPPORTUNITY_SIGNALS,
  };
});

import {
  defaultPersonalityState,
  normalizePersonalityState,
  isValidPersonalityState,
  personalityKey,
  clamp01,
  loadPersonalityModel,
  savePersonalityModel,
  selectPersonalityForRun,
  updatePersonalityStats,
} from "./personality.js";

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  fs.mkdirSync(evolutionDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── clamp01 ─────────────────────────────────────────────────────────────────

describe("clamp01", () => {
  it("clamps values to [0, 1]", () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(1)).toBe(1);
  });

  it("returns 0 for non-finite values", () => {
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(0);
    expect(clamp01(-Infinity)).toBe(0);
    expect(clamp01(undefined)).toBe(0);
    expect(clamp01(null)).toBe(0);
    expect(clamp01("abc")).toBe(0);
  });

  it("coerces numeric strings", () => {
    expect(clamp01("0.5")).toBe(0.5);
    expect(clamp01("1.5")).toBe(1);
  });
});

// ── defaultPersonalityState ─────────────────────────────────────────────────

describe("defaultPersonalityState", () => {
  it("returns a valid PersonalityState with conservative defaults", () => {
    const state = defaultPersonalityState();
    expect(state.type).toBe("PersonalityState");
    expect(state.rigor).toBe(0.7);
    expect(state.creativity).toBe(0.35);
    expect(state.verbosity).toBe(0.25);
    expect(state.risk_tolerance).toBe(0.4);
    expect(state.obedience).toBe(0.85);
  });

  it("is a valid personality state", () => {
    expect(isValidPersonalityState(defaultPersonalityState())).toBe(true);
  });
});

// ── normalizePersonalityState ───────────────────────────────────────────────

describe("normalizePersonalityState", () => {
  it("normalizes a valid state", () => {
    const state = normalizePersonalityState({
      rigor: 0.8,
      creativity: 0.5,
      verbosity: 0.3,
      risk_tolerance: 0.2,
      obedience: 0.9,
    });
    expect(state.type).toBe("PersonalityState");
    expect(state.rigor).toBe(0.8);
    expect(state.creativity).toBe(0.5);
  });

  it("clamps out-of-range values", () => {
    const state = normalizePersonalityState({
      rigor: 1.5,
      creativity: -0.3,
      verbosity: 0.5,
      risk_tolerance: 0.5,
      obedience: 0.5,
    });
    expect(state.rigor).toBe(1);
    expect(state.creativity).toBe(0);
  });

  it("returns all zeros for null/undefined input", () => {
    const state = normalizePersonalityState(null);
    expect(state.type).toBe("PersonalityState");
    expect(state.rigor).toBe(0);
    expect(state.creativity).toBe(0);
  });

  it("handles non-object input gracefully", () => {
    const state = normalizePersonalityState("not an object");
    expect(state.type).toBe("PersonalityState");
    expect(state.rigor).toBe(0);
  });
});

// ── isValidPersonalityState ─────────────────────────────────────────────────

describe("isValidPersonalityState", () => {
  it("returns true for a valid state", () => {
    expect(
      isValidPersonalityState({
        type: "PersonalityState",
        rigor: 0.5,
        creativity: 0.5,
        verbosity: 0.5,
        risk_tolerance: 0.5,
        obedience: 0.5,
      }),
    ).toBe(true);
  });

  it("returns false when type is wrong", () => {
    expect(
      isValidPersonalityState({
        type: "Wrong",
        rigor: 0.5,
        creativity: 0.5,
        verbosity: 0.5,
        risk_tolerance: 0.5,
        obedience: 0.5,
      }),
    ).toBe(false);
  });

  it("returns false when a param is out of range", () => {
    expect(
      isValidPersonalityState({
        type: "PersonalityState",
        rigor: 1.5,
        creativity: 0.5,
        verbosity: 0.5,
        risk_tolerance: 0.5,
        obedience: 0.5,
      }),
    ).toBe(false);

    expect(
      isValidPersonalityState({
        type: "PersonalityState",
        rigor: 0.5,
        creativity: -0.1,
        verbosity: 0.5,
        risk_tolerance: 0.5,
        obedience: 0.5,
      }),
    ).toBe(false);
  });

  it("returns false for non-finite values", () => {
    expect(
      isValidPersonalityState({
        type: "PersonalityState",
        rigor: NaN,
        creativity: 0.5,
        verbosity: 0.5,
        risk_tolerance: 0.5,
        obedience: 0.5,
      }),
    ).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isValidPersonalityState(null)).toBe(false);
    expect(isValidPersonalityState(undefined)).toBe(false);
  });

  it("returns false for non-object", () => {
    expect(isValidPersonalityState("string")).toBe(false);
    expect(isValidPersonalityState(42)).toBe(false);
  });
});

// ── personalityKey ──────────────────────────────────────────────────────────

describe("personalityKey", () => {
  it("generates a deterministic key from state", () => {
    const key = personalityKey({
      rigor: 0.7,
      creativity: 0.35,
      verbosity: 0.25,
      risk_tolerance: 0.4,
      obedience: 0.85,
    });
    // 0.35 rounds to 0.3 due to floating point (0.35/0.1 = 3.4999...)
    expect(key).toBe("rigor=0.7|creativity=0.3|verbosity=0.3|risk_tolerance=0.4|obedience=0.9");
  });

  it("rounds to 0.1 step", () => {
    const key = personalityKey({
      rigor: 0.74,
      creativity: 0.36,
      verbosity: 0.0,
      risk_tolerance: 1.0,
      obedience: 0.55,
    });
    expect(key).toBe("rigor=0.7|creativity=0.4|verbosity=0.0|risk_tolerance=1.0|obedience=0.6");
  });

  it("normalizes null input to all zeros", () => {
    const key = personalityKey(null);
    expect(key).toBe("rigor=0.0|creativity=0.0|verbosity=0.0|risk_tolerance=0.0|obedience=0.0");
  });

  it("same effective state produces same key", () => {
    const a = personalityKey({
      rigor: 0.71,
      creativity: 0.5,
      verbosity: 0.5,
      risk_tolerance: 0.5,
      obedience: 0.5,
    });
    const b = personalityKey({
      rigor: 0.74,
      creativity: 0.5,
      verbosity: 0.5,
      risk_tolerance: 0.5,
      obedience: 0.5,
    });
    expect(a).toBe(b);
  });
});

// ── loadPersonalityModel (with mocked fs/paths) ────────────────────────────

describe("loadPersonalityModel", () => {
  it("returns default model when no file exists", () => {
    const model = loadPersonalityModel();
    expect(model.version).toBe(1);
    expect(model.current.type).toBe("PersonalityState");
    expect(model.stats).toEqual({});
    expect(model.history).toEqual([]);
  });

  it("loads persisted model from disk", () => {
    const data = {
      version: 1,
      current: {
        type: "PersonalityState",
        rigor: 0.9,
        creativity: 0.1,
        verbosity: 0.2,
        risk_tolerance: 0.3,
        obedience: 0.4,
      },
      stats: {
        "rigor=0.9|creativity=0.1|verbosity=0.2|risk_tolerance=0.3|obedience=0.4": {
          success: 5,
          fail: 1,
        },
      },
      history: [{ at: "2025-01-01T00:00:00Z", key: "test" }],
      updated_at: "2025-01-01T00:00:00Z",
    };
    fs.writeFileSync(path.join(evolutionDir, "personality_state.json"), JSON.stringify(data));
    const model = loadPersonalityModel();
    expect(model.current.rigor).toBe(0.9);
    expect(model.current.creativity).toBe(0.1);
    expect(Object.keys(model.stats).length).toBe(1);
    expect(model.history.length).toBe(1);
  });

  it("handles corrupt file gracefully (returns defaults)", () => {
    fs.writeFileSync(path.join(evolutionDir, "personality_state.json"), "not json{{{");
    const model = loadPersonalityModel();
    expect(model.version).toBe(1);
    expect(model.current.type).toBe("PersonalityState");
  });
});

// ── savePersonalityModel ────────────────────────────────────────────────────

describe("savePersonalityModel", () => {
  it("persists model to disk and returns normalized model", () => {
    const result = savePersonalityModel({
      current: { rigor: 0.8, creativity: 0.5, verbosity: 0.3, risk_tolerance: 0.2, obedience: 0.9 },
      stats: {},
      history: [],
    });
    expect(result.version).toBe(1);
    expect(result.current.type).toBe("PersonalityState");
    expect(result.current.rigor).toBe(0.8);

    // Verify file was written
    const raw = JSON.parse(
      fs.readFileSync(path.join(evolutionDir, "personality_state.json"), "utf8"),
    );
    expect(raw.current.rigor).toBe(0.8);
  });

  it("truncates history to 120 entries", () => {
    const history = Array.from({ length: 150 }, (_, i) => ({ at: `event_${i}` }));
    const result = savePersonalityModel({ current: defaultPersonalityState(), stats: {}, history });
    expect(result.history.length).toBe(120);
  });

  it("handles null input gracefully", () => {
    const result = savePersonalityModel(null);
    expect(result.version).toBe(1);
    expect(result.current.type).toBe("PersonalityState");
  });
});

// ── selectPersonalityForRun ─────────────────────────────────────────────────

describe("selectPersonalityForRun", () => {
  it("returns personality state, key, and metadata", () => {
    const result = selectPersonalityForRun();
    expect(result.personality_state).toBeDefined();
    expect(typeof result.personality_key).toBe("string");
    expect(typeof result.personality_known).toBe("boolean");
    expect(Array.isArray(result.personality_mutations)).toBe(true);
    expect(result.model_meta).toBeDefined();
  });

  it("persists the updated state to disk", () => {
    selectPersonalityForRun();
    const filePath = path.join(evolutionDir, "personality_state.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(raw.current.type).toBe("PersonalityState");
  });

  it("applies natural selection nudge when stats have a best-known config", () => {
    // Seed a model with strong stats for a specific key
    const bestKey = "rigor=0.3|creativity=0.8|verbosity=0.1|risk_tolerance=0.6|obedience=0.5";
    savePersonalityModel({
      current: defaultPersonalityState(),
      stats: {
        [bestKey]: { success: 10, fail: 0, avg_score: 0.9, n: 10 },
      },
      history: [],
    });

    const result = selectPersonalityForRun();
    // Should have applied some natural selection mutations
    const nsMuts = (result.personality_mutations as any[]).filter(
      (m: any) => m.reason === "natural_selection",
    );
    expect(nsMuts.length).toBeGreaterThan(0);
  });

  it("triggers mutation on drift enabled", () => {
    const result = selectPersonalityForRun({ driftEnabled: true });
    const triggered = (result.model_meta as any).triggered;
    expect(triggered).toBeTruthy();
    expect(triggered.reason).toBe("drift enabled");
  });

  it("triggers mutation on long failure streak", () => {
    const recentEvents = Array.from({ length: 6 }, () => ({
      outcome: { status: "failed" },
    }));
    const result = selectPersonalityForRun({ recentEvents });
    const triggered = (result.model_meta as any).triggered;
    expect(triggered).toBeTruthy();
    expect(triggered.reason).toBe("long failure streak");
  });
});

// ── updatePersonalityStats ──────────────────────────────────────────────────

describe("updatePersonalityStats", () => {
  it("increments success count", () => {
    const { key, stats } = updatePersonalityStats({ outcome: "success" });
    expect(typeof key).toBe("string");
    expect(stats.success).toBe(1);
    expect(stats.fail).toBe(0);
  });

  it("increments fail count", () => {
    const { stats } = updatePersonalityStats({ outcome: "failed" });
    expect(stats.fail).toBe(1);
    expect(stats.success).toBe(0);
  });

  it("updates running average score", () => {
    updatePersonalityStats({ outcome: "success", score: 0.8 });
    const { stats } = updatePersonalityStats({ outcome: "success", score: 0.6 });
    // Running average: first call sets avg from 0.5 default
    // n=1: avg = 0.5 + (0.8-0.5)/1 = 0.8
    // n=2: avg = 0.8 + (0.6-0.8)/2 = 0.7
    // But since updatePersonalityStats reloads each time, n accumulates
    expect(stats.n).toBe(2);
    expect(stats.avg_score).toBeCloseTo(0.7, 1);
  });

  it("appends to history", () => {
    updatePersonalityStats({ outcome: "success", notes: "test note" });
    const model = loadPersonalityModel();
    expect(model.history.length).toBeGreaterThanOrEqual(1);
    const last = model.history[model.history.length - 1];
    expect(last.outcome).toBe("success");
    expect(last.notes).toBe("test note");
  });

  it("uses current personality state when none provided", () => {
    const { key } = updatePersonalityStats({ outcome: "success" });
    expect(key).toBeTruthy();
    expect(key).toContain("rigor=");
  });

  it("uses provided personality state for key", () => {
    const { key } = updatePersonalityStats({
      personalityState: {
        type: "PersonalityState",
        rigor: 0.5,
        creativity: 0.5,
        verbosity: 0.5,
        risk_tolerance: 0.5,
        obedience: 0.5,
      },
      outcome: "success",
    });
    expect(key).toBe("rigor=0.5|creativity=0.5|verbosity=0.5|risk_tolerance=0.5|obedience=0.5");
  });
});
