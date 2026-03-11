import { describe, it, expect } from "vitest";
import {
  buildMutation,
  isValidMutation,
  normalizeMutation,
  isHighRiskPersonality,
  isHighRiskMutationAllowed,
  clamp01,
  hasOpportunitySignal,
  OPPORTUNITY_SIGNALS,
} from "./mutation.js";

// ── clamp01 ─────────────────────────────────────────────────────────────────

describe("clamp01", () => {
  it("clamps numbers to [0, 1]", () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(2)).toBe(1);
  });

  it("returns 0 for non-finite inputs", () => {
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(0);
    expect(clamp01(-Infinity)).toBe(0);
    expect(clamp01(undefined)).toBe(0);
    expect(clamp01(null)).toBe(0);
    expect(clamp01("abc")).toBe(0);
  });

  it("coerces numeric strings", () => {
    expect(clamp01("0.7")).toBe(0.7);
    expect(clamp01("5")).toBe(1);
  });
});

// ── OPPORTUNITY_SIGNALS ─────────────────────────────────────────────────────

describe("OPPORTUNITY_SIGNALS", () => {
  it("is a non-empty readonly array of strings", () => {
    expect(Array.isArray(OPPORTUNITY_SIGNALS)).toBe(true);
    expect(OPPORTUNITY_SIGNALS.length).toBeGreaterThan(0);
    for (const s of OPPORTUNITY_SIGNALS) {
      expect(typeof s).toBe("string");
    }
  });

  it("contains expected signals", () => {
    expect(OPPORTUNITY_SIGNALS).toContain("user_feature_request");
    expect(OPPORTUNITY_SIGNALS).toContain("perf_bottleneck");
    expect(OPPORTUNITY_SIGNALS).toContain("capability_gap");
  });
});

// ── hasOpportunitySignal ────────────────────────────────────────────────────

describe("hasOpportunitySignal", () => {
  it("returns true when an opportunity signal is present", () => {
    expect(hasOpportunitySignal(["user_feature_request"])).toBe(true);
    expect(hasOpportunitySignal(["perf_bottleneck", "other"])).toBe(true);
  });

  it("returns false when no opportunity signal is present", () => {
    expect(hasOpportunitySignal(["log_error"])).toBe(false);
    expect(hasOpportunitySignal([])).toBe(false);
  });

  it("handles non-array input gracefully", () => {
    expect(hasOpportunitySignal(null)).toBe(false);
    expect(hasOpportunitySignal(undefined)).toBe(false);
    expect(hasOpportunitySignal("user_feature_request")).toBe(false);
  });

  it("ignores non-string elements", () => {
    expect(hasOpportunitySignal([123, null, undefined])).toBe(false);
  });
});

// ── isHighRiskPersonality ───────────────────────────────────────────────────

describe("isHighRiskPersonality", () => {
  it("returns true when rigor < 0.5", () => {
    expect(isHighRiskPersonality({ rigor: 0.3, risk_tolerance: 0.4 })).toBe(true);
    expect(isHighRiskPersonality({ rigor: 0.49, risk_tolerance: 0.4 })).toBe(true);
  });

  it("returns true when risk_tolerance > 0.6", () => {
    expect(isHighRiskPersonality({ rigor: 0.8, risk_tolerance: 0.7 })).toBe(true);
    expect(isHighRiskPersonality({ rigor: 0.8, risk_tolerance: 0.61 })).toBe(true);
  });

  it("returns false for conservative personality", () => {
    expect(isHighRiskPersonality({ rigor: 0.8, risk_tolerance: 0.3 })).toBe(false);
    expect(isHighRiskPersonality({ rigor: 0.5, risk_tolerance: 0.6 })).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isHighRiskPersonality(null)).toBe(false);
    expect(isHighRiskPersonality(undefined)).toBe(false);
  });
});

// ── isHighRiskMutationAllowed ───────────────────────────────────────────────

