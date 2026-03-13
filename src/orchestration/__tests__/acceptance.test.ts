// src/orchestration/__tests__/acceptance.test.ts — Tests for acceptance fact-checking
//
// Covers:
// 1. Acceptance prompt includes fact-check instructions
// 2. Fact-check result parsing from LLM JSON response
// 3. Auto-fail when contradiction ratio exceeds 30%
// 4. Confidence capping on fact-check failure
// 5. Graceful handling when factCheck is absent (pure code tasks)
// 6. Research-first rule in orchestrator prompt

import { describe, it, expect } from "vitest";
import { buildAcceptanceFirstPrompt, buildAcceptanceRetryPrompt } from "../acceptance-prompt.js";
import { buildOrchestratorSystemPrompt } from "../orchestrator-prompt.js";
import { createOrchestration, createSubtask } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOrchestration(userPrompt = "Build a test project") {
  const orch = createOrchestration({
    id: "test-orch",
    userPrompt,
    orchestratorSessionKey: "sk-test",
    agentId: "agent-test",
    workspaceDir: "/tmp/test-ws",
    sourceWorkspaceDir: "/tmp/test-src",
  });
  orch.plan = {
    summary: "Test plan",
    subtasks: [
      createSubtask({
        id: "t1",
        title: "Task 1",
        description: "Do something",
        acceptanceCriteria: ["it works"],
        specialization: "code-implementer",
      }),
    ],
  };
  orch.plan.subtasks[0].status = "completed";
  orch.plan.subtasks[0].resultSummary = "Task completed successfully";
  return orch;
}

/**
 * Simulate the fact-check parsing logic from acceptance.ts
 * (extracted for testability without needing real LLM sessions)
 */
function parseAcceptanceVerdict(jsonText: string) {
  const jsonMatch = jsonText.match(/\{[\s\S]*"passed"[\s\S]*\}/);
  if (!jsonMatch) return null;

  const parsed = JSON.parse(jsonMatch[0]) as {
    passed?: boolean;
    confidence?: number;
    reasoning?: string;
    issues?: Array<{
      severity?: string;
      description?: string;
      file?: string;
      line?: number;
    }>;
    factCheck?: {
      checked?: number;
      verified?: number;
      contradicted?: number;
      unverifiable?: number;
      details?: Array<{
        claim?: string;
        status?: string;
        source?: string;
      }>;
    };
  };

  let confidence = typeof parsed.confidence === "number" ? parsed.confidence : 100;
  const issues =
    Array.isArray(parsed.issues) && parsed.issues.length > 0
      ? parsed.issues.map((issue) => ({
          severity: (issue.severity as "critical" | "major" | "minor") ?? "major",
          confidence: 100,
          description: issue.description ?? "Unknown issue",
          file: issue.file,
          line: issue.line,
        }))
      : [];

  let factCheck;
  let factCheckFailed = false;

  if (
    parsed.factCheck &&
    typeof parsed.factCheck.checked === "number" &&
    parsed.factCheck.checked > 0
  ) {
    factCheck = {
      checked: parsed.factCheck.checked,
      verified: parsed.factCheck.verified ?? 0,
      contradicted: parsed.factCheck.contradicted ?? 0,
      unverifiable: parsed.factCheck.unverifiable ?? 0,
      details: Array.isArray(parsed.factCheck.details)
        ? parsed.factCheck.details.map((d) => ({
            claim: d.claim ?? "",
            status: (d.status as "verified" | "contradicted" | "unverifiable") ?? "unverifiable",
            source: d.source,
          }))
        : undefined,
    };

    const contradictionRatio = factCheck.contradicted / factCheck.checked;
    if (contradictionRatio > 0.3) {
      factCheckFailed = true;
      confidence = Math.min(confidence, 40);
      issues.push({
        severity: "critical",
        confidence: 95,
        description: `Fact-check failure: ${factCheck.contradicted}/${factCheck.checked} claims contradicted by authoritative sources (${(contradictionRatio * 100).toFixed(0)}% contradiction rate)`,
        file: undefined,
        line: undefined,
      });
    }
  }

  return {
    passed: factCheckFailed ? false : parsed.passed === true,
    confidence,
    reasoning: parsed.reasoning ?? "",
    issues,
    factCheck,
    factCheckFailed,
  };
}

// ---------------------------------------------------------------------------
// Acceptance prompt tests
// ---------------------------------------------------------------------------

