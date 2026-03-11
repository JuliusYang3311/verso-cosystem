import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  matchPatternToSignals,
  scoreGene,
  selectGene,
  selectCapsule,
  selectGeneAndCapsule,
  buildSelectorDecision,
  type Gene,
  type Capsule,
  type MemoryAdvice,
} from "./selector.js";

// ── matchPatternToSignals ───────────────────────────────────────────────────

describe("matchPatternToSignals", () => {
  it("returns false for null/empty pattern or signals", () => {
    expect(matchPatternToSignals(null, ["a"])).toBe(false);
    expect(matchPatternToSignals("", ["a"])).toBe(false);
    expect(matchPatternToSignals("a", [])).toBe(false);
    expect(matchPatternToSignals(undefined, ["a"])).toBe(false);
  });

  it("matches substring case-insensitively", () => {
    expect(matchPatternToSignals("error", ["log_error"])).toBe(true);
    expect(matchPatternToSignals("ERROR", ["log_error"])).toBe(true);
    expect(matchPatternToSignals("xyz", ["log_error"])).toBe(false);
  });

  it("matches regex patterns (delimited by slashes)", () => {
    expect(matchPatternToSignals("/^log_/", ["log_error"])).toBe(true);
    expect(matchPatternToSignals("/^log_/", ["my_log_error"])).toBe(false);
    expect(matchPatternToSignals("/error$/i", ["LOG_ERROR"])).toBe(true);
  });

  it("falls back to substring on invalid regex", () => {
    // "/[invalid/" has lastSlash at 9, body="[invalid" which is invalid regex (unclosed bracket)
    // Falls back to substring: needle="/[invalid/" lowercased, checked against signals
    // The signal must contain the full pattern string for substring match
    expect(matchPatternToSignals("/[invalid/", ["/[invalid/"])).toBe(true);
    // When signal doesn't contain the full pattern, it returns false
    expect(matchPatternToSignals("/[invalid/", ["[invalid"])).toBe(false);
  });
});

// ── scoreGene ───────────────────────────────────────────────────────────────

describe("scoreGene", () => {
  it("returns 0 for null/invalid gene", () => {
    expect(scoreGene(null, ["a"])).toBe(0);
    expect(scoreGene(undefined, ["a"])).toBe(0);
    expect(scoreGene({ type: "NotGene", id: "x" } as any, ["a"])).toBe(0);
  });

  it("returns 0 when signals_match is empty", () => {
    const gene: Gene = { type: "Gene", id: "g1", signals_match: [] };
    expect(scoreGene(gene, ["a"])).toBe(0);
  });

  it("scores by number of matching patterns", () => {
    const gene: Gene = { type: "Gene", id: "g1", signals_match: ["error", "drift"] };
    expect(scoreGene(gene, ["log_error", "protocol_drift"])).toBe(2);
    expect(scoreGene(gene, ["log_error"])).toBe(1);
    expect(scoreGene(gene, ["unrelated"])).toBe(0);
  });
});

// ── selectGene ──────────────────────────────────────────────────────────────

