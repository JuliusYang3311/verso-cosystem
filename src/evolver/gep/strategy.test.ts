import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveStrategy, getStrategyNames, STRATEGIES } from "./strategy.js";

// ── STRATEGIES constant ─────────────────────────────────────────────────────

describe("STRATEGIES", () => {
  it("has four strategy entries", () => {
    const names = Object.keys(STRATEGIES);
    expect(names).toEqual(
      expect.arrayContaining(["balanced", "innovate", "harden", "repair-only"]),
    );
    expect(names.length).toBe(4);
  });

  it("each strategy has required numeric fields summing to ~1", () => {
    for (const [_name, s] of Object.entries(STRATEGIES)) {
      expect(typeof s.repair).toBe("number");
      expect(typeof s.optimize).toBe("number");
      expect(typeof s.innovate).toBe("number");
      expect(typeof s.repairLoopThreshold).toBe("number");
      expect(typeof s.label).toBe("string");
      expect(typeof s.description).toBe("string");
      const sum = s.repair + s.optimize + s.innovate;
      expect(sum).toBeCloseTo(1.0, 5);
    }
  });

  it("repair-only has zero innovate", () => {
    expect(STRATEGIES["repair-only"].innovate).toBe(0);
  });

  it("innovate strategy has highest innovate weight", () => {
    expect(STRATEGIES["innovate"].innovate).toBeGreaterThan(STRATEGIES["balanced"].innovate);
    expect(STRATEGIES["innovate"].innovate).toBeGreaterThan(STRATEGIES["harden"].innovate);
  });
});

// ── getStrategyNames ────────────────────────────────────────────────────────

describe("getStrategyNames", () => {
  it("returns array of strategy names", () => {
    const names = getStrategyNames();
    expect(names).toContain("balanced");
    expect(names).toContain("innovate");
    expect(names).toContain("harden");
    expect(names).toContain("repair-only");
  });
});

// ── resolveStrategy ─────────────────────────────────────────────────────────

describe("resolveStrategy", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.EVOLVE_STRATEGY = process.env.EVOLVE_STRATEGY;
    savedEnv.FORCE_INNOVATION = process.env.FORCE_INNOVATION;
    savedEnv.EVOLVE_FORCE_INNOVATION = process.env.EVOLVE_FORCE_INNOVATION;
    delete process.env.EVOLVE_STRATEGY;
    delete process.env.FORCE_INNOVATION;
    delete process.env.EVOLVE_FORCE_INNOVATION;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
  });

  it("defaults to balanced", () => {
    const s = resolveStrategy();
    expect(s.name).toBe("balanced");
    expect(s.label).toBe("Balanced");
  });

  it("resolves from EVOLVE_STRATEGY env var", () => {
    process.env.EVOLVE_STRATEGY = "harden";
    const s = resolveStrategy();
    expect(s.name).toBe("harden");
  });

  it("is case-insensitive for EVOLVE_STRATEGY", () => {
    process.env.EVOLVE_STRATEGY = "REPAIR-ONLY";
    const s = resolveStrategy();
    expect(s.name).toBe("repair-only");
    expect(s.repair).toBe(0.8);
  });

  it("falls back to balanced for unknown strategy", () => {
    process.env.EVOLVE_STRATEGY = "nonexistent";
    const s = resolveStrategy();
    // Falls back to balanced strategy values but name stays "nonexistent"
    expect(s.repair).toBe(STRATEGIES["balanced"].repair);
  });

  it("resolves innovate from FORCE_INNOVATION when EVOLVE_STRATEGY not set", () => {
    process.env.FORCE_INNOVATION = "true";
    const s = resolveStrategy();
    expect(s.name).toBe("innovate");
  });

  it("resolves innovate from EVOLVE_FORCE_INNOVATION when EVOLVE_STRATEGY not set", () => {
    process.env.EVOLVE_FORCE_INNOVATION = "true";
    const s = resolveStrategy();
    expect(s.name).toBe("innovate");
  });

  it("EVOLVE_STRATEGY takes precedence over FORCE_INNOVATION", () => {
    process.env.EVOLVE_STRATEGY = "harden";
    process.env.FORCE_INNOVATION = "true";
    const s = resolveStrategy();
    expect(s.name).toBe("harden");
  });

  it("returns a copy with name field", () => {
    const s = resolveStrategy();
    expect(typeof s.name).toBe("string");
    expect(s).toHaveProperty("repair");
    expect(s).toHaveProperty("optimize");
    expect(s).toHaveProperty("innovate");
  });
});
