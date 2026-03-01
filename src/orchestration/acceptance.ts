// src/orchestration/acceptance.ts — Acceptance testing for orchestrations

import { execSync } from "node:child_process";
import type { AcceptanceResult, AcceptanceVerdict, Orchestration } from "./types.js";
import { runAgentStep } from "../agents/tools/agent-step.js";

export type AcceptanceTestParams = {
  orchestration: Orchestration;
  workspaceDir: string;
  verifyCmd: string;
  agentId: string;
  agentSessionKey: string;
};

/**
 * Run acceptance tests: first a mechanical verify command (build/lint/test),
 * then LLM-based evaluation of each subtask's acceptance criteria.
 */
export async function runAcceptanceTests(params: AcceptanceTestParams): Promise<AcceptanceResult> {
  const {
    orchestration,
    workspaceDir,
    verifyCmd,
    agentId,
    agentSessionKey: _agentSessionKey,
  } = params;
  const subtasks = orchestration.plan?.subtasks ?? [];
  const verdicts: AcceptanceVerdict[] = [];

  // Step 1: Run mechanical verify command
  let verifyPassed = true;
  let verifyOutput = "";
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
    // All subtasks fail if the verify command fails
    for (const subtask of subtasks) {
      if (subtask.status === "completed") {
        verdicts.push({
          subtaskId: subtask.id,
          passed: false,
          reason: `Verify command failed:\n${verifyOutput.slice(0, 500)}`,
        });
      }
    }
    return {
      passed: false,
      verdicts,
      summary: `Verify command failed: ${verifyCmd}\n${verifyOutput.slice(0, 500)}`,
      testedAtMs: Date.now(),
    };
  }

  // Step 2: LLM-based acceptance criteria evaluation per subtask
  for (const subtask of subtasks) {
    if (subtask.status !== "completed") {
      verdicts.push({
        subtaskId: subtask.id,
        passed: false,
        reason: `Subtask not completed (status: ${subtask.status})`,
      });
      continue;
    }

    const criteriaText = subtask.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");

    const evalSessionKey = `agent:${agentId}:orch:${orchestration.id}:eval:${subtask.id}`;
    const evalPrompt = `You are an acceptance test evaluator. Evaluate whether the following subtask's acceptance criteria have been met.

Subtask: ${subtask.title}
Description: ${subtask.description}

Acceptance Criteria:
${criteriaText}

Worker's result summary:
${subtask.resultSummary ?? "(no summary available)"}

Examine the workspace at ${workspaceDir} to verify the criteria. For each criterion, state PASS or FAIL with a brief reason.

Respond with a JSON object:
{
  "allPassed": true/false,
  "reason": "brief overall summary"
}`;

    try {
      const evalResult = await runAgentStep({
        sessionKey: evalSessionKey,
        message: evalPrompt,
        extraSystemPrompt:
          "You are a code reviewer evaluating acceptance criteria. Be strict but fair. Respond only with the requested JSON.",
        timeoutMs: 60_000,
      });

      if (evalResult) {
        // Try to parse JSON from the response
        const jsonMatch = evalResult.match(/\{[\s\S]*"allPassed"[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]) as { allPassed?: boolean; reason?: string };
            verdicts.push({
              subtaskId: subtask.id,
              passed: parsed.allPassed === true,
              reason:
                parsed.reason ?? (parsed.allPassed ? "All criteria met" : "Some criteria not met"),
            });
            continue;
          } catch {
            // JSON parse failed, fall through
          }
        }
        // Fallback: check for obvious pass/fail signals
        const lower = evalResult.toLowerCase();
        const passed = lower.includes("allpassed") && lower.includes("true");
        verdicts.push({
          subtaskId: subtask.id,
          passed,
          reason: evalResult.slice(0, 500),
        });
      } else {
        verdicts.push({
          subtaskId: subtask.id,
          passed: false,
          reason: "Evaluation agent returned no result",
        });
      }
    } catch (err) {
      verdicts.push({
        subtaskId: subtask.id,
        passed: false,
        reason: `Evaluation failed: ${String(err)}`,
      });
    }
  }

  const allPassed = verdicts.length > 0 && verdicts.every((v) => v.passed);

  return {
    passed: allPassed,
    verdicts,
    summary: allPassed
      ? `All ${verdicts.length} subtasks passed acceptance testing.`
      : `${verdicts.filter((v) => !v.passed).length}/${verdicts.length} subtasks failed acceptance testing.`,
    testedAtMs: Date.now(),
  };
}