describe("Acceptance prompt — fact-check instructions", () => {
  it("first prompt includes fact-check in evaluation philosophy", () => {
    const prompt = buildAcceptanceFirstPrompt({
      orchestration: makeOrchestration(),
      workspaceDir: "/tmp/test",
    });
    expect(prompt).toContain("Fact-check key claims");
    expect(prompt).toContain("web_search");
  });

  it("first prompt includes fact-check in process steps", () => {
    const prompt = buildAcceptanceFirstPrompt({
      orchestration: makeOrchestration(),
      workspaceDir: "/tmp/test",
    });
    expect(prompt).toContain("spot-check at least 3-5 key data points");
    expect(prompt).toContain("authoritative sources");
  });

  it("first prompt includes factCheck in response format", () => {
    const prompt = buildAcceptanceFirstPrompt({
      orchestration: makeOrchestration(),
      workspaceDir: "/tmp/test",
    });
    expect(prompt).toContain('"factCheck"');
    expect(prompt).toContain('"checked"');
    expect(prompt).toContain('"contradicted"');
    expect(prompt).toContain('"verified"');
    expect(prompt).toContain('"unverifiable"');
  });

  it("first prompt mentions 30% contradiction threshold", () => {
    const prompt = buildAcceptanceFirstPrompt({
      orchestration: makeOrchestration(),
      workspaceDir: "/tmp/test",
    });
    expect(prompt).toContain(">30%");
  });

  it("retry prompt still includes task context", () => {
    const prompt = buildAcceptanceRetryPrompt({
      orchestration: makeOrchestration(),
      workspaceDir: "/tmp/test",
      fixCycle: 1,
    });
    expect(prompt).toContain("Re-evaluation");
    expect(prompt).toContain("Fix Cycle 1");
    expect(prompt).toContain("Build a test project");
  });
});

// ---------------------------------------------------------------------------
// Fact-check verdict parsing
// ---------------------------------------------------------------------------

