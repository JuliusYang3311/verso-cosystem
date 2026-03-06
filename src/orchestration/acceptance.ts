// src/orchestration/acceptance.ts — Acceptance testing for orchestrations

import { execSync } from "node:child_process";
import type { AcceptanceResult, AcceptanceVerdict, Orchestration } from "./types.js";

const logger = {
  info: (...args: unknown[]) => console.log("[orchestration-acceptance]", ...args),
  warn: (...args: unknown[]) => console.warn("[orchestration-acceptance]", ...args),
  error: (...args: unknown[]) => console.error("[orchestration-acceptance]", ...args),
};

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
        confidence: 100, // High confidence that verify command failure is real
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

  // Step 2: Overall project evaluation against original user task
  // Use persistent session for evaluation (stored in orchestration directory)
  const { createAgentSession, SessionManager } = await import("@mariozechner/pi-coding-agent");
  const { resolveAgentModel } = await import("./model-resolver.js");
  const { resolveOpenClawAgentDir } = await import("../agents/agent-paths.js");
  const { getOrchestrationSessionFile } = await import("./orchestrator-memory.js");

  const { model, authStorage, modelRegistry } = await resolveAgentModel();
  const agentDir = resolveOpenClawAgentDir();

  // Create persistent session file in orchestration directory
  const sessionFile = getOrchestrationSessionFile(
    orchestration.sourceWorkspaceDir,
    orchestration.id,
    "acceptance",
  );

  // Build subtask summary for context
  const subtaskSummary = subtasks
    .map((s) => `- [${s.status}] ${s.title}: ${s.resultSummary?.slice(0, 500) ?? "no summary"}`)
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