describe("isHighRiskMutationAllowed", () => {
  it("returns true when rigor >= 0.6 and risk_tolerance <= 0.5", () => {
    expect(isHighRiskMutationAllowed({ rigor: 0.6, risk_tolerance: 0.5 })).toBe(true);
    expect(isHighRiskMutationAllowed({ rigor: 1.0, risk_tolerance: 0.0 })).toBe(true);
  });

  it("returns false when rigor < 0.6", () => {
    expect(isHighRiskMutationAllowed({ rigor: 0.59, risk_tolerance: 0.3 })).toBe(false);
  });

  it("returns false when risk_tolerance > 0.5", () => {
    expect(isHighRiskMutationAllowed({ rigor: 0.8, risk_tolerance: 0.51 })).toBe(false);
  });

  it("uses defaults (rigor=0, riskTol=1) for null personality", () => {
    // rigor 0 < 0.6 → false
    expect(isHighRiskMutationAllowed(null)).toBe(false);
    expect(isHighRiskMutationAllowed(undefined)).toBe(false);
  });
});

// ── buildMutation ───────────────────────────────────────────────────────────

describe("buildMutation", () => {
  it("builds a default optimize mutation with no args", () => {
    const m = buildMutation();
    expect(m.type).toBe("Mutation");
    expect(m.id).toMatch(/^mut_\d+$/);
    expect(m.category).toBe("optimize");
    expect(m.risk_level).toBe("low");
    expect(m.target).toBe("behavior:protocol");
    expect(typeof m.expected_effect).toBe("string");
    expect(Array.isArray(m.trigger_signals)).toBe(true);
  });

  it("sets category to repair when error signals present", () => {
    const m = buildMutation({ signals: ["log_error"] });
    expect(m.category).toBe("repair");
    expect(m.risk_level).toBe("low");
  });

  it("sets category to repair for errsig: prefixed signals", () => {
    const m = buildMutation({ signals: ["errsig:timeout"] });
    expect(m.category).toBe("repair");
  });

  it("sets category to innovate when driftEnabled", () => {
    const m = buildMutation({ driftEnabled: true });
    expect(m.category).toBe("innovate");
    expect(m.risk_level).toBe("medium");
  });

  it("sets category to innovate when opportunity signals present", () => {
    const m = buildMutation({ signals: ["user_feature_request"] });
    expect(m.category).toBe("innovate");
    expect(m.risk_level).toBe("medium");
  });

  it("uses gene id as target when selectedGene provided", () => {
    const m = buildMutation({ selectedGene: { id: "gene_abc" } });
    expect(m.target).toBe("gene:gene_abc");
  });

  it("uses custom target and expected_effect when provided", () => {
    const m = buildMutation({ target: "custom:target", expected_effect: "custom effect" });
    expect(m.target).toBe("custom:target");
    expect(m.expected_effect).toBe("custom effect");
  });

  it("deduplicates trigger signals", () => {
    const m = buildMutation({ signals: ["a", "b", "a", "b", "c"] });
    expect(m.trigger_signals).toEqual(["a", "b", "c"]);
  });

  it("escalates to high risk when allowHighRisk + innovate", () => {
    // Need personality that allows high risk: rigor >= 0.6, risk_tolerance <= 0.5
    const m = buildMutation({
      driftEnabled: true,
      allowHighRisk: true,
      personalityState: { rigor: 0.8, risk_tolerance: 0.3 },
    });
    expect(m.category).toBe("innovate");
    expect(m.risk_level).toBe("high");
  });

  it("safety: downgrades innovate to optimize for high-risk personality", () => {
    const m = buildMutation({
      driftEnabled: true,
      personalityState: { rigor: 0.3, risk_tolerance: 0.4 }, // low rigor → high-risk personality
    });
    expect(m.category).toBe("optimize");
    expect(m.risk_level).toBe("low");
    expect(m.trigger_signals).toContain("safety:avoid_innovate_with_high_risk_personality");
  });

  it("safety: downgrades high risk to medium when personality disallows", () => {
    // rigor=0.59 is NOT < 0.5, risk_tolerance=0.3 is NOT > 0.6 → NOT high-risk personality
    // So innovate stays. allowHighRisk + innovate → high risk.
    // But isHighRiskMutationAllowed: rigor 0.59 < 0.6 → false → downgrade high to medium
    const m = buildMutation({
      driftEnabled: true,
      allowHighRisk: true,
      personalityState: { rigor: 0.59, risk_tolerance: 0.3 },
    });
    expect(m.category).toBe("innovate");
    expect(m.risk_level).toBe("medium");
    expect(m.trigger_signals).toContain("safety:downgrade_high_risk");
  });

  it("safety: downgrades high-risk mutation when personality insufficient (not high-risk personality but not allowed either)", () => {
    // rigor=0.5 is not < 0.5, risk_tolerance=0.5 is not > 0.6 → NOT high-risk personality
    // But rigor=0.5 < 0.6 → isHighRiskMutationAllowed returns false
    const m = buildMutation({
      driftEnabled: true,
      allowHighRisk: true,
      personalityState: { rigor: 0.5, risk_tolerance: 0.5 },
    });
    expect(m.category).toBe("innovate");
    expect(m.risk_level).toBe("medium"); // downgraded from high
    expect(m.trigger_signals).toContain("safety:downgrade_high_risk");
  });
});

