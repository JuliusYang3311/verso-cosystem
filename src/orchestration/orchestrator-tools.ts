// src/orchestration/orchestrator-tools.ts — The orchestrate agent tool

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../agents/schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "../agents/tools/common.js";
import { broadcastOrchestrationEvent, buildOrchestrationSnapshot } from "./events.js";
import {
  saveOrchestration,
  loadOrchestration,
  copyMissionToOutput,
  cleanupMissionWorkspace,
  listOrchestrations,
} from "./store.js";
import {
  type Subtask,
  type FixTask,
  createSubtask,
  isSubtaskReady,
  ORCHESTRATION_DEFAULTS,
} from "./types.js";
import { runWorkerPool } from "./worker-runner.js";

const ORCHESTRATE_ACTIONS = [
  "create-plan",
  "dispatch",
  "check-status",
  "run-acceptance",
  "create-fix-tasks",
  "complete",
  "abort",
] as const;

const OrchestrateToolSchema = Type.Object({
  action: stringEnum(ORCHESTRATE_ACTIONS),
  planSummary: Type.Optional(Type.String({ description: "Brief summary of the overall plan" })),
  subtasks: Type.Optional(
    Type.Array(
      Type.Object({
        title: Type.String(),
        description: Type.String(),
        acceptanceCriteria: Type.Array(Type.String()),
        dependsOn: Type.Optional(
          Type.Array(Type.String({ description: "Subtask IDs this depends on" })),
        ),
      }),
    ),
  ),
  orchestrationId: Type.Optional(Type.String()),
  fixes: Type.Optional(
    Type.Array(
      Type.Object({
        subtaskId: Type.String({ description: "ID of the failed subtask to fix" }),
        description: Type.String({ description: "What the fix worker should do" }),
      }),
    ),
  ),
  summary: Type.Optional(Type.String()),
  userPrompt: Type.Optional(Type.String()),
  verifyCmd: Type.Optional(
    Type.String({
      description:
        "Project verification command (for create-plan or run-acceptance). Should include lint for code quality. Examples: 'npm run lint && npm test', 'pnpm lint && pnpm build && vitest run', 'pytest && flake8'",
    }),
  ),
  outputDir: Type.Optional(
    Type.String({
      description:
        "Output directory for completed work (relative to source workspace, e.g., './my-app' or '../projects/tool'). If not specified, creates ./.verso-output/<orchestrationId>/",
    }),
  ),
});

export type OrchestrateToolOptions = {
  agentSessionKey: string;
  agentId: string;
  workspaceDir: string;
  maxWorkers?: number;
  maxFixCycles?: number;
  maxOrchestrations?: number;
  verifyCmd?: string;
};