describe("selectGene", () => {
  const geneA: Gene = { type: "Gene", id: "a", signals_match: ["error"] };
  const geneB: Gene = { type: "Gene", id: "b", signals_match: ["error", "drift"] };
  const geneC: Gene = { type: "Gene", id: "c", signals_match: ["perf"] };

  it("selects highest-scoring gene", () => {
    const result = selectGene([geneA, geneB, geneC], ["log_error", "protocol_drift"]);
    expect(result.selected?.id).toBe("b"); // score 2
    expect(result.alternatives.map((g) => g.id)).toContain("a");
  });

  it("returns null when no genes match", () => {
    const result = selectGene([geneA, geneB], ["unrelated"]);
    expect(result.selected).toBeNull();
    expect(result.alternatives).toEqual([]);
  });

  it("respects bannedGeneIds", () => {
    const result = selectGene([geneA, geneB], ["log_error", "protocol_drift"], {
      bannedGeneIds: new Set(["b"]),
    });
    expect(result.selected?.id).toBe("a");
  });

  it("allows banned genes when driftEnabled", () => {
    const result = selectGene([geneA, geneB], ["log_error", "protocol_drift"], {
      bannedGeneIds: new Set(["b"]),
      driftEnabled: true,
    });
    expect(result.selected?.id).toBe("b");
  });

  it("prefers preferredGeneId when it has a score", () => {
    const result = selectGene(
      [geneA, geneB, geneC],
      ["log_error", "protocol_drift", "perf_issue"],
      {
        preferredGeneId: "a",
      },
    );
    // geneA has score 1, geneB has score 2, but preferredGeneId overrides
    expect(result.selected?.id).toBe("a");
  });

  it("returns alternatives when all scored genes are banned", () => {
    const result = selectGene([geneA], ["log_error"], {
      bannedGeneIds: new Set(["a"]),
    });
    expect(result.selected).toBeNull();
    expect(result.alternatives.map((g) => g.id)).toContain("a");
  });
});

// ── selectCapsule ───────────────────────────────────────────────────────────

describe("selectCapsule", () => {
  it("returns null for null/empty capsules", () => {
    expect(selectCapsule(null, ["a"])).toBeNull();
    expect(selectCapsule([], ["a"])).toBeNull();
  });

  it("selects highest-scoring capsule by trigger match", () => {
    const capsules: Capsule[] = [
      { id: "c1", trigger: ["error"] },
      { id: "c2", trigger: ["error", "drift"] },
    ];
    const result = selectCapsule(capsules, ["log_error", "protocol_drift"]);
    expect(result?.id).toBe("c2");
  });

  it("returns null when no triggers match", () => {
    const capsules: Capsule[] = [{ id: "c1", trigger: ["xyz"] }];
    expect(selectCapsule(capsules, ["log_error"])).toBeNull();
  });
});

// ── buildSelectorDecision ───────────────────────────────────────────────────

describe("buildSelectorDecision", () => {
  it("includes gene match reason when gene is present", () => {
    const gene: Gene = { type: "Gene", id: "g1" };
    const decision = buildSelectorDecision({
      gene,
      capsule: null,
      signals: ["sig1"],
      alternatives: [],
    });
    expect(decision.selected).toBe("g1");
    expect(decision.reason).toContain("signals match gene.signals_match");
    expect(decision.reason.some((r) => r.includes("sig1"))).toBe(true);
  });

  it("includes 'no matching gene' reason when gene is null", () => {
    const decision = buildSelectorDecision({
      gene: null,
      capsule: null,
      signals: [],
      alternatives: [],
    });
    expect(decision.selected).toBeNull();
    expect(decision.reason).toContain("no matching gene found; new gene may be required");
  });

  it("includes capsule match reason", () => {
    const decision = buildSelectorDecision({
      gene: null,
      capsule: { id: "c1" },
      signals: [],
      alternatives: [],
    });
    expect(decision.reason).toContain("capsule trigger matches signals");
  });

  it("includes memory advice explanation", () => {
    const decision = buildSelectorDecision({
      gene: null,
      capsule: null,
      signals: [],
      alternatives: [],
      memoryAdvice: { explanation: ["banned gene X", "preferred gene Y"] },
    });
    expect(decision.reason.some((r) => r.includes("memory_graph"))).toBe(true);
    expect(decision.reason.some((r) => r.includes("banned gene X"))).toBe(true);
  });

  it("includes drift override reason", () => {
    const decision = buildSelectorDecision({
      gene: null,
      capsule: null,
      signals: [],
      alternatives: [],
      driftEnabled: true,
    });
    expect(decision.reason).toContain("random_drift_override: true");
  });

  it("lists alternative gene ids", () => {
    const alts: Gene[] = [
      { type: "Gene", id: "alt1" },
      { type: "Gene", id: "alt2" },
    ];
    const decision = buildSelectorDecision({
      gene: { type: "Gene", id: "g1" },
      capsule: null,
      signals: [],
      alternatives: alts,
    });
    expect(decision.alternatives).toEqual(["alt1", "alt2"]);
  });
});

