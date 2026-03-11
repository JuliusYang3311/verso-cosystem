import { describe, it, expect, vi } from "vitest";

// Mock assetStore to avoid file I/O
vi.mock("./assetStore.js", () => ({
  readAllEvents: () => [],
}));

// Mock paths
vi.mock("./paths.js", () => ({
  getGepAssetsDir: () => "/tmp/fake-gep",
  getEvolverAssetsDir: () => "/tmp/fake-evolver",
  getWorkspaceRoot: () => "/tmp/fake-workspace",
  getRepoRoot: () => process.cwd(),
}));

import {
  isAllowedA2AAsset,
  isBlastRadiusSafe,
  lowerConfidence,
  computeCapsuleSuccessStreak,
  isCapsuleBroadcastEligible,
  exportEligibleCapsules,
  parseA2AInput,
} from "./a2a.js";

describe("isAllowedA2AAsset", () => {
  it("returns false for null/undefined/non-object", () => {
    expect(isAllowedA2AAsset(null)).toBe(false);
    expect(isAllowedA2AAsset(undefined)).toBe(false);
    expect(isAllowedA2AAsset("string")).toBe(false);
  });

  it("returns true for Gene, Capsule, EvolutionEvent", () => {
    expect(isAllowedA2AAsset({ type: "Gene" })).toBe(true);
    expect(isAllowedA2AAsset({ type: "Capsule" })).toBe(true);
    expect(isAllowedA2AAsset({ type: "EvolutionEvent" })).toBe(true);
  });

  it("returns false for unknown types", () => {
    expect(isAllowedA2AAsset({ type: "Other" })).toBe(false);
    expect(isAllowedA2AAsset({})).toBe(false);
  });
});

describe("isBlastRadiusSafe", () => {
  it("returns true when within default limits (5 files, 200 lines)", () => {
    expect(isBlastRadiusSafe({ files: 3, lines: 100 })).toBe(true);
    expect(isBlastRadiusSafe({ files: 5, lines: 200 })).toBe(true);
  });

  it("returns false when exceeding limits", () => {
    expect(isBlastRadiusSafe({ files: 6, lines: 100 })).toBe(false);
    expect(isBlastRadiusSafe({ files: 3, lines: 201 })).toBe(false);
  });

  it("returns true for null/undefined (0 files, 0 lines)", () => {
    expect(isBlastRadiusSafe(null)).toBe(true);
    expect(isBlastRadiusSafe(undefined)).toBe(true);
  });
});

describe("lowerConfidence", () => {
  it("returns null for non-allowed asset types", () => {
    expect(lowerConfidence({ type: "Other" })).toBeNull();
  });

  it("lowers confidence on Capsule by default factor 0.6", () => {
    const result = lowerConfidence({ type: "Capsule", confidence: 1.0 });
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeCloseTo(0.6);
  });

  it("lowers confidence by custom factor", () => {
    const result = lowerConfidence({ type: "Capsule", confidence: 1.0 }, { factor: 0.5 });
    expect(result!.confidence).toBeCloseTo(0.5);
  });

  it("does not modify confidence on Gene", () => {
    const result = lowerConfidence({ type: "Gene", id: "g1" });
    expect(result).not.toBeNull();
    expect(result!.type).toBe("Gene");
  });

  it("sets a2a metadata", () => {
    const result = lowerConfidence(
      { type: "Capsule", confidence: 0.8 },
      { source: "peer_node", factor: 0.7 },
    );
    expect(result).not.toBeNull();
    const a2a = result!.a2a as Record<string, unknown>;
    expect(a2a.status).toBe("external_candidate");
    expect(a2a.source).toBe("peer_node");
    expect(a2a.confidence_factor).toBe(0.7);
  });

  it("clamps confidence to [0, 1]", () => {
    const result = lowerConfidence({ type: "Capsule", confidence: 2.0 }, { factor: 0.8 });
    expect(result!.confidence).toBeLessThanOrEqual(1);
  });
});

