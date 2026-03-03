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
 * then LLM-based evaluation of the overall project against the original user task.
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
      // Create a single verdict for the overall project
      verdicts.push({
        subtaskId: "overall",
        passed: false,
        reason: `Verify command failed:\n${verifyOutput.slice(0, 500)}`,
      });
      return {
        passed: false,
        verdicts,
        summary: `Verify command failed: ${verifyCmd}\n${verifyOutput.slice(0, 500)}`,
        testedAtMs: Date.now(),
      };
    }
  }

  // Step 2: Overall project evaluation against original user task
  // Use in-memory session for evaluation (like workers do)
  const { createAgentSession, SessionManager } = await import("@mariozechner/pi-coding-agent");
  const { resolveAgentModel } = await import("./model-resolver.js");
  const { resolveOpenClawAgentDir } = await import("../agents/agent-paths.js");

  const { model, authStorage, modelRegistry } = await resolveAgentModel();
  const agentDir = resolveOpenClawAgentDir();

  // Build subtask summary for context
  const subtaskSummary = subtasks
    .map((s) => `- [${s.status}] ${s.title}: ${s.resultSummary?.slice(0, 200) ?? "no summary"}`)
    .join("\n");

  const evalPrompt = `You are an acceptance test evaluator. Evaluate whether the overall project satisfies the original user task.

ORIGINAL USER TASK:
${orchestration.userPrompt}

PROJECT PLAN SUMMARY:
${orchestration.plan?.summary ?? "No plan summary"}

SUBTASKS EXECUTED:
${subtaskSummary}

EVALUATION INSTRUCTIONS:

1. **Evaluate the OVERALL project**, not individual subtasks:
   - Does the final deliverable satisfy the user's original request?
   - Is the project complete and functional as a whole?
   - Can the user actually use what was built?

2. **Check for completeness**:
   - Are all major components present and working together?
   - Is the project ready to use/deploy?
   - Are there any critical missing pieces?

3. **Verify actual functionality**:
   - For applications: Can they actually run? Are dependencies installed?
   - For documentation/reports: Is the content complete and coherent?
   - For tools: Do they work as intended?

4. **Be holistic, not pedantic**:
   - Minor issues in individual subtasks are OK if the overall project works
   - Focus on whether the user's goal was achieved
   - Consider the project as a complete deliverable

Examine the workspace at ${workspaceDir} to verify the overall project quality.

Respond with a JSON object:
{
  "passed": true/false,
  "reason": "brief explanation of why the project passes or fails overall",
  "issues": ["list of critical issues if any, empty array if none"]
}`;

  try {
    // Save original memory env vars (acceptance agent should use shared memory)
    const originalMemoryDir = process.env.MEMORY_DIR;
    const originalVersoMemoryDir = process.env.VERSO_MEMORY_DIR;

    // Get shared memory directory from orchestration
    const { getOrchestrationMemoryEnv } = await import("./orchestrator-memory.js");
    const { resolveMissionWorkspace } = await import("./store.js");
    const missionDir = resolveMissionWorkspace(params.workspaceDir, params.agentId);
    const memoryDir = `${missionDir}/memory`;
    const memoryEnv = getOrchestrationMemoryEnv(memoryDir);

    // Set memory env vars for acceptance agent (same as orchestrator and workers)
    process.env.MEMORY_DIR = memoryEnv.MEMORY_DIR;
    process.env.VERSO_MEMORY_DIR = memoryEnv.VERSO_MEMORY_DIR;

    try {
      // Create web search and web fetch tools for acceptance agent (same as orchestrator)
      const { createWebSearchTool } = await import("../agents/tools/web-search.js");
      const { createWebFetchTool } = await import("../agents/tools/web-fetch.js");
      const { loadConfig } = await import("../config/config.js");
      const config = loadConfig();
      const webSearchTool = createWebSearchTool({ config, sandboxed: false });
      const webFetchTool = createWebFetchTool({ config, sandboxed: false });

      // Create Google Workspace tools for acceptance agent (if enabled, same as orchestrator)
      const gworkspaceTools = [];
      if (config.google?.enabled) {
        const {
          sheetsCreateSpreadsheet,
          sheetsAppendValues,
          docsCreateDocument,
          driveListFiles,
          driveUploadFile,
          driveDownloadFile,
          slidesCreatePresentation,
        } = await import("../agents/tools/gworkspace-tools.js");

        const services = config.google.services || ["sheets", "docs", "drive", "slides"];
        if (services.includes("sheets")) {
          gworkspaceTools.push(sheetsCreateSpreadsheet, sheetsAppendValues);
        }
        if (services.includes("docs")) {
          gworkspaceTools.push(docsCreateDocument);
        }
        if (services.includes("drive")) {
          gworkspaceTools.push(driveListFiles, driveUploadFile, driveDownloadFile);
        }
        if (services.includes("slides")) {
          gworkspaceTools.push(slidesCreatePresentation);
        }
      }

      const acceptanceTools = [
        ...(webSearchTool ? [webSearchTool] : []),
        ...(webFetchTool ? [webFetchTool] : []),
        ...gworkspaceTools,
      ];

      // Create in-memory session for evaluation
      const created = await createAgentSession({
        cwd: workspaceDir,
        agentDir,
        authStorage,
        modelRegistry,
        model,
        customTools: acceptanceTools, // Use customTools to add tools alongside coding tools
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
        const jsonMatch = evalResult.match(/\{[\s\S]*"passed"[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]) as {
              passed?: boolean;
              reason?: string;
              issues?: string[];
            };
            verdicts.push({
              subtaskId: "overall",
              passed: parsed.passed === true,
              reason:
                parsed.reason ??
                (parsed.passed ? "Project meets requirements" : "Project incomplete"),
            });
          } catch {
            // JSON parse failed, fall through to fallback
            const lower = evalResult.toLowerCase();
            const passed = lower.includes('"passed"') && lower.includes("true");
            verdicts.push({
              subtaskId: "overall",
              passed,
              reason: evalResult.slice(0, 500),
            });
          }
        } else {
          // Fallback: check for obvious pass/fail signals
          const lower = evalResult.toLowerCase();
          const passed = lower.includes("passed") && lower.includes("true");
          verdicts.push({
            subtaskId: "overall",
            passed,
            reason: evalResult.slice(0, 500),
          });
        }
      } else {
        verdicts.push({
          subtaskId: "overall",
          passed: false,
          reason: "Evaluation agent returned no result",
        });
      }
    } finally {
      // Restore original memory env vars
      if (originalMemoryDir) {
        process.env.MEMORY_DIR = originalMemoryDir;
      } else {
        delete process.env.MEMORY_DIR;
      }
      if (originalVersoMemoryDir) {
        process.env.VERSO_MEMORY_DIR = originalVersoMemoryDir;
      } else {
        delete process.env.VERSO_MEMORY_DIR;
      }
    }
  } catch (err) {
    verdicts.push({
      subtaskId: "overall",
      passed: false,
      reason: `Evaluation failed: ${String(err)}`,
    });
  }

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