// ── selectGeneAndCapsule ────────────────────────────────────────────────────

describe("selectGeneAndCapsule", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.EVOLVE_PREFERRED_GENE_ID = process.env.EVOLVE_PREFERRED_GENE_ID;
    savedEnv.EVOLVE_SELECTOR_DEBUG = process.env.EVOLVE_SELECTOR_DEBUG;
    delete process.env.EVOLVE_PREFERRED_GENE_ID;
    delete process.env.EVOLVE_SELECTOR_DEBUG;
  });

  afterEach(() => {
    if (savedEnv.EVOLVE_PREFERRED_GENE_ID !== undefined) {
      process.env.EVOLVE_PREFERRED_GENE_ID = savedEnv.EVOLVE_PREFERRED_GENE_ID;
    } else {
      delete process.env.EVOLVE_PREFERRED_GENE_ID;
    }
    if (savedEnv.EVOLVE_SELECTOR_DEBUG !== undefined) {
      process.env.EVOLVE_SELECTOR_DEBUG = savedEnv.EVOLVE_SELECTOR_DEBUG;
    } else {
      delete process.env.EVOLVE_SELECTOR_DEBUG;
    }
  });

  it("selects gene, capsule, and returns selector decision", () => {
    const genes: Gene[] = [
      { type: "Gene", id: "g1", signals_match: ["error"] },
      { type: "Gene", id: "g2", signals_match: ["drift"] },
    ];
    const capsules: Capsule[] = [{ id: "c1", trigger: ["error"] }];
    const result = selectGeneAndCapsule({
      genes,
      capsules,
      signals: ["log_error"],
    });
    expect(result.selectedGene?.id).toBe("g1");
    expect(result.capsuleCandidates.length).toBe(1);
    expect(result.selector.selected).toBe("g1");
  });

  it("returns empty capsuleCandidates when no capsule matches", () => {
    const result = selectGeneAndCapsule({
      genes: [{ type: "Gene", id: "g1", signals_match: ["error"] }],
      capsules: [{ id: "c1", trigger: ["xyz"] }],
      signals: ["log_error"],
    });
    expect(result.capsuleCandidates).toEqual([]);
  });

  it("respects memoryAdvice bannedGeneIds", () => {
    const genes: Gene[] = [
      { type: "Gene", id: "g1", signals_match: ["error"] },
      { type: "Gene", id: "g2", signals_match: ["error", "drift"] },
    ];
    const advice: MemoryAdvice = { bannedGeneIds: new Set(["g2"]) };
    const result = selectGeneAndCapsule({
      genes,
      capsules: [],
      signals: ["log_error", "protocol_drift"],
      memoryAdvice: advice,
    });
    expect(result.selectedGene?.id).toBe("g1");
  });

  it("respects EVOLVE_PREFERRED_GENE_ID env var when gene matches", () => {
    process.env.EVOLVE_PREFERRED_GENE_ID = "g1";
    const genes: Gene[] = [
      { type: "Gene", id: "g1", signals_match: ["error"] },
      { type: "Gene", id: "g2", signals_match: ["error", "drift"] },
    ];
    const result = selectGeneAndCapsule({
      genes,
      capsules: [],
      signals: ["log_error", "protocol_drift"],
    });
    expect(result.selectedGene?.id).toBe("g1");
  });

  it("ignores EVOLVE_PREFERRED_GENE_ID when gene does not match signals", () => {
    process.env.EVOLVE_PREFERRED_GENE_ID = "g_nonexistent";
    const genes: Gene[] = [{ type: "Gene", id: "g1", signals_match: ["error"] }];
    const result = selectGeneAndCapsule({
      genes,
      capsules: [],
      signals: ["log_error"],
    });
    expect(result.selectedGene?.id).toBe("g1");
  });
});