export function createOrchestrateTool(opts: OrchestrateToolOptions): AnyAgentTool {
  return {
    label: "Orchestrate",
    name: "orchestrate",
    description: `Multi-agent orchestration tool. Decompose complex tasks into parallel subtasks executed by in-memory worker agents.

IMPORTANT: Mission workspace starts EMPTY. Workers build the project from scratch. Results are copied to outputDir when complete.

ACTIONS:
- create-plan: Create an orchestration plan with subtasks and acceptance criteria. Requires: planSummary, subtasks array, userPrompt. Optional: verifyCmd (project verification command, should include lint, e.g., "npm run lint && npm test").
- dispatch: Run all ready subtasks via in-memory worker pool. Blocks until all workers complete. Requires: orchestrationId.
- check-status: Check status of all subtasks. Requires: orchestrationId.
- run-acceptance: Run acceptance tests on completed subtasks. Requires: orchestrationId. Optional: verifyCmd (overrides plan's verifyCmd if specified).
- create-fix-tasks: Create fix tasks for failed acceptance criteria. Requires: orchestrationId, fixes array.
- complete: Copy results to output directory. Requires: orchestrationId. Optional: outputDir (relative path like "./my-app"), summary. If outputDir not specified, creates ./.verso-output/<orchestrationId>/
- abort: Cancel orchestration. Requires: orchestrationId.

WORKFLOW: create-plan → dispatch → run-acceptance → complete (or create-fix-tasks → dispatch → ...)

VERIFY COMMAND: Specify at create-plan time for the project type. Should include lint for code quality:
- Node.js/TypeScript: "npm run lint && npm test" or "pnpm lint && pnpm build && vitest run"
- Python: "flake8 && pytest" or "ruff check && pytest"
- Rust: "cargo clippy && cargo test"
- Go: "golangci-lint run && go test ./..."
- C++: "clang-tidy src/*.cpp && make test"
- Java: "mvn checkstyle:check && mvn test"
- No verification: "" (empty string, LLM-only evaluation)

OUTPUT DIRECTORY: Results are copied to this directory in the source workspace:
- Not specified: creates ./.verso-output/<orchestrationId>/ in source workspace
- Relative path: "./my-app" creates /path/to/workspace/my-app/
- Relative path: "../projects/tool" creates /path/to/projects/tool/
- Absolute path: "/Users/username/Projects/my-app"`,
    parameters: OrchestrateToolSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const action = readStringParam(params, "action", { required: true });

      switch (action) {
        case "create-plan":
          return await handleCreatePlan(params, opts);
        case "dispatch":
          return await handleDispatch(params, opts);
        case "check-status":
          return await handleCheckStatus(params);
        case "run-acceptance":
          return await handleRunAcceptance(params, opts);
        case "create-fix-tasks":
          return await handleCreateFixTasks(params);
        case "complete":
          return await handleComplete(params);
        case "abort":
          return await handleAbort(params);
        default:
          return jsonResult({ error: `Unknown action: ${action}` });
      }
    },
  };
}

// --- Action Handlers ---

async function handleCreatePlan(params: Record<string, unknown>, _opts: OrchestrateToolOptions) {
  const planSummary = readStringParam(params, "planSummary", { required: true });
  const userPrompt = readStringParam(params, "userPrompt", { required: true });
  const verifyCmd = readStringParam(params, "verifyCmd"); // Optional, determined by orchestrator
  const rawSubtasks = params.subtasks;

  if (!Array.isArray(rawSubtasks) || rawSubtasks.length === 0) {
    return jsonResult({ error: "subtasks array is required and must not be empty" });
  }

  // Find existing orchestration by userPrompt (created by daemon-runner)
  const allOrchs = await listOrchestrations();
  const existingOrch = allOrchs.find((o) => o.userPrompt === userPrompt && o.status === "planning");

  if (!existingOrch) {
    return jsonResult({
      error:
        "No orchestration found in planning state. This should have been created by the daemon.",
    });
  }

  const orchId = existingOrch.id;
  const orch = await loadOrchestration(orchId);
  if (!orch) {
    return jsonResult({ error: `Orchestration ${orchId} not found` });
  }

  const subtasks: Subtask[] = rawSubtasks.map((raw: Record<string, unknown>, i: number) => {
    const id = `t${i + 1}`;
    return createSubtask({
      id,
      title: String((raw.title as string) ?? `Task ${i + 1}`),
      description: String((raw.description as string) ?? ""),
      acceptanceCriteria: Array.isArray(raw.acceptanceCriteria)
        ? raw.acceptanceCriteria.map(String)
        : [],
      dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : undefined,
    });
  });

  orch.plan = { summary: planSummary, subtasks, verifyCmd };
  orch.status = "dispatching";
  await saveOrchestration(orch);

  // Broadcast status update
  await broadcastOrchestrationEvent({
    type: "orchestration.updated",
    payload: buildOrchestrationSnapshot(orch),
  });

  return jsonResult({
    orchestrationId: orchId,
    missionWorkspace: orch.workspaceDir,
    status: orch.status,
    subtaskCount: subtasks.length,
    verifyCmd: verifyCmd || "(none - LLM-only evaluation)",
    subtasks: subtasks.map((s) => ({ id: s.id, title: s.title, status: s.status })),
    message: `Plan created with ${subtasks.length} subtasks. Mission workspace: ${orch.workspaceDir}. Call dispatch to start workers.`,
  });
}

