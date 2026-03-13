// src/orchestration/acceptance-prompt.ts — Acceptance evaluator prompts
//
// The acceptance agent is a persistent session. It may be called multiple
// times per orchestration (initial run + after fix cycles). The first call
// establishes its identity; subsequent calls only provide the delta.
//
// NOTE: The acceptance evaluator makes a HOLISTIC task-level judgment.
// Per-issue confidence scoring is the code-reviewer's job — acceptance
// does not duplicate it. Acceptance asks: "Does the project satisfy the
// original task?" not "Does line 42 have a bug?"

import type { Orchestration, Subtask } from "./types.js";

/**
 * First acceptance evaluation — full identity + task context.
 */
export function buildAcceptanceFirstPrompt(params: {
  orchestration: Orchestration;
  workspaceDir: string;
  verifyOutput?: string;
  verifyPassed?: boolean;
}): string {
  const { orchestration, workspaceDir, verifyOutput, verifyPassed } = params;
  const subtasks = orchestration.plan?.subtasks ?? [];

  const parts: string[] = [
    "## Acceptance Evaluator",
    "",
    "You evaluate whether an orchestrated project satisfies its original task.",
    "",
    "### Evaluation Philosophy",
    "",
    "- **Holistic, not pedantic** — minor issues don't block if the overall goal is met",
    '- **Task-level judgment** — ask "does this accomplish what was requested?" not "is every line perfect?"',
    "- **Verify output matters** — if the verify command passes, the bar for failure is high",
    "- **Examine the workspace** — read key files, don't just trust worker summaries",
    "- **Fact-check key claims** — use web_search to verify critical data points against authoritative sources",
    "",
    "### Process",
    "",
    "1. Read the original task and plan",
    "2. Review subtask outcomes and worker summaries",
    "3. Examine the workspace — read key files to verify claims",
    "4. If a verify command ran, weigh its result heavily",
    "5. **Fact-check**: If the output contains factual claims (statistics, dates, prices, quotes, technical specs, API references, etc.), use `web_search` to spot-check at least 3-5 key data points against authoritative sources. Flag any unverifiable or contradicted claims as issues.",
    "6. Make a holistic pass/fail decision",
    "",
    "### Response Format",
    "",
    "Respond with JSON:",
    "```json",
    `{`,
    `  "passed": true | false,`,
    `  "confidence": 0-100,`,
    `  "reasoning": "Brief explanation of your verdict",`,
    `  "issues": [{ "severity": "critical"|"major"|"minor", "description": "...", "file": "..." }],`,
    `  "factCheck": {`,
    `    "checked": 0,`,
    `    "verified": 0,`,
    `    "contradicted": 0,`,
    `    "unverifiable": 0,`,
    `    "details": [{ "claim": "...", "status": "verified"|"contradicted"|"unverifiable", "source": "..." }]`,
    `  }`,
    `}`,
    "```",
    "",
    "- `passed`: true if the project accomplishes the original task",
    "- `confidence`: your confidence in the verdict (not per-issue)",
    "- `issues`: only list issues that meaningfully block task completion",
    "- `factCheck`: summary of spot-checked factual claims (use web_search to verify). If the output has no factual claims (e.g. pure code), set checked=0 and omit details.",
    "- A high ratio of contradicted claims (>30%) should lower confidence and flag as a major issue",
    "- Omit minor style/preference issues — those are the reviewer's domain",
    "",
    "---",
    "",
  ];

  parts.push(
    formatEvalBlock({ orchestration, subtasks, workspaceDir, verifyOutput, verifyPassed }),
  );

  return parts.join("\n");
}

/**
 * Subsequent acceptance evaluation (after fix cycles).
 * Compact — the session already knows its role and the project.
 */
export function buildAcceptanceRetryPrompt(params: {
  orchestration: Orchestration;
  workspaceDir: string;
  fixCycle: number;
  verifyOutput?: string;
  verifyPassed?: boolean;
}): string {
  const { orchestration, workspaceDir, fixCycle, verifyOutput, verifyPassed } = params;
  const subtasks = orchestration.plan?.subtasks ?? [];

  const parts: string[] = [
    `## Re-evaluation (Fix Cycle ${fixCycle})`,
    "",
    "Fix workers have addressed previous issues. Re-evaluate with fresh eyes.",
    "Focus on whether previously-identified issues are resolved and check for regressions.",
    "",
  ];

  parts.push(
    formatEvalBlock({ orchestration, subtasks, workspaceDir, verifyOutput, verifyPassed }),
  );

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function formatEvalBlock(params: {
  orchestration: Orchestration;
  subtasks: Subtask[];
  workspaceDir: string;
  verifyOutput?: string;
  verifyPassed?: boolean;
}): string {
  const { orchestration, subtasks, workspaceDir, verifyOutput, verifyPassed } = params;

  const subtaskSummary = subtasks
    .map((s) => `- [${s.status}] ${s.title}: ${s.resultSummary?.slice(0, 500) ?? "no summary"}`)
    .join("\n");

  const parts = [
    `**Original Task:** ${orchestration.userPrompt}`,
    "",
    `**Plan:** ${orchestration.plan?.summary ?? "No plan summary"}`,
    "",
    `**Subtasks:**`,
    subtaskSummary,
    "",
    `**Workspace:** \`${workspaceDir}\``,
  ];

  if (verifyOutput !== undefined) {
    parts.push(
      "",
      `**Verify command ${verifyPassed ? "PASSED" : "FAILED"}:**`,
      "```",
      verifyOutput.slice(0, 2000),
      "```",
    );
  }

  parts.push("", "Examine the workspace, then respond with the JSON verdict.");

  return parts.join("\n");
}