describe("computeCapsuleSuccessStreak", () => {
  it("returns 0 for empty capsuleId", () => {
    expect(computeCapsuleSuccessStreak({ capsuleId: "" })).toBe(0);
  });

  it("returns 0 for no matching events", () => {
    expect(computeCapsuleSuccessStreak({ capsuleId: "c1", events: [] })).toBe(0);
  });

  it("counts consecutive successes from the end", () => {
    const events = [
      { type: "EvolutionEvent", capsule_id: "c1", outcome: { status: "failed" } },
      { type: "EvolutionEvent", capsule_id: "c1", outcome: { status: "success" } },
      { type: "EvolutionEvent", capsule_id: "c1", outcome: { status: "success" } },
    ];
    expect(computeCapsuleSuccessStreak({ capsuleId: "c1", events })).toBe(2);
  });

  it("breaks streak on non-success", () => {
    const events = [
      { type: "EvolutionEvent", capsule_id: "c1", outcome: { status: "success" } },
      { type: "EvolutionEvent", capsule_id: "c1", outcome: { status: "failed" } },
      { type: "EvolutionEvent", capsule_id: "c1", outcome: { status: "success" } },
    ];
    expect(computeCapsuleSuccessStreak({ capsuleId: "c1", events })).toBe(1);
  });

  it("ignores events for other capsules", () => {
    const events = [
      { type: "EvolutionEvent", capsule_id: "c2", outcome: { status: "success" } },
      { type: "EvolutionEvent", capsule_id: "c1", outcome: { status: "success" } },
    ];
    expect(computeCapsuleSuccessStreak({ capsuleId: "c1", events })).toBe(1);
  });
});

describe("isCapsuleBroadcastEligible", () => {
  const events = [
    { type: "EvolutionEvent", capsule_id: "c1", outcome: { status: "success" } },
    { type: "EvolutionEvent", capsule_id: "c1", outcome: { status: "success" } },
    { type: "EvolutionEvent", capsule_id: "c1", outcome: { status: "success" } },
  ];

  it("returns false for null capsule", () => {
    expect(isCapsuleBroadcastEligible(null)).toBe(false);
  });

  it("returns false for non-Capsule type", () => {
    expect(isCapsuleBroadcastEligible({ type: "Gene", id: "g1" }, { events })).toBe(false);
  });

  it("returns false when score < 0.7", () => {
    const capsule = {
      type: "Capsule",
      id: "c1",
      outcome: { score: 0.5 },
      blast_radius: { files: 1, lines: 10 },
    };
    expect(isCapsuleBroadcastEligible(capsule, { events })).toBe(false);
  });

  it("returns false when blast radius exceeds limits", () => {
    const capsule = {
      type: "Capsule",
      id: "c1",
      outcome: { score: 0.9 },
      blast_radius: { files: 100, lines: 1000 },
    };
    expect(isCapsuleBroadcastEligible(capsule, { events })).toBe(false);
  });

  it("returns false when streak < 2", () => {
    const capsule = {
      type: "Capsule",
      id: "c1",
      outcome: { score: 0.9 },
      blast_radius: { files: 1, lines: 10 },
    };
    expect(isCapsuleBroadcastEligible(capsule, { events: [] })).toBe(false);
  });

  it("returns true when all conditions met", () => {
    const capsule = {
      type: "Capsule",
      id: "c1",
      outcome: { score: 0.9 },
      blast_radius: { files: 1, lines: 10 },
    };
    expect(isCapsuleBroadcastEligible(capsule, { events })).toBe(true);
  });
});

describe("exportEligibleCapsules", () => {
  it("returns empty array when no capsules are eligible", () => {
    expect(exportEligibleCapsules({ capsules: [], events: [] })).toEqual([]);
  });

  it("filters to only eligible capsules", () => {
    const events = [
      { type: "EvolutionEvent", capsule_id: "c1", outcome: { status: "success" } },
      { type: "EvolutionEvent", capsule_id: "c1", outcome: { status: "success" } },
      { type: "EvolutionEvent", capsule_id: "c1", outcome: { status: "success" } },
    ];
    const capsules = [
      {
        type: "Capsule",
        id: "c1",
        outcome: { score: 0.9 },
        blast_radius: { files: 1, lines: 10 },
      },
      {
        type: "Capsule",
        id: "c2",
        outcome: { score: 0.3 },
        blast_radius: { files: 1, lines: 10 },
      },
    ];
    const result = exportEligibleCapsules({ capsules, events });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("c1");
  });
});

describe("parseA2AInput", () => {
  it("returns empty array for null/empty", () => {
    expect(parseA2AInput(null)).toEqual([]);
    expect(parseA2AInput("")).toEqual([]);
  });

  it("parses single JSON object", () => {
    const result = parseA2AInput(JSON.stringify({ type: "Gene", id: "g1" }));
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("Gene");
  });

  it("parses JSON array", () => {
    const result = parseA2AInput(
      JSON.stringify([
        { type: "Gene", id: "g1" },
        { type: "Capsule", id: "c1" },
      ]),
    );
    expect(result).toHaveLength(2);
  });

  it("parses JSONL (line-by-line)", () => {
    const input = '{"type":"Gene","id":"g1"}\n{"type":"Capsule","id":"c1"}';
    const result = parseA2AInput(input);
    expect(result).toHaveLength(2);
  });

  it("skips invalid JSONL lines", () => {
    const input = '{"type":"Gene","id":"g1"}\nnot-json\n{"type":"Capsule","id":"c1"}';
    const result = parseA2AInput(input);
    expect(result).toHaveLength(2);
  });
});