describe("Acceptance verdict parsing — fact-check", () => {
  it("parses verdict with all facts verified", () => {
    const json = JSON.stringify({
      passed: true,
      confidence: 90,
      reasoning: "All good",
      issues: [],
      factCheck: {
        checked: 5,
        verified: 5,
        contradicted: 0,
        unverifiable: 0,
        details: [
          { claim: "S&P 500 at 6672", status: "verified", source: "CNBC" },
          { claim: "Fed rate 3.50-3.75%", status: "verified", source: "Federal Reserve" },
          { claim: "CPI 2.4%", status: "verified", source: "BLS" },
          { claim: "Unemployment 4.4%", status: "verified", source: "BLS" },
          { claim: "NVDA ~$185", status: "verified", source: "Yahoo Finance" },
        ],
      },
    });

    const result = parseAcceptanceVerdict(json);
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
    expect(result!.confidence).toBe(90);
    expect(result!.factCheck?.checked).toBe(5);
    expect(result!.factCheck?.verified).toBe(5);
    expect(result!.factCheck?.contradicted).toBe(0);
    expect(result!.factCheckFailed).toBe(false);
  });

  it("auto-fails when >30% claims contradicted", () => {
    const json = JSON.stringify({
      passed: true, // LLM says pass, but fact-check should override
      confidence: 85,
      reasoning: "Looks fine",
      issues: [],
      factCheck: {
        checked: 5,
        verified: 1,
        contradicted: 3, // 60% contradicted
        unverifiable: 1,
        details: [
          { claim: "NVDA at $985", status: "contradicted", source: "Yahoo Finance shows $185" },
          { claim: "Fed rate 4.25-4.50%", status: "contradicted", source: "Fed shows 3.50-3.75%" },
          { claim: "S&P at 5842", status: "contradicted", source: "CNBC shows 6672" },
          { claim: "AI sector +4.82%", status: "verified", source: "MarketWatch" },
          { claim: "GDP 2.3%", status: "unverifiable" },
        ],
      },
    });

    const result = parseAcceptanceVerdict(json);
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false); // Overridden to false
    expect(result!.factCheckFailed).toBe(true);
    expect(result!.confidence).toBeLessThanOrEqual(40); // Capped
    expect(result!.issues.some((i) => i.description.includes("Fact-check failure"))).toBe(true);
    expect(result!.issues.some((i) => i.description.includes("60%"))).toBe(true);
  });

  it("does not fail when exactly 30% contradicted (boundary)", () => {
    const json = JSON.stringify({
      passed: true,
      confidence: 80,
      reasoning: "Mostly good",
      factCheck: {
        checked: 10,
        verified: 5,
        contradicted: 3, // exactly 30%
        unverifiable: 2,
      },
    });

    const result = parseAcceptanceVerdict(json);
    expect(result!.passed).toBe(true);
    expect(result!.factCheckFailed).toBe(false);
    expect(result!.confidence).toBe(80); // Not capped
  });

  it("fails when 31%+ contradicted (just over boundary)", () => {
    const json = JSON.stringify({
      passed: true,
      confidence: 80,
      reasoning: "Mostly good",
      factCheck: {
        checked: 10,
        verified: 4,
        contradicted: 4, // 40% > 30%
        unverifiable: 2,
      },
    });

    const result = parseAcceptanceVerdict(json);
    expect(result!.passed).toBe(false);
    expect(result!.factCheckFailed).toBe(true);
    expect(result!.confidence).toBeLessThanOrEqual(40);
  });

  it("handles missing factCheck gracefully (pure code tasks)", () => {
    const json = JSON.stringify({
      passed: true,
      confidence: 95,
      reasoning: "Code works",
      issues: [],
    });

    const result = parseAcceptanceVerdict(json);
    expect(result!.passed).toBe(true);
    expect(result!.confidence).toBe(95);
    expect(result!.factCheck).toBeUndefined();
    expect(result!.factCheckFailed).toBe(false);
  });

  it("handles factCheck with checked=0 (no factual claims)", () => {
    const json = JSON.stringify({
      passed: true,
      confidence: 90,
      reasoning: "Pure code",
      factCheck: { checked: 0, verified: 0, contradicted: 0, unverifiable: 0 },
    });

    const result = parseAcceptanceVerdict(json);
    expect(result!.passed).toBe(true);
    expect(result!.factCheck).toBeUndefined(); // checked=0 → not stored
    expect(result!.factCheckFailed).toBe(false);
  });

  it("caps confidence even when LLM reports high confidence", () => {
    const json = JSON.stringify({
      passed: true,
      confidence: 100,
      reasoning: "Perfect report",
      factCheck: {
        checked: 4,
        verified: 0,
        contradicted: 4, // 100% contradicted
        unverifiable: 0,
      },
    });

    const result = parseAcceptanceVerdict(json);
    expect(result!.passed).toBe(false);
    expect(result!.confidence).toBe(40); // Capped from 100 → 40
  });

  it("preserves existing issues alongside fact-check issue", () => {
    const json = JSON.stringify({
      passed: false,
      confidence: 70,
      reasoning: "Multiple problems",
      issues: [{ severity: "major", description: "Missing error handling", file: "api.ts" }],
      factCheck: {
        checked: 3,
        verified: 0,
        contradicted: 2,
        unverifiable: 1,
      },
    });

    const result = parseAcceptanceVerdict(json);
    expect(result!.passed).toBe(false);
    expect(result!.issues).toHaveLength(2); // Original + fact-check
    expect(result!.issues[0].description).toBe("Missing error handling");
    expect(result!.issues[1].description).toContain("Fact-check failure");
  });

  it("parses details with source URLs", () => {
    const json = JSON.stringify({
      passed: true,
      confidence: 85,
      reasoning: "Good",
      factCheck: {
        checked: 2,
        verified: 2,
        contradicted: 0,
        unverifiable: 0,
        details: [
          {
            claim: "Fed rate is 3.50-3.75%",
            status: "verified",
            source: "https://federalreserve.gov/...",
          },
          { claim: "CPI is 2.4%", status: "verified", source: "https://bls.gov/..." },
        ],
      },
    });

    const result = parseAcceptanceVerdict(json);
    expect(result!.factCheck?.details).toHaveLength(2);
    expect(result!.factCheck?.details?.[0].source).toContain("federalreserve.gov");
    expect(result!.factCheck?.details?.[1].status).toBe("verified");
  });
});

// ---------------------------------------------------------------------------
// Orchestrator prompt — research-first rule
// ---------------------------------------------------------------------------

describe("Orchestrator prompt — research data-first rule", () => {
  const prompt = buildOrchestratorSystemPrompt();

  it("includes data-first rule section", () => {
    expect(prompt).toContain("Data-First Rule");
  });

  it("requires researcher specialization for data gathering", () => {
    expect(prompt).toContain("researcher");
    expect(prompt).toContain("data-gathering tasks");
  });

  it("requires dependsOn for analysis tasks", () => {
    expect(prompt).toContain("dependsOn");
    expect(prompt).toContain("data-gathering tasks");
  });

  it("requires source attribution in acceptance criteria", () => {
    expect(prompt).toContain("source attribution");
    expect(prompt).toContain("source URL");
    expect(prompt).toContain("retrieval timestamp");
  });

  it("prohibits fabricating data from model memory", () => {
    expect(prompt).toContain("model memory alone");
    expect(prompt).toContain("data unavailable");
  });

  it("includes good vs bad example for research tasks", () => {
    expect(prompt).toContain("BAD");
    expect(prompt).toContain("GOOD");
    expect(prompt).toContain("Gather US macro indicators");
    expect(prompt).toContain("memory_search");
  });

  it("updates research workflow to include data gathering", () => {
    expect(prompt).toContain("gather data");
  });
});