async function handleDispatch(params: Record<string, unknown>, opts: OrchestrateToolOptions) {
  const orchId = readStringParam(params, "orchestrationId", { required: true });
  const orch = await loadOrchestration(orchId);
  if (!orch) {
    return jsonResult({ error: `Orchestration ${orchId} not found` });
  }
  if (!orch.plan) {
    return jsonResult({ error: "No plan found. Call create-plan first." });
  }

  const allSubtasks = orch.plan.subtasks;
  const readySubtasks = allSubtasks.filter((s) => isSubtaskReady(s, allSubtasks));

  if (readySubtasks.length === 0) {
    return jsonResult({
      orchestrationId: orchId,
      dispatched: 0,
      message: "No subtasks ready to dispatch.",
      subtasks: allSubtasks.map((s) => ({ id: s.id, title: s.title, status: s.status })),
    });
  }

  orch.status = "running";
  await saveOrchestration(orch);

  // Broadcast status update
  await broadcastOrchestrationEvent({
    type: "orchestration.updated",
    payload: buildOrchestrationSnapshot(orch),
  });

  const maxWorkers = opts.maxWorkers ?? ORCHESTRATION_DEFAULTS.maxWorkers;
  const maxOrchestrations = opts.maxOrchestrations ?? ORCHESTRATION_DEFAULTS.maxOrchestrations;

  try {
    const results = await runWorkerPool({
      orchestration: orch,
      maxWorkers,
      maxOrchestrations,
    });

    const completed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;

    return jsonResult({
      orchestrationId: orchId,
      status: orch.status,
      dispatched: results.length,
      completed,
      failed,
      results: results.map((r) => ({
        subtaskId: r.subtaskId,
        ok: r.ok,
        filesChanged: r.filesChanged.length,
        error: r.error?.slice(0, 200),
      })),
      message: `All workers done. ${completed} completed, ${failed} failed.${failed > 0 ? " Run acceptance or create fix tasks." : " Run acceptance tests next."}`,
    });
  } catch (err) {
    return jsonResult({
      orchestrationId: orchId,
      error: String(err),
      message: `Dispatch failed: ${String(err)}`,
    });
  }
}

async function handleCheckStatus(params: Record<string, unknown>) {
  const orchId = readStringParam(params, "orchestrationId", { required: true });
  const orch = await loadOrchestration(orchId);
  if (!orch) {
    return jsonResult({ error: `Orchestration ${orchId} not found` });
  }
  if (!orch.plan) {
    return jsonResult({ error: "No plan found" });
  }

  const subtasks = orch.plan.subtasks;
  const counts = {
    pending: subtasks.filter((s) => s.status === "pending").length,
    running: subtasks.filter((s) => s.status === "running").length,
    completed: subtasks.filter((s) => s.status === "completed").length,
    failed: subtasks.filter((s) => s.status === "failed").length,
  };

  const allDone = counts.running === 0 && counts.pending === 0;

  return jsonResult({
    orchestrationId: orchId,
    status: orch.status,
    missionWorkspace: orch.workspaceDir,
    counts,
    allDone,
    subtasks: subtasks.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      error: s.error,
      resultSummary: s.resultSummary?.slice(0, 200),
    })),
    fixTasks: orch.fixTasks.map((f) => ({
      id: f.id,
      status: f.status,
      description: f.description.slice(0, 100),
    })),
    message: allDone
      ? `All workers done. ${counts.completed} completed, ${counts.failed} failed.`
      : `${counts.running} running, ${counts.pending} pending, ${counts.completed} completed, ${counts.failed} failed.`,
  });
}