// ── isValidMutation ─────────────────────────────────────────────────────────

describe("isValidMutation", () => {
  it("returns true for a valid mutation", () => {
    const m = buildMutation();
    expect(isValidMutation(m)).toBe(true);
  });

  it("returns false for null/undefined/non-objects", () => {
    expect(isValidMutation(null)).toBe(false);
    expect(isValidMutation(undefined)).toBe(false);
    expect(isValidMutation("string")).toBe(false);
    expect(isValidMutation(42)).toBe(false);
  });

  it("returns false for wrong type field", () => {
    const m = buildMutation();
    expect(isValidMutation({ ...m, type: "Gene" })).toBe(false);
  });

  it("returns false for missing/invalid fields", () => {
    const m = buildMutation();
    expect(isValidMutation({ ...m, id: "" })).toBe(false);
    expect(isValidMutation({ ...m, category: "invalid" })).toBe(false);
    expect(isValidMutation({ ...m, trigger_signals: "not-array" })).toBe(false);
    expect(isValidMutation({ ...m, target: "" })).toBe(false);
    expect(isValidMutation({ ...m, expected_effect: "" })).toBe(false);
    expect(isValidMutation({ ...m, risk_level: "extreme" })).toBe(false);
  });
});

// ── normalizeMutation ───────────────────────────────────────────────────────

describe("normalizeMutation", () => {
  it("returns a valid mutation from a valid input", () => {
    const m = buildMutation();
    const n = normalizeMutation(m);
    expect(isValidMutation(n)).toBe(true);
    expect(n.type).toBe("Mutation");
  });

  it("normalizes garbage input to a safe default", () => {
    const n = normalizeMutation(null);
    expect(isValidMutation(n)).toBe(true);
    expect(n.category).toBe("optimize");
    expect(n.risk_level).toBe("low");
    expect(n.target).toBe("behavior:protocol");
  });

  it("normalizes invalid category to optimize", () => {
    const n = normalizeMutation({ category: "bogus" });
    expect(n.category).toBe("optimize");
  });

  it("normalizes invalid risk_level to low", () => {
    const n = normalizeMutation({ risk_level: "extreme" });
    expect(n.risk_level).toBe("low");
  });

  it("preserves valid fields", () => {
    const n = normalizeMutation({
      id: "mut_custom",
      category: "repair",
      trigger_signals: ["a", "b"],
      target: "gene:x",
      expected_effect: "fix stuff",
      risk_level: "medium",
    });
    expect(n.id).toBe("mut_custom");
    expect(n.category).toBe("repair");
    expect(n.trigger_signals).toEqual(["a", "b"]);
    expect(n.target).toBe("gene:x");
    expect(n.expected_effect).toBe("fix stuff");
    expect(n.risk_level).toBe("medium");
  });
});
