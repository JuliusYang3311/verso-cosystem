import { describe, it, expect } from "vitest";
import { SCHEMA_VERSION } from "./contentHash.js";
import { buildValidationReport, isValidValidationReport } from "./validationReport.js";

// ── buildValidationReport ───────────────────────────────────────────────────

describe("buildValidationReport", () => {
  it("builds a minimal report with defaults", () => {
    const report = buildValidationReport({});
    expect(report.type).toBe("ValidationReport");
    expect(report.schema_version).toBe(SCHEMA_VERSION);
    expect(report.id).toMatch(/^vr_\d+$/);
    expect(report.gene_id).toBeNull();
    expect(Array.isArray(report.commands)).toBe(true);
    expect(report.overall_ok).toBe(false); // no results → false
    expect(report.duration_ms).toBeNull();
    expect(typeof report.created_at).toBe("string");
    expect(typeof report.env_fingerprint).toBe("object");
    expect(typeof report.env_fingerprint_key).toBe("string");
    expect(typeof report.asset_id).toBe("string");
  });

  it("sets gene_id when provided", () => {
    const report = buildValidationReport({ geneId: "gene_abc" });
    expect(report.gene_id).toBe("gene_abc");
  });

  it("computes overall_ok from results", () => {
    const okReport = buildValidationReport({
      results: [
        { ok: true, cmd: "test1", out: "pass", err: "" },
        { ok: true, cmd: "test2", out: "pass", err: "" },
      ],
    });
    expect(okReport.overall_ok).toBe(true);

    const failReport = buildValidationReport({
      results: [
        { ok: true, cmd: "test1", out: "pass", err: "" },
        { ok: false, cmd: "test2", out: "", err: "fail" },
      ],
    });
    expect(failReport.overall_ok).toBe(false);
  });

  it("computes duration_ms from startedAt and finishedAt", () => {
    const report = buildValidationReport({
      startedAt: 1000,
      finishedAt: 2500,
    });
    expect(report.duration_ms).toBe(1500);
  });

  it("sets duration_ms to null when timestamps missing", () => {
    const report = buildValidationReport({ startedAt: 1000 });
    expect(report.duration_ms).toBeNull();
  });

  it("maps commands from results", () => {
    const report = buildValidationReport({
      results: [
        { ok: true, cmd: "npm test", out: "ok", err: "" },
        { ok: false, cmd: "npm lint", out: "", err: "errors" },
      ],
    });
    expect(report.commands.length).toBe(2);
    expect(report.commands[0].command).toBe("npm test");
    expect(report.commands[0].ok).toBe(true);
    expect(report.commands[0].stdout).toBe("ok");
    expect(report.commands[1].command).toBe("npm lint");
    expect(report.commands[1].ok).toBe(false);
    expect(report.commands[1].stderr).toBe("errors");
  });

  it("uses commands list when provided instead of results cmd", () => {
    const report = buildValidationReport({
      commands: ["cmd1", "cmd2"],
      results: [
        { ok: true, out: "a", err: "" },
        { ok: false, out: "", err: "b" },
      ],
    });
    expect(report.commands[0].command).toBe("cmd1");
    expect(report.commands[1].command).toBe("cmd2");
  });

  it("truncates stdout/stderr to 4000 chars", () => {
    const longOutput = "x".repeat(5000);
    const report = buildValidationReport({
      results: [{ ok: true, cmd: "test", out: longOutput, err: longOutput }],
    });
    expect(report.commands[0].stdout.length).toBe(4000);
    expect(report.commands[0].stderr.length).toBe(4000);
  });

  it("has a valid asset_id", () => {
    const report = buildValidationReport({
      geneId: "gene_1",
      results: [{ ok: true, cmd: "test", out: "ok", err: "" }],
    });
    expect(report.asset_id).toBeTruthy();
    expect(report.asset_id!.startsWith("sha256:")).toBe(true);
  });
});

// ── isValidValidationReport ─────────────────────────────────────────────────

describe("isValidValidationReport", () => {
  it("returns true for a valid report", () => {
    const report = buildValidationReport({
      results: [{ ok: true, cmd: "test", out: "", err: "" }],
    });
    expect(isValidValidationReport(report)).toBe(true);
  });

  it("returns false for null/undefined/non-object", () => {
    expect(isValidValidationReport(null)).toBe(false);
    expect(isValidValidationReport(undefined)).toBe(false);
    expect(isValidValidationReport("string")).toBe(false);
    expect(isValidValidationReport(42)).toBe(false);
  });

  it("returns false for wrong type field", () => {
    const report = buildValidationReport({});
    expect(isValidValidationReport({ ...report, type: "Other" })).toBe(false);
  });

  it("returns false for missing id", () => {
    const report = buildValidationReport({});
    expect(isValidValidationReport({ ...report, id: "" })).toBe(false);
    expect(isValidValidationReport({ ...report, id: null })).toBe(false);
  });

  it("returns false for non-array commands", () => {
    const report = buildValidationReport({});
    expect(isValidValidationReport({ ...report, commands: "not-array" })).toBe(false);
  });

  it("returns false for non-boolean overall_ok", () => {
    const report = buildValidationReport({});
    expect(isValidValidationReport({ ...report, overall_ok: "true" })).toBe(false);
  });
});
