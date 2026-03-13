// src/orchestration/acceptance.ts — Acceptance testing for orchestrations
//
// The acceptance agent uses a PERSISTENT session that carries context across
// evaluations. First evaluation gets full identity + task context; subsequent
// evaluations (after fix cycles) get a compact re-evaluation prompt. This lets
// the evaluator compare before/after and judge whether fixes actually improved things.

import { execSync } from "node:child_process";
import type {
  AcceptanceResult,
  AcceptanceVerdict,
  FactCheckResult,
  Orchestration,
} from "./types.js";

const logger = {
  info: (...args: unknown[]) => console.log("[orchestration-acceptance]", ...args),
  warn: (...args: unknown[]) => console.warn("[orchestration-acceptance]", ...args),
  error: (...args: unknown[]) => console.error("[orchestration-acceptance]", ...args),
};

export type AcceptanceTestParams = {
  orchestration: Orchestration;
  workspaceDir: string;
  verifyCmd: string;
  /** Persistent acceptance session — carries context across evaluations. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any;
  /** SessionManager for acceptance session (utilization attribution). */
  sessionManager?: unknown;
  /** Number of evaluations already completed on this session (0 = first). */
  evaluationCount: number;
  /** Isolated memory manager shared across orchestrator, workers, and acceptance. */
  memoryManager?: import("../memory/types.js").MemorySearchManager;
};

/**
 * Run acceptance tests: first a mechanical verify command (build/lint/test),
 * then LLM-based evaluation of the overall project against the original user task.
 *
 * The session is persistent — on first call it receives the full evaluator identity;
 * on subsequent calls it receives a compact re-evaluation prompt with delta context.
 */
