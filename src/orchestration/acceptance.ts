// src/orchestration/acceptance.ts — Acceptance testing for orchestrations

import { execSync } from "node:child_process";
import type { AcceptanceResult, AcceptanceVerdict, Orchestration } from "./types.js";

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
  const { orchestration, workspaceDir, verifyCmd } = params;
  const subtasks = orchestration.plan?.subtasks ?? [];
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
  }

  // Step 2: LLM-based acceptance criteria evaluation per subtask
  // Use in-memory session for evaluation (like workers do)
  const { createAgentSession, SessionManager } = await import("@mariozechner/pi-coding-agent");
  const { resolveAgentModel } = await import("./model-resolver.js");
  const { resolveOpenClawAgentDir } = await import("../agents/agent-paths.js");

  const { model, authStorage, modelRegistry } = await resolveAgentModel();
  const agentDir = resolveOpenClawAgentDir();

  for (const subtask of subtasks) {
    // Skip cancelled subtasks (they were replaced by fix tasks)
    if (subtask.status === "cancelled") {
      continue;
    }

    if (subtask.status !== "completed") {
      verdicts.push({
        subtaskId: subtask.id,
        passed: false,
        reason: `Subtask not completed (status: ${subtask.status})`,
      });
      continue;
    }

    const criteriaText = subtask.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");

    const evalPrompt = `You are an acceptance test evaluator. Evaluate whether the following subtask's acceptance criteria have been met.

Subtask: ${subtask.title}
Description: ${subtask.description}

Acceptance Criteria:
${criteriaText}

Worker's result summary:
${subtask.resultSummary ?? "(no summary available)"}

IMPORTANT EVALUATION GUIDELINES:

1. **Verify actual execution, not just file existence**:
   - If criteria mentions "dependencies installed", check that node_modules directory exists and contains the packages
   - If criteria mentions "script works", verify the script can actually run (check for syntax errors, missing dependencies)
   - If criteria mentions "tests pass", verify test files exist AND are executable

2. **Check for common issues**:
   - For Node.js projects: verify node_modules exists if dependencies are required
   - For Python projects: verify virtual environment or installed packages
   - For configuration files: verify they are valid (not just that they exist)

3. **Be strict but fair**:
   - If a criterion says "X is installed", check that X is actually installed, not just listed in a config file
   - If a criterion says "Y works", verify Y can actually execute
   - If files are missing or incomplete, mark as FAIL

Examine the workspace at ${workspaceDir} to verify the criteria. For each criterion, state PASS or FAIL with a brief reason.

Respond with a JSON object:
{
  "allPassed": true/false,
  "reason": "brief overall summary"
}`;

    try {
      // Create in-memory session for evaluation
      const created = await createAgentSession({
        cwd: workspaceDir,
        agentDir,
        authStorage,
        modelRegistry,
        model,
        sessionManager: SessionManager.inMemory(workspaceDir),
      });

      const session = created.session;

      // Run evaluation
      await session.sendUserMessage(evalPrompt);

      // Get response from messages
      const messages = session.messages;
      const lastMessage = messages[messages.length - 1];
      const evalResult =
        lastMessage?.role === "assistant"
          ? lastMessage.content
              .filter((c) => c.type === "text")
              .map((c) => ("text" in c ? c.text : ""))
              .join("")
          : "";

      // Dispose session
      session.dispose();

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