async function handleRunAcceptance(params: Record<string, unknown>, opts: OrchestrateToolOptions) {
  const orchId = readStringParam(params, "orchestrationId", { required: true });
  const verifyCmdOverride = readStringParam(params, "verifyCmd"); // Optional override
  const orch = await loadOrchestration(orchId);
  if (!orch) {
    return jsonResult({ error: `Orchestration ${orchId} not found` });
  }
  if (!orch.plan) {
    return jsonResult({ error: "No plan found" });
  }

  // Use override if provided, otherwise use plan's verifyCmd, otherwise use default
  const verifyCmd =
    verifyCmdOverride ?? orch.plan.verifyCmd ?? opts.verifyCmd ?? ORCHESTRATION_DEFAULTS.verifyCmd;

  orch.status = "acceptance";
  await saveOrchestration(orch);

  // Broadcast status update
  await broadcastOrchestrationEvent({
    type: "orchestration.updated",
    payload: buildOrchestrationSnapshot(orch),
  });

  const { runAcceptanceTests } = await import("./acceptance.js");
  const result = await runAcceptanceTests({
    orchestration: orch,
    workspaceDir: orch.workspaceDir,
    verifyCmd,
    agentId: opts.agentId,
    agentSessionKey: opts.agentSessionKey,
  });

  orch.acceptanceResults.push(result);

  if (result.passed) {
    orch.status = "completed";
    orch.completedAtMs = Date.now();
  } else {
    if (orch.currentFixCycle >= orch.maxFixCycles) {
      orch.status = "failed";
      orch.error = `Acceptance failed after ${orch.maxFixCycles} fix cycles`;
    } else {
      orch.status = "fixing";
    }
  }

  await saveOrchestration(orch);

  // Broadcast status update
  await broadcastOrchestrationEvent({
    type: "orchestration.updated",
    payload: buildOrchestrationSnapshot(orch),
  });

  return jsonResult({
    orchestrationId: orchId,
    status: orch.status,
    passed: result.passed,
    summary: result.summary,
    verdicts: result.verdicts,
    currentFixCycle: orch.currentFixCycle,
    maxFixCycles: orch.maxFixCycles,
    verifyCmd: verifyCmd || "(none)",
    message: result.passed
      ? "All acceptance tests passed. Call complete to copy results to output directory."
      : orch.status === "failed"
        ? `Acceptance failed after ${orch.maxFixCycles} fix cycles. Orchestration marked as failed.`
        : `Acceptance failed. ${result.verdicts.filter((v) => !v.passed).length} subtasks need fixes. Call create-fix-tasks.`,
  });
}

async function handleCreateFixTasks(params: Record<string, unknown>) {
  const orchId = readStringParam(params, "orchestrationId", { required: true });
  const rawFixes = params.fixes;
  if (!Array.isArray(rawFixes) || rawFixes.length === 0) {
    return jsonResult({ error: "fixes array is required" });
  }

  const orch = await loadOrchestration(orchId);
  if (!orch) {
    return jsonResult({ error: `Orchestration ${orchId} not found` });
  }
  if (!orch.plan) {
    return jsonResult({ error: "No plan found" });
  }

  orch.currentFixCycle += 1;

  // Create fix tasks and convert them to subtasks
  const newFixes: FixTask[] = rawFixes.map((raw: Record<string, unknown>, i: number) => ({
    id: `fix-c${orch.currentFixCycle}-${i + 1}`,
    sourceSubtaskId: String((raw.subtaskId as string) ?? ""),
    description: String((raw.description as string) ?? ""),
    status: "pending" as const,
    createdAtMs: Date.now(),
  }));

  // Convert fix tasks to subtasks so they can be picked up by workers
  const fixSubtasks: Subtask[] = newFixes.map((fix) => {
    const sourceTask = orch.plan!.subtasks.find((s) => s.id === fix.sourceSubtaskId);
    return {
      id: fix.id,
      title: `Fix: ${sourceTask?.title || fix.sourceSubtaskId}`,
      description: fix.description,
      acceptanceCriteria: sourceTask?.acceptanceCriteria || [],
      status: "pending" as const,
      retryCount: 0,
      createdAtMs: Date.now(),
    };
  });

  // Add fix subtasks to the plan so workers can pick them up
  orch.plan.subtasks.push(...fixSubtasks);
  orch.fixTasks.push(...newFixes);
  orch.status = "dispatching";
  await saveOrchestration(orch);

  // Broadcast status update
  await broadcastOrchestrationEvent({
    type: "orchestration.updated",
    payload: buildOrchestrationSnapshot(orch),
  });

  return jsonResult({
    orchestrationId: orchId,
    fixCycle: orch.currentFixCycle,
    fixTasks: newFixes.map((f) => ({ id: f.id, description: f.description.slice(0, 100) })),
    message: `Created ${newFixes.length} fix tasks (cycle ${orch.currentFixCycle}/${orch.maxFixCycles}). Call dispatch to start fix workers.`,
  });
}