5. **Provide confidence scores** (inspired by Claude Code's confidence-based filtering):
   - For each issue found, assign a confidence score (0-100)
   - 90-100: Absolutely certain (will definitely fail/break)
   - 75-89: Highly confident (very likely to cause problems)
   - 50-74: Moderately confident (likely an issue but some uncertainty)
   - 25-49: Somewhat confident (might be an issue, context-dependent)
   - 0-24: Not confident (likely false positive, subjective)

Examine the workspace at ${workspaceDir} to verify the overall project quality.

Respond with a JSON object:
{
  "passed": true/false,
  "confidence": 0-100 (how confident you are in this verdict),
  "reasoning": "detailed explanation of why the project passes or fails",
  "issues": [
    {
      "severity": "critical" | "major" | "minor",
      "confidence": 0-100,
      "description": "what the issue is",
      "file": "path/to/file.ts (optional)",
      "line": 42 (optional)
    }
  ]
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

      // Create persistent session for evaluation
      const created = await createAgentSession({
        cwd: workspaceDir,
        agentDir,
        authStorage,
        modelRegistry,
        model,
        customTools: acceptanceTools, // Use customTools to add tools alongside coding tools
        sessionManager: SessionManager.open(sessionFile),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session: any = created.session;

      // Activity-based timeout for acceptance agent (same pattern as workers)
      const ACCEPTANCE_TIMEOUT_MS = 600_000; // 10 minutes of inactivity
      let lastActivityMs = Date.now();
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      // Tool call loop detection: track recent tool calls to detect infinite loops
      const toolCallHistory: Array<{ name: string; timestamp: number }> = [];
      const LOOP_DETECTION_WINDOW = 10; // Check last 10 tool calls
      const LOOP_DETECTION_THRESHOLD = 8; // If 8 out of 10 are the same tool, it's a loop

      const checkTimeout = () => {
        const idleMs = Date.now() - lastActivityMs;
        if (idleMs >= ACCEPTANCE_TIMEOUT_MS) {
          return true; // Timed out
        }
        // Schedule next check
        timeoutHandle = setTimeout(checkTimeout, Math.min(30_000, ACCEPTANCE_TIMEOUT_MS - idleMs));
        return false;
      };

      // Start timeout checker
      timeoutHandle = setTimeout(checkTimeout, ACCEPTANCE_TIMEOUT_MS);

      // Monitor session activity
      const originalOnToolUse = session.onToolUse;
      if (originalOnToolUse) {
        session.onToolUse = (...args: unknown[]) => {
          lastActivityMs = Date.now(); // Reset activity timer

          // Track tool call for loop detection
          const toolName = typeof args[0] === "string" ? args[0] : "unknown";
          toolCallHistory.push({ name: toolName, timestamp: Date.now() });

          // Keep only recent history
          if (toolCallHistory.length > LOOP_DETECTION_WINDOW) {
            toolCallHistory.shift();
          }

          // Check for loop: if most recent calls are the same tool
          if (toolCallHistory.length >= LOOP_DETECTION_WINDOW) {
            const recentTools = toolCallHistory.slice(-LOOP_DETECTION_WINDOW);
            const toolCounts = new Map<string, number>();
            for (const call of recentTools) {
              toolCounts.set(call.name, (toolCounts.get(call.name) || 0) + 1);
            }

            // Find most frequent tool
            let maxCount = 0;
            let maxTool = "";
            for (const [tool, count] of toolCounts) {
              if (count > maxCount) {
                maxCount = count;
                maxTool = tool;
              }
            }

            // If one tool dominates recent calls, likely a loop
            if (maxCount >= LOOP_DETECTION_THRESHOLD) {
              // Log warning but don't abort - timeout will catch it if truly stuck
              logger.warn("Detected potential tool call loop in acceptance agent", {
                tool: maxTool,
                count: maxCount,
                window: LOOP_DETECTION_WINDOW,
              });
            }
          }

          return originalOnToolUse.apply(session, args);
        };
      }

      try {
        // Run evaluation
        await session.sendUserMessage(evalPrompt);

        // Evaluation completed successfully - clear timeout immediately
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }

        // No need to check timeout after successful completion
      } catch (err) {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        throw err;
      }

      // Get response from messages
      const messages = session.messages;
      const lastMessage = messages[messages.length - 1];
      const evalResult =
        lastMessage?.role === "assistant"
          ? lastMessage.content
              .filter(
                (c: unknown) =>
                  typeof c === "object" &&
                  c !== null &&
                  "type" in c &&
                  (c as { type: string }).type === "text",
              )
              .map((c: unknown) =>
                typeof c === "object" && c !== null && "text" in c
                  ? (c as { text: string }).text
                  : "",
              )
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
              confidence?: number;
              reasoning?: string;
              issues?: Array<{
                severity?: string;
                confidence?: number;
                description?: string;
                file?: string;
                line?: number;
              }>;
            };

            const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 100;
            const issues =
              Array.isArray(parsed.issues) && parsed.issues.length > 0
                ? parsed.issues.map((issue) => ({
                    severity: (issue.severity as "critical" | "major" | "minor") ?? "major",
                    confidence: typeof issue.confidence === "number" ? issue.confidence : 100,
                    description: issue.description ?? "Unknown issue",
                    file: issue.file,
                    line: issue.line,
                  }))
                : undefined;

            verdicts.push({
              subtaskId: "overall",
              passed: parsed.passed === true,
              confidence,
              reasoning:
                parsed.reasoning ??
                (parsed.passed ? "Project meets requirements" : "Project incomplete"),
              issues,
            });
          } catch {
            // JSON parse failed, fall through to fallback
            const lower = evalResult.toLowerCase();
            const passed = lower.includes('"passed"') && lower.includes("true");
            verdicts.push({
              subtaskId: "overall",
              passed,
              confidence: 50, // Low confidence for fallback parsing
              reasoning: evalResult.slice(0, 500),
            });
          }
        } else {
          // Fallback: check for obvious pass/fail signals
          const lower = evalResult.toLowerCase();
          const passed = lower.includes("passed") && lower.includes("true");
          verdicts.push({
            subtaskId: "overall",
            passed,
            confidence: 50, // Low confidence for fallback parsing
            reasoning: evalResult.slice(0, 500),
          });
        }
      } else {
        verdicts.push({
          subtaskId: "overall",
          passed: false,
          confidence: 100, // High confidence that no result = failure
          reasoning: "Evaluation agent returned no result",
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
      confidence: 100, // High confidence that exception = failure
      reasoning: `Evaluation failed: ${String(err)}`,
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
