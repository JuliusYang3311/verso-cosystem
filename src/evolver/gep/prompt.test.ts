import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildGepPrompt } from "./prompt.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMinimalParams() {
  return {
    nowIso: "2025-01-15T12:00:00Z",
    context: "Test execution context",
    signals: ["log_error"],
    selector: { selected: "gene_test", reason: ["test"] },
    parentEventId: null,
    selectedGene: null,
    capsuleCandidates: null,
    genesPreview: "(no genes)",
    capsulesPreview: "(no capsules)",
    capabilityCandidatesPreview: null,
    externalCandidatesPreview: null,
  };
}

function makeFullParams() {
  return {
    nowIso: "2025-01-15T12:00:00Z",
    context: "Full execution context with details",
    signals: ["log_error", "user_feature_request"],
    selector: {
      selected: "gene_repair_001",
      reason: ["signals exact match", "historical success rate high"],
      alternatives: ["capsule_fallback"],
    },
    parentEventId: "evt_12345",
    selectedGene: { id: "gene_repair_001" },
    capsuleCandidates: [{ id: "capsule_001" }, { id: "capsule_002" }],
    genesPreview: "gene_repair_001: fix common errors\ngene_optimize_002: reduce latency",
    capsulesPreview: "capsule_001: error handler pattern\ncapsule_002: retry logic",
    capabilityCandidatesPreview:
      "Q1: Can we add image support?\nQ2: Should we optimize DB queries?",
    externalCandidatesPreview: "ext_gene_a2a: shared repair pattern from peer",
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("buildGepPrompt", () => {
  const origMaxChars = process.env.GEP_PROMPT_MAX_CHARS;
  const origStrategy = process.env.EVOLVE_STRATEGY;

  beforeEach(() => {
    delete process.env.GEP_PROMPT_MAX_CHARS;
    process.env.EVOLVE_STRATEGY = "balanced";
  });

  afterEach(() => {
    if (origMaxChars === undefined) delete process.env.GEP_PROMPT_MAX_CHARS;
    else process.env.GEP_PROMPT_MAX_CHARS = origMaxChars;
    if (origStrategy === undefined) delete process.env.EVOLVE_STRATEGY;
    else process.env.EVOLVE_STRATEGY = origStrategy;
  });

  it("produces a non-empty string", () => {
    const result = buildGepPrompt(makeMinimalParams());
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(100);
  });

  it("contains the GEP protocol header", () => {
    const result = buildGepPrompt(makeMinimalParams());
    expect(result).toContain("GEP — GENOME EVOLUTION PROTOCOL");
  });

  it("contains the timestamp", () => {
    const result = buildGepPrompt(makeMinimalParams());
    expect(result).toContain("2025-01-15T12:00:00Z");
  });

  it("contains strategy label", () => {
    const result = buildGepPrompt(makeMinimalParams());
    expect(result).toContain("Balanced");
  });

  it("contains required protocol sections", () => {
    const result = buildGepPrompt(makeMinimalParams());
    expect(result).toContain("I. Protocol Positioning");
    expect(result).toContain("II. Mandatory Evolution Object Model");
    expect(result).toContain("III. Standard Evolution Execution");
    expect(result).toContain("IV. Selector");
    expect(result).toContain("V. Hard Failure Rules");
    expect(result).toContain("VI. Evolution Tree Awareness");
    expect(result).toContain("VII. Evolution Philosophy");
  });

  it("includes signals in context section", () => {
    const result = buildGepPrompt(makeMinimalParams());
    expect(result).toContain("log_error");
    expect(result).toContain("Context [Signals]");
  });

  it("includes execution context", () => {
    const result = buildGepPrompt(makeMinimalParams());
    expect(result).toContain("Test execution context");
    expect(result).toContain("Context [Execution]");
  });

  it("includes gene preview", () => {
    const result = buildGepPrompt(makeFullParams());
    expect(result).toContain("gene_repair_001: fix common errors");
    expect(result).toContain("Context [Gene Preview]");
  });

  it("includes capsule preview", () => {
    const result = buildGepPrompt(makeFullParams());
    expect(result).toContain("capsule_001: error handler pattern");
    expect(result).toContain("Context [Capsule Preview]");
  });

  it("includes capability candidates when provided", () => {
    const result = buildGepPrompt(makeFullParams());
    expect(result).toContain("Can we add image support?");
    expect(result).toContain("Context [Capability Candidates]");
  });

  it("shows (none) for null capability candidates", () => {
    const result = buildGepPrompt(makeMinimalParams());
    expect(result).toContain("(none)");
  });

  it("includes external candidates when provided", () => {
    const result = buildGepPrompt(makeFullParams());
    expect(result).toContain("ext_gene_a2a: shared repair pattern from peer");
  });

  it("includes parent event id when provided", () => {
    const params = makeFullParams();
    const result = buildGepPrompt(params);
    expect(result).toContain('"evt_12345"');
  });

  it("shows null for parent when not provided", () => {
    const result = buildGepPrompt(makeMinimalParams());
    expect(result).toContain("null");
  });

  it("includes selected gene id in selector section", () => {
    const result = buildGepPrompt(makeFullParams());
    expect(result).toContain("gene_repair_001");
  });

  it("includes capsule ids as alternatives", () => {
    const result = buildGepPrompt(makeFullParams());
    expect(result).toContain("capsule_001");
    expect(result).toContain("capsule_002");
  });

  it("includes env fingerprint section", () => {
    const result = buildGepPrompt(makeMinimalParams());
    expect(result).toContain("Context [Env Fingerprint]");
    expect(result).toContain("node_version");
    expect(result).toContain("platform");
  });

  // ── Budget truncation ───────────────────────────────────────────────────

  it("truncates prompt when it exceeds GEP_PROMPT_MAX_CHARS", () => {
    process.env.GEP_PROMPT_MAX_CHARS = "500";
    const params = makeFullParams();
    params.context = "X".repeat(5000);
    const result = buildGepPrompt(params);
    expect(result.length).toBeLessThanOrEqual(500);
    expect(result).toContain("PROMPT TRUNCATED FOR BUDGET");
  });

  it("does not truncate when within budget", () => {
    process.env.GEP_PROMPT_MAX_CHARS = "100000";
    const result = buildGepPrompt(makeMinimalParams());
    expect(result).not.toContain("PROMPT TRUNCATED FOR BUDGET");
  });

  it("uses default max of 30000 chars when env var not set", () => {
    // Generate a prompt that's under 30000 chars
    const result = buildGepPrompt(makeMinimalParams());
    expect(result).not.toContain("PROMPT TRUNCATED FOR BUDGET");
    expect(result.length).toBeLessThan(30000);
  });

  // ── Strategy integration ──────────────────────────────────────────────

  it("reflects innovate strategy in prompt", () => {
    process.env.EVOLVE_STRATEGY = "innovate";
    const result = buildGepPrompt(makeMinimalParams());
    expect(result).toContain("Innovation Focus");
  });

  it("reflects harden strategy in prompt", () => {
    process.env.EVOLVE_STRATEGY = "harden";
    const result = buildGepPrompt(makeMinimalParams());
    expect(result).toContain("Hardening");
  });

  it("reflects repair-only strategy in prompt", () => {
    process.env.EVOLVE_STRATEGY = "repair-only";
    const result = buildGepPrompt(makeMinimalParams());
    expect(result).toContain("Repair Only");
  });
});
