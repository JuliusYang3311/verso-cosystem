/**
 * acceptance.ts — LLM-based acceptance testing for evolver cycles.
 *
 * Uses a persistent session (created by runner.ts, reused across cycles).
 * Three-phase acceptance (single LLM session):
 *   1. LLM examines workspace → proposes verifyCmd (must include lint)
 *   2. System runs verifyCmd → feeds output back to LLM
 *   3. LLM gives final acceptance verdict
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";

const logger = createSubsystemLogger("evolver-acceptance");

// ---------- Types ----------

export type EvolverAcceptanceResult = {
  passed: boolean;
  confidence: number;
  reasoning: string;
  issues?: Array<{
    severity: "critical" | "major" | "minor";
    confidence: number;
    description: string;
    file?: string;
  }>;
  verifyCmd?: string;
  verifyPassed?: boolean;
};

// ---------- Mechanical verification ----------

function runMechanicalVerify(
  workspaceDir: string,
  verifyCmd: string,
): { ok: boolean; stdout: string; stderr: string } {
  if (!verifyCmd.trim()) {
    return { ok: true, stdout: "", stderr: "" };
  }

  try {
    const output = execSync(verifyCmd, {
      cwd: workspaceDir,
      timeout: 300_000, // 5 min
      stdio: "pipe",
      encoding: "utf-8",
      shell: "/bin/bash",
    });
    return { ok: true, stdout: typeof output === "string" ? output.slice(-2000) : "", stderr: "" };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: execErr.stdout?.slice(-1000) ?? "",
      stderr: execErr.stderr?.slice(-1000) ?? String(execErr.message ?? err),
    };
  }
}

// ---------- Workspace context gathering ----------

function gatherWorkspaceContext(workspaceDir: string): string {
  const parts: string[] = [];

  const pkgPath = path.join(workspaceDir, "package.json");
  try {
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      parts.push(`package.json name: ${pkg.name ?? "(unnamed)"}`);
      if (pkg.scripts) {
        parts.push(`Available scripts: ${Object.keys(pkg.scripts).join(", ")}`);
      }
    }
  } catch {
    // ignore
  }

  if (fs.existsSync(path.join(workspaceDir, "pnpm-lock.yaml"))) {
    parts.push("Package manager: pnpm");
  } else if (fs.existsSync(path.join(workspaceDir, "yarn.lock"))) {
    parts.push("Package manager: yarn");
  } else if (fs.existsSync(path.join(workspaceDir, "package-lock.json"))) {
    parts.push("Package manager: npm");
  }

  if (fs.existsSync(path.join(workspaceDir, "tsconfig.json"))) {
    parts.push("TypeScript project (tsconfig.json present)");
  }

  try {
    const entries = fs
      .readdirSync(workspaceDir)
      .filter((e) => !e.startsWith("."))
      .slice(0, 30);
    parts.push(`Top-level files/dirs: ${entries.join(", ")}`);
  } catch {
    // ignore
  }

  return parts.join("\n");
}

// ---------- JSON parsing helper ----------

function parseAcceptanceJson(text: string): {
  passed?: boolean;
  confidence?: number;
  reasoning?: string;
  verifyCmd?: string;
  suggestedVerifyCmd?: string;
  issues?: Array<{
    severity?: string;
    confidence?: number;
    description?: string;
    file?: string;
  }>;
} | null {
  const jsonMatch = text.match(/\{[\s\S]*("passed"|"verifyCmd")[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

// ---------- Public API ----------

/**
 * Run full acceptance testing for an evolver cycle using a persistent session.
 *
 * The session is NOT created or disposed here — it's owned by runner.ts.
 */
