import { describe, it, expect } from "vitest";
import { extractCapabilityCandidates, renderCandidatesPreview } from "./candidates.js";

// ── extractCapabilityCandidates ─────────────────────────────────────────────

describe("extractCapabilityCandidates", () => {
  it("returns empty array for empty transcript and no signals", () => {
    const result = extractCapabilityCandidates({
      recentSessionTranscript: "",
      signals: [],
    });
    expect(result).toEqual([]);
  });

  it("extracts candidates from repeated tool calls in transcript", () => {
    const transcript = [
      "[TOOL: read_file] some output",
      "[TOOL: read_file] more output",
      "[TOOL: write_file] output",
    ].join("\n");
    const result = extractCapabilityCandidates({
      recentSessionTranscript: transcript,
      signals: [],
    });
    // read_file appears 2 times (>=2), write_file appears 1 time (<2)
    expect(result.length).toBe(1);
    expect(result[0].title).toContain("read_file");
    expect(result[0].type).toBe("CapabilityCandidate");
    expect(result[0].source).toBe("transcript");
    expect(result[0].id).toMatch(/^cand_/);
  });

  it("ignores tool calls that appear only once", () => {
    const transcript = "[TOOL: single_call] output";
    const result = extractCapabilityCandidates({
      recentSessionTranscript: transcript,
      signals: [],
    });
    expect(result).toEqual([]);
  });

  it("extracts candidates from known signals", () => {
    const result = extractCapabilityCandidates({
      recentSessionTranscript: "",
      signals: ["log_error", "perf_bottleneck"],
    });
    expect(result.length).toBe(2);
    const titles = result.map((c) => c.title);
    expect(titles.some((t) => t.includes("error"))).toBe(true);
    expect(titles.some((t) => t.includes("bottleneck"))).toBe(true);
    expect(result.every((c) => c.source === "signals")).toBe(true);
  });

  it("extracts from both transcript and signals", () => {
    const transcript = "[TOOL: myTool] a\n[TOOL: myTool] b\n[TOOL: myTool] c";
    const result = extractCapabilityCandidates({
      recentSessionTranscript: transcript,
      signals: ["user_feature_request"],
    });
    expect(result.length).toBe(2);
    expect(result.some((c) => c.source === "transcript")).toBe(true);
    expect(result.some((c) => c.source === "signals")).toBe(true);
  });

  it("deduplicates by id", () => {
    // Same tool repeated → same id
    const transcript = "[TOOL: read_file] a\n[TOOL: read_file] b";
    const result = extractCapabilityCandidates({
      recentSessionTranscript: transcript,
      signals: [],
    });
    const ids = result.map((c) => c.id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });

  it("produces valid FiveQuestionsShape in each candidate", () => {
    const result = extractCapabilityCandidates({
      recentSessionTranscript: "",
      signals: ["log_error"],
    });
    expect(result.length).toBeGreaterThan(0);
    const shape = result[0].shape;
    expect(typeof shape.title).toBe("string");
    expect(typeof shape.input).toBe("string");
    expect(typeof shape.output).toBe("string");
    expect(typeof shape.invariants).toBe("string");
    expect(typeof shape.params).toBe("string");
    expect(typeof shape.failure_points).toBe("string");
    expect(typeof shape.evidence).toBe("string");
  });

  it("includes all known signal-based candidates", () => {
    const allSignals = [
      "log_error",
      "protocol_drift",
      "windows_shell_incompatible",
      "session_logs_missing",
      "user_feature_request",
      "user_improvement_suggestion",
      "perf_bottleneck",
      "capability_gap",
      "stable_success_plateau",
      "external_opportunity",
    ];
    const result = extractCapabilityCandidates({
      recentSessionTranscript: "",
      signals: allSignals,
    });
    expect(result.length).toBe(10);
  });
});

// ── renderCandidatesPreview ─────────────────────────────────────────────────

describe("renderCandidatesPreview", () => {
  it("returns empty string for null/empty", () => {
    expect(renderCandidatesPreview(null)).toBe("");
    expect(renderCandidatesPreview([])).toBe("");
    expect(renderCandidatesPreview(undefined)).toBe("");
  });

  it("renders candidate info", () => {
    const candidates = extractCapabilityCandidates({
      recentSessionTranscript: "",
      signals: ["log_error"],
    });
    const preview = renderCandidatesPreview(candidates);
    expect(preview).toContain("cand_");
    expect(preview).toContain("input:");
    expect(preview).toContain("output:");
    expect(preview).toContain("invariants:");
  });

  it("truncates to maxChars", () => {
    const candidates = extractCapabilityCandidates({
      recentSessionTranscript: "",
      signals: ["log_error", "perf_bottleneck", "capability_gap", "protocol_drift"],
    });
    const preview = renderCandidatesPreview(candidates, 200);
    expect(preview.length).toBeLessThanOrEqual(200);
    expect(preview).toContain("TRUNCATED");
  });
});