async function handleComplete(params: Record<string, unknown>) {
  const orchId = readStringParam(params, "orchestrationId", { required: true });
  const summary = readStringParam(params, "summary");
  const outputDir = readStringParam(params, "outputDir");
  const orch = await loadOrchestration(orchId);
  if (!orch) {
    return jsonResult({ error: `Orchestration ${orchId} not found` });
  }

  // Default outputDir: create directory named after orchestration ID in source workspace
  const finalOutputDir = outputDir || `./.verso-output/${orchId}`;

  // Copy to output directory
  const copyResult = await copyMissionToOutput(orch.sourceWorkspaceDir, orchId, finalOutputDir);

  orch.status = "completed";
  orch.completedAtMs = Date.now();
  if (summary) {
    orch.error = undefined;
  }
  await saveOrchestration(orch);

  // Broadcast completion (note: daemon also broadcasts, but this ensures immediate update)
  await broadcastOrchestrationEvent({
    type: "orchestration.updated",
    payload: buildOrchestrationSnapshot(orch),
  });

  if (copyResult.copied) {
    await cleanupMissionWorkspace(orch.sourceWorkspaceDir, orchId);
  }

  const subtaskSummaries = orch.plan?.subtasks.map((s) => `- ${s.title}: ${s.status}`) ?? [];

  return jsonResult({
    orchestrationId: orchId,
    status: "completed",
    success: copyResult.copied,
    outputPath: copyResult.resolvedPath,
    error: copyResult.error,
    summary:
      summary ?? `Orchestration completed. ${orch.plan?.subtasks.length ?? 0} subtasks executed.`,
    subtasks: subtaskSummaries,
    message: copyResult.copied
      ? `Orchestration completed. Results copied to ${copyResult.resolvedPath}.`
      : `Orchestration completed but copy failed: ${copyResult.error}. Mission workspace preserved at ${orch.workspaceDir}.`,
  });
}

async function handleAbort(params: Record<string, unknown>) {
  const orchId = readStringParam(params, "orchestrationId", { required: true });
  const orch = await loadOrchestration(orchId);
  if (!orch) {
    return jsonResult({ error: `Orchestration ${orchId} not found` });
  }

  if (orch.plan) {
    for (const subtask of orch.plan.subtasks) {
      if (subtask.status === "pending" || subtask.status === "running") {
        subtask.status = "cancelled";
      }
    }
  }

  for (const fix of orch.fixTasks) {
    if (fix.status === "pending" || fix.status === "running") {
      fix.status = "cancelled";
    }
  }

  orch.status = "failed";
  orch.error = "Aborted by orchestrator";
  await saveOrchestration(orch);

  // Broadcast abort event
  await broadcastOrchestrationEvent({
    type: "orchestration.failed",
    orchestrationId: orchId,
    error: "Aborted by orchestrator",
  });

  // Clean up mission workspace — no point keeping it after abort
  await cleanupMissionWorkspace(orch.sourceWorkspaceDir, orchId);

  return jsonResult({
    orchestrationId: orchId,
    status: "failed",
    message: "Orchestration aborted. Mission workspace cleaned up.",
  });
}