export async function runAcceptanceTests(params: AcceptanceTestParams): Promise<AcceptanceResult> {
  const { orchestration, workspaceDir, verifyCmd, session, evaluationCount } = params;
  const verdicts: AcceptanceVerdict[] = [];

  // Step 1: Run mechanical verify command (optional - skip if empty)
  let verifyPassed = true;
  let verifyOutput = "";

  if (verifyCmd && verifyCmd.trim()) {
    try {
      const output = execSync(verifyCmd, {
        cwd: workspaceDir,
        timeout: 300_000, // 5 min
        stdio: "pipe",
        encoding: "utf-8",
        shell: "/bin/bash",
      });
      verifyOutput = typeof output === "string" ? output.slice(-2000) : "";
    } catch (err: unknown) {
      verifyPassed = false;
      const execErr = err as { stdout?: string; stderr?: string; message?: string };
      verifyOutput =
        [execErr.stdout?.slice(-1000), execErr.stderr?.slice(-1000)].filter(Boolean).join("\n") ||
        String(execErr.message ?? err);
    }

    if (!verifyPassed) {
      verdicts.push({
        subtaskId: "overall",
        passed: false,
        confidence: 100,
        reasoning: `Verify command failed:\n${verifyOutput.slice(0, 500)}`,
      });
      return {
        passed: false,
        verdicts,
        summary: `Verify command failed: ${verifyCmd}\n${verifyOutput.slice(0, 500)}`,
        testedAtMs: Date.now(),
      };
    }
  }

  // Step 2: LLM-based evaluation using persistent session
  try {
    // Build prompt based on evaluation count (first vs subsequent)
    let evalPrompt: string;

    if (evaluationCount === 0) {
      const { buildAcceptanceFirstPrompt } = await import("./acceptance-prompt.js");
      evalPrompt = buildAcceptanceFirstPrompt({
        orchestration,
        workspaceDir,
        verifyOutput: verifyOutput || undefined,
        verifyPassed,
      });
    } else {
      const { buildAcceptanceRetryPrompt } = await import("./acceptance-prompt.js");
      evalPrompt = buildAcceptanceRetryPrompt({
        orchestration,
        workspaceDir,
        fixCycle: evaluationCount,
        verifyOutput: verifyOutput || undefined,
        verifyPassed,
      });
    }

    // Activity-based timeout (re-attach per evaluation, same pattern as workers)
    const ACCEPTANCE_TIMEOUT_MS = 600_000;
    let lastActivityMs = Date.now();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const toolCallHistory: Array<{ name: string; timestamp: number }> = [];
    const LOOP_WINDOW = 10;
    const LOOP_THRESHOLD = 8;

    const checkTimeout = () => {
      const idleMs = Date.now() - lastActivityMs;
      if (idleMs >= ACCEPTANCE_TIMEOUT_MS) return true;
      timeoutHandle = setTimeout(checkTimeout, Math.min(30_000, ACCEPTANCE_TIMEOUT_MS - idleMs));
      return false;
    };
    timeoutHandle = setTimeout(checkTimeout, ACCEPTANCE_TIMEOUT_MS);

    // Hook into tool use for activity tracking (re-attach each evaluation)
    const originalOnToolUse = session.onToolUse;
    if (originalOnToolUse) {
      session.onToolUse = (...args: unknown[]) => {
        lastActivityMs = Date.now();
        const toolName = typeof args[0] === "string" ? args[0] : "unknown";
        toolCallHistory.push({ name: toolName, timestamp: Date.now() });
        if (toolCallHistory.length > LOOP_WINDOW) toolCallHistory.shift();

        if (toolCallHistory.length >= LOOP_WINDOW) {
          const counts = new Map<string, number>();
          for (const c of toolCallHistory) counts.set(c.name, (counts.get(c.name) || 0) + 1);
          let maxCount = 0,
            maxTool = "";
          for (const [t, n] of counts) {
            if (n > maxCount) {
              maxCount = n;
              maxTool = t;
            }
          }
          if (maxCount >= LOOP_THRESHOLD) {
            logger.warn("Potential tool loop in acceptance", { tool: maxTool, count: maxCount });
          }
        }

        return originalOnToolUse.apply(session, args);
      };
    }

    try {
      await session.prompt(evalPrompt);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    } catch (err) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      throw err;
    } finally {
      // Restore original onToolUse to avoid stacking wrappers
      if (originalOnToolUse) session.onToolUse = originalOnToolUse;
    }

    // Extract response text
    const lastText = session.getLastAssistantText?.() ?? "";

    // Post-turn attribution: record utilization of injected memory chunks
    if (params.memoryManager && params.sessionManager) {
      try {
        const { performPostTurnAttribution } = await import("../memory/post-turn-attribution.js");
        const { extractToolMetas } = await import("./worker-runner.js");
        await performPostTurnAttribution({
          sessionManager: params.sessionManager,
          memoryManager: params.memoryManager,
          assistantOutput: lastText,
          toolMetas: extractToolMetas(session),
          sessionId: `orch:${orchestration.id}:acceptance:${evaluationCount}`,
        });
      } catch {
        // Utilization tracking is non-critical
      }
    }

    // Index evaluation result into shared memory
    if (params.memoryManager && lastText) {
      const { indexAgentResult } = await import("./orchestrator-memory.js");
      await indexAgentResult({
        memoryManager: params.memoryManager,
        agentType: "acceptance",
        agentId: orchestration.id,
        title: `Acceptance Evaluation ${evaluationCount + 1}`,
        content: lastText,
      });
    }

    if (lastText) {
      // Try to parse JSON from the response
      const jsonMatch = lastText.match(/\{[\s\S]*"passed"[\s\S]*\}/);
      if (jsonMatch) {
        try {
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
                  confidence: 100, // Acceptance only lists blocking issues
                  description: issue.description ?? "Unknown issue",
                  file: issue.file,
                  line: issue.line,
                }))
              : undefined;

          // Parse fact-check results and auto-flag high contradiction ratios
          let factCheck: FactCheckResult | undefined;
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
                    status:
                      (d.status as "verified" | "contradicted" | "unverifiable") ?? "unverifiable",
                    source: d.source,
                  }))
                : undefined,
            };

            // Auto-fail if >30% of checked claims are contradicted
            const contradictionRatio = factCheck.contradicted / factCheck.checked;
            if (contradictionRatio > 0.3) {
              factCheckFailed = true;
              confidence = Math.min(confidence, 40); // Cap confidence when facts are wrong
              const factIssue = {
                severity: "critical" as const,
                confidence: 95,
                description: `Fact-check failure: ${factCheck.contradicted}/${factCheck.checked} claims contradicted by authoritative sources (${(contradictionRatio * 100).toFixed(0)}% contradiction rate)`,
                file: undefined as string | undefined,
                line: undefined as number | undefined,
              };
              if (issues) {
                issues.push(factIssue);
              }
              logger.warn("Fact-check contradiction threshold exceeded", {
                checked: factCheck.checked,
                contradicted: factCheck.contradicted,
                ratio: contradictionRatio,
              });
            }
          }

          verdicts.push({
            subtaskId: "overall",
            passed: factCheckFailed ? false : parsed.passed === true,
            confidence,
            reasoning:
              parsed.reasoning ??
              (parsed.passed ? "Project meets requirements" : "Project incomplete"),
            issues,
            factCheck,
          });
        } catch {
          const lower = lastText.toLowerCase();
          const passed = lower.includes('"passed"') && lower.includes("true");
          verdicts.push({
            subtaskId: "overall",
            passed,
            confidence: 50,
            reasoning: lastText.slice(0, 500),
          });
        }
      } else {
        const lower = lastText.toLowerCase();
        const passed = lower.includes("passed") && lower.includes("true");
        verdicts.push({
          subtaskId: "overall",
          passed,
          confidence: 50,
          reasoning: lastText.slice(0, 500),
        });
      }
    } else {
      verdicts.push({
        subtaskId: "overall",
        passed: false,
        confidence: 100,
        reasoning: "Evaluation agent returned no result",
      });
    }
  } catch (err) {
    verdicts.push({
      subtaskId: "overall",
      passed: false,
      confidence: 100,
      reasoning: `Evaluation failed: ${String(err)}`,
    });
  }
  // NOTE: No session.dispose() — acceptance session persists for re-evaluations

  const allPassed = verdicts.length > 0 && verdicts.every((v) => v.passed);

  return {
    passed: allPassed,
    verdicts,
    summary: allPassed
      ? "Project successfully meets the original requirements."
      : "Project does not fully meet the original requirements.",
    testedAtMs: Date.now(),
  };
}