export async function runEvolverAcceptance(params: {
  workspaceDir: string;
  filesChanged: string[];
  session: AgentSession;
  gepPrompt?: string;
}): Promise<EvolverAcceptanceResult> {
  const { workspaceDir, filesChanged, session, gepPrompt } = params;

  const wsContext = gatherWorkspaceContext(workspaceDir);
  const diffSummary = `${filesChanged.length} file(s) changed: ${filesChanged.slice(0, 10).join(", ")}`;

  const fileSnippets: string[] = [];
  for (const file of filesChanged.slice(0, 5)) {
    try {
      const fullPath = path.join(workspaceDir, file);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const content = fs.readFileSync(fullPath, "utf-8");
        const lines = content.split("\n").slice(0, 100);
        fileSnippets.push(`--- ${file} (first ${lines.length} lines) ---\n${lines.join("\n")}`);
      }
    } catch {
      // skip
    }
  }

  const TIMEOUT_MS = 300_000; // 5 minutes total

  try {
    // --- Phase 1: Ask LLM to propose verifyCmd ---

    const phase1Prompt = `You are an acceptance evaluator for code evolution cycles.

WORKSPACE DIRECTORY: ${workspaceDir}

WORKSPACE CONTEXT:
${wsContext}

${gepPrompt ? `EVOLUTION GOAL:\n${gepPrompt.slice(0, 2000)}\n` : ""}
FILES CHANGED:
${diffSummary}

${fileSnippets.length > 0 ? `FILE CONTENTS:\n${fileSnippets.join("\n\n")}\n` : ""}

Based on this workspace structure, propose a shell command to verify the changes are valid.

The command MUST include linting. Add build and/or test steps if the project supports them.
Use the correct package manager (pnpm/yarn/npm) based on the lock file.

Respond with ONLY a JSON object (no markdown fences):
{
  "verifyCmd": "the shell command to run, e.g. pnpm run lint && pnpm run build"
}`;

    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), TIMEOUT_MS),
    );

    const phase1Promise = session.prompt(phase1Prompt).then(() => "done" as const);
    const phase1Result = await Promise.race([phase1Promise, timeoutPromise]);

    if (phase1Result === "timeout") {
      try {
        await session.abort();
      } catch {
        /* ignore */
      }
      return { passed: false, confidence: 50, reasoning: "LLM timed out proposing verifyCmd" };
    }

    const phase1Text = session.getLastAssistantText?.() ?? "";
    const phase1Parsed = parseAcceptanceJson(phase1Text);
    const verifyCmd = phase1Parsed?.verifyCmd?.trim() ?? "";

    if (!verifyCmd) {
      return { passed: false, confidence: 60, reasoning: "LLM failed to propose a verifyCmd" };
    }

    logger.info("LLM proposed verifyCmd", { verifyCmd });

    // --- Phase 2: Run the proposed verifyCmd ---

    const verify = runMechanicalVerify(workspaceDir, verifyCmd);
    logger.info("Mechanical verification result", { ok: verify.ok, verifyCmd });

    // --- Phase 3: Feed results back to LLM for final verdict ---

    const verifyOutput = [verify.stdout, verify.stderr].filter(Boolean).join("\n").slice(0, 2000);

    const phase3Prompt = `The verification command you proposed has been executed.

VERIFY COMMAND: ${verifyCmd}
RESULT: ${verify.ok ? "PASSED" : "FAILED"}
${verifyOutput ? `OUTPUT:\n${verifyOutput}\n` : ""}

Now give your final acceptance verdict. Consider:

1. **Correctness**: Do the changes look correct? No obvious bugs?
2. **Safety**: No security issues or data loss risks?
3. **Relevance**: Do the changes align with the evolution goal?
4. **Minimal impact**: Are the changes focused and minimal?
5. **Code quality**: Well-structured, follows existing patterns?
6. **Verify result**: If the verify command failed, is it because of a real code issue (reject) or a bad verify command? If the verify command was wrong, you may propose a corrected one in "suggestedVerifyCmd" and the system will re-run it. If that also fails, the changes are rejected.

CONFIDENCE SCORING:
- 90-100: Absolutely certain
- 75-89: Highly confident
- 50-74: Moderately confident
- 25-49: Somewhat confident
- 0-24: Not confident

Respond with ONLY a JSON object (no markdown fences):
{
  "passed": true/false,
  "confidence": 0-100,
  "reasoning": "explanation",
  "suggestedVerifyCmd": "corrected command if original was wrong (optional)",
  "issues": [
    {
      "severity": "critical" | "major" | "minor",
      "confidence": 0-100,
      "description": "what the issue is",
      "file": "path/to/file (optional)"
    }
  ]
}`;

    const phase3Promise = session.prompt(phase3Prompt).then(() => "done" as const);
    const phase3Result = await Promise.race([phase3Promise, timeoutPromise]);

    if (phase3Result === "timeout") {
      try {
        await session.abort();
      } catch {
        /* ignore */
      }
      return {
        passed: false,
        confidence: 50,
        reasoning: "LLM timed out during evaluation",
        verifyCmd,
        verifyPassed: verify.ok,
      };
    }

    const phase3Text = session.getLastAssistantText?.() ?? "";

    if (!phase3Text) {
      return {
        passed: false,
        confidence: 100,
        reasoning: "Evaluation agent returned no result",
        verifyCmd,
        verifyPassed: verify.ok,
      };
    }

    const parsed = parseAcceptanceJson(phase3Text);
    if (!parsed) {
      const lower = phase3Text.toLowerCase();
      const passed = lower.includes('"passed"') && lower.includes("true");
      return {
        passed,
        confidence: 40,
        reasoning: phase3Text.slice(0, 500),
        verifyCmd,
        verifyPassed: verify.ok,
      };
    }

    const llmResult: EvolverAcceptanceResult = {
      passed: parsed.passed === true,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 50,
      reasoning: parsed.reasoning ?? (parsed.passed ? "Changes look good" : "Changes rejected"),
      issues: Array.isArray(parsed.issues)
        ? parsed.issues.map((i) => ({
            severity: (i.severity as "critical" | "major" | "minor") ?? "major",
            confidence: typeof i.confidence === "number" ? i.confidence : 50,
            description: i.description ?? "Unknown issue",
            file: i.file,
          }))
        : undefined,
      verifyCmd,
      verifyPassed: verify.ok,
    };

    // If verify failed but LLM suggests a corrected command, re-run it
    const suggestedCmd = parsed.suggestedVerifyCmd?.trim();
    if (!verify.ok && suggestedCmd) {
      logger.info("LLM suggested corrected verifyCmd, re-running", { suggestedCmd });
      const retryVerify = runMechanicalVerify(workspaceDir, suggestedCmd);

      if (retryVerify.ok) {
        logger.info("Corrected verifyCmd passed — accepting");
        return { ...llmResult, passed: true, verifyCmd: suggestedCmd, verifyPassed: true };
      } else {
        logger.warn("Corrected verifyCmd also failed — rejecting");
        return {
          passed: false,
          confidence: 90,
          reasoning: `Corrected verify command also failed: ${retryVerify.stderr.slice(0, 500)}`,
          verifyCmd: suggestedCmd,
          verifyPassed: false,
        };
      }
    }

    return llmResult;
  } catch (err) {
    logger.warn("Acceptance evaluation failed", { error: String(err) });
    return {
      passed: false,
      confidence: 100,
      reasoning: `Acceptance evaluation failed: ${String(err)}`,
    };
  }
}
