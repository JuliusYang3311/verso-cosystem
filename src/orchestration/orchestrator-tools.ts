// src/orchestration/orchestrator-tools.ts — The orchestrate agent tool

import { Type } from "@sinclair/typebox";
import type { WorkerPool } from "./worker-pool.js";
import { stringEnum } from "../agents/schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "../agents/tools/common.js";
import { broadcastOrchestrationEvent, buildOrchestrationSnapshot } from "./events.js";
import {
  saveOrchestration,
  loadOrchestration,
  copyMissionToOutput,
  cleanupMissionWorkspace,
} from "./store.js";
import { type Subtask, createSubtask, isSubtaskReady, ORCHESTRATION_DEFAULTS } from "./types.js";
import { runWorkerPool } from "./worker-runner.js";

const logger = {
  info: (...args: unknown[]) => console.log("[orchestrator-tools]", ...args),
  warn: (...args: unknown[]) => console.warn("[orchestrator-tools]", ...args),
  error: (...args: unknown[]) => console.error("[orchestrator-tools]", ...args),
};

const ORCHESTRATE_ACTIONS = [
  "create-plan",
  "dispatch",
  "check-status",
  "run-acceptance",
  "revise-plan",
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
        specialization: Type.String({
          description:
            "REQUIRED worker specialization type: 'code-explorer' (understand codebase), 'code-architect' (design architecture), 'code-implementer' (write code), 'code-reviewer' (review quality), 'researcher' (gather information), 'generic' (fallback for other tasks)",
        }),
        dependsOn: Type.Optional(
          Type.Array(Type.String({ description: "Subtask IDs this depends on" })),
        ),
      }),
    ),
  ),
  orchestrationId: Type.Optional(Type.String()),
  cancelTaskIds: Type.Optional(
    Type.Array(
      Type.String({ description: "IDs of subtasks to cancel (and their blocked dependents)" }),
    ),
  ),
  addSubtasks: Type.Optional(
    Type.Array(
      Type.Object({
        title: Type.String(),
        description: Type.String(),
        acceptanceCriteria: Type.Array(Type.String()),
        specialization: Type.String(),
        dependsOn: Type.Optional(Type.Array(Type.String())),
      }),
    ),
  ),
  rewireDeps: Type.Optional(
    Type.Array(
      Type.Object({
        taskId: Type.String({ description: "ID of the task whose dependencies to update" }),
        oldDepId: Type.String({ description: "Old dependency ID to replace" }),
        newDepId: Type.String({ description: "New dependency ID (e.g., a newly added task)" }),
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
  /** Persistent worker pool — pre-created sessions reused across dispatch cycles. */
  pool: WorkerPool;
  /** Persistent acceptance session — carries context across evaluations. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  acceptanceSession: any;
  /** SessionManager for acceptance session (utilization attribution). */
  acceptanceSessionManager?: unknown;
  maxFixCycles?: number;
  maxOrchestrations?: number;
  verifyCmd?: string;
  config?: import("../config/types.js").VersoConfig;
  /** Isolated memory manager shared across orchestrator, workers, and acceptance. */
  memoryManager?: import("../memory/types.js").MemorySearchManager;
};

export function createOrchestrateTool(opts: OrchestrateToolOptions): AnyAgentTool {
  return {
    label: "Orchestrate",
    name: "orchestrate",
    description: `Multi-agent orchestration tool. Decompose complex tasks into parallel subtasks executed by in-memory worker agents.

IMPORTANT: Mission workspace starts EMPTY. Workers build the project from scratch. Results are copied to outputDir when complete.

ACTIONS:
- create-plan: Create an orchestration plan with subtasks and acceptance criteria. Requires: orchestrationId, planSummary, subtasks array, userPrompt. Optional: verifyCmd (project verification command, should include lint, e.g., "npm run lint && npm test").
- dispatch: Run all ready subtasks via in-memory worker pool. Blocks until all workers complete. Requires: orchestrationId.
- check-status: Check status of all subtasks. Requires: orchestrationId.
- run-acceptance: Run acceptance tests on completed subtasks. Requires: orchestrationId. Optional: verifyCmd (overrides plan's verifyCmd if specified).
- revise-plan: Modify the plan mid-flight. Cancel tasks, add new ones, rewire dependencies. Use this after acceptance fails or when dispatch reports exhausted tasks that need a different approach. Requires: orchestrationId. Optional: cancelTaskIds (cancel tasks + their blocked dependents), addSubtasks (new tasks with IDs auto-assigned), rewireDeps (update dependency references).
- complete: Copy results to output directory. Requires: orchestrationId. Optional: outputDir (relative path like "./my-app"), summary. If outputDir not specified, creates ./orchestrator-output/<orchestrationId>/
- abort: Cancel orchestration. Requires: orchestrationId.

WORKFLOW: create-plan → dispatch → run-acceptance → complete (or revise-plan → dispatch → ...)

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
        case "revise-plan":
          return await handleRevisePlan(params, opts);
        case "complete":
          return await handleComplete(params, opts);
        case "abort":
          return await handleAbort(params, opts);
        default:
          return jsonResult({ error: `Unknown action: ${action}` });
      }
    },
  };
}

// --- Action Handlers ---

async function handleCreatePlan(params: Record<string, unknown>, opts: OrchestrateToolOptions) {
  const planSummary = readStringParam(params, "planSummary", { required: true });
  const orchestrationId = readStringParam(params, "orchestrationId", { required: true });
  const verifyCmd = readStringParam(params, "verifyCmd"); // Optional, determined by orchestrator
  const rawSubtasks = params.subtasks;

  if (!Array.isArray(rawSubtasks) || rawSubtasks.length === 0) {
    return jsonResult({ error: "subtasks array is required and must not be empty" });
  }

  // Load existing orchestration by ID (created by daemon-runner)
  const orch = await loadOrchestration(orchestrationId);
  if (!orch) {
    return jsonResult({
      error: `Orchestration ${orchestrationId} not found. This should have been created by the daemon.`,
    });
  }

  if (orch.status !== "planning") {
    return jsonResult({
      error: `Orchestration ${orchestrationId} is not in planning state (current: ${orch.status})`,
    });
  }

  const subtasks: Subtask[] = rawSubtasks.map((raw: Record<string, unknown>, i: number) => {
    const id = `t${i + 1}`;

    // Specialization is REQUIRED - orchestrator must specify it
    const specialization = typeof raw.specialization === "string" ? raw.specialization : null;

    if (!specialization) {
      const title = typeof raw.title === "string" ? raw.title : `Task ${i + 1}`;
      throw new Error(
        `Subtask ${id} (${title}) missing required 'specialization' field. ` +
          `Must be one of: code-explorer, code-architect, code-implementer, code-reviewer, researcher, generic`,
      );
    }

    return createSubtask({
      id,
      title: String((raw.title as string) ?? `Task ${i + 1}`),
      description: String((raw.description as string) ?? ""),
      acceptanceCriteria: Array.isArray(raw.acceptanceCriteria)
        ? raw.acceptanceCriteria.map(String)
        : [],
      specialization: specialization as
        | "code-explorer"
        | "code-architect"
        | "code-implementer"
        | "code-reviewer"
        | "researcher"
        | "generic",
      dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : undefined,
    });
  });

  orch.plan = { summary: planSummary, subtasks, verifyCmd };
  orch.status = "dispatching";
  await saveOrchestration(orch);

  // Broadcast status update
  await broadcastOrchestrationEvent(
    {
      type: "orchestration.updated",
      payload: buildOrchestrationSnapshot(orch),
    },
    opts.config,
  );

  // Trigger orchestration:plan-created hook
  const { triggerOrchestrationHook } = await import("./hooks.js");
  await triggerOrchestrationHook("orchestration:plan-created", {
    orchestrationId: orch.id,
    orchestration: orch,
  });

  return jsonResult({
    orchestrationId,
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
  await broadcastOrchestrationEvent(
    {
      type: "orchestration.updated",
      payload: buildOrchestrationSnapshot(orch),
    },
    opts.config,
  );

  try {
    // runWorkerPool handles the full dispatch cycle including auto-fix:
    // - Executes ready tasks via worker pool
    // - When a task fails and blocks dependents, auto-creates fix tasks (up to 2 retries)
    // - Fix tasks are executed in the same dispatch cycle (no extra dispatch call needed)
    // - Tasks that exhaust retries are reported back for Orchestrator re-planning
    const dispatchResult = await runWorkerPool({
      orchestration: orch,
      pool: opts.pool,
      config: opts.config,
      memoryManager: opts.memoryManager,
    });

    const { results, autoFixTasks: autoFixes, exhaustedTasks } = dispatchResult;
    const completed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;

    // Persist auto-fix records to orchestration
    if (autoFixes.length > 0) {
      orch.fixTasks.push(...autoFixes);
      await saveOrchestration(orch);
      await broadcastOrchestrationEvent({
        type: "orchestration.updated",
        payload: buildOrchestrationSnapshot(orch),
      });
    }

    // If tasks exhausted auto-retry, skip acceptance — Orchestrator must re-plan
    // Note: do NOT increment fixCycle here — revise-plan does it uniformly.
    if (exhaustedTasks.length > 0) {
      orch.status = "fixing";
      await saveOrchestration(orch);

      const names = exhaustedTasks.map((t) => `"${t.title}" (${t.retryCount} retries)`).join(", ");
      return jsonResult({
        orchestrationId: orchId,
        status: orch.status,
        dispatched: results.length,
        completed,
        failed,
        autoFixCreated: autoFixes.length,
        fixCycle: orch.currentFixCycle,
        maxFixCycles: orch.maxFixCycles,
        exhaustedTasks,
        message:
          `Dispatch complete: ${completed} succeeded, ${failed} failed. ` +
          `${exhaustedTasks.length} tasks exhausted auto-retry: ${names}. ` +
          `Call revise-plan to cancel exhausted tasks and add replacement tasks with a different approach. Do NOT run acceptance until blocking tasks are resolved.`,
      });
    }

    // Normal completion
    const message =
      `Dispatch complete: ${completed} succeeded, ${failed} failed.` +
      (autoFixes.length > 0 ? ` (${autoFixes.length} auto-fixes executed inline.)` : "") +
      (failed > 0
        ? " Some tasks failed - run acceptance to evaluate overall result."
        : " All tasks succeeded - run acceptance tests next.");

    return jsonResult({
      orchestrationId: orchId,
      status: orch.status,
      dispatched: results.length,
      completed,
      failed,
      autoFixCreated: autoFixes.length,
      message,
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
      resultSummary: s.resultSummary?.slice(0, 500), // Show more detail for debugging
    })),
    fixTasks: orch.fixTasks.map((f) => ({
      id: f.id,
      status: f.status,
      description: f.description.slice(0, 200),
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

  // If verifyCmd was overridden, update the plan
  if (verifyCmdOverride && verifyCmdOverride !== orch.plan.verifyCmd) {
    orch.plan.verifyCmd = verifyCmdOverride;
    logger.info("Updated plan verifyCmd", {
      orchId,
      oldCmd: orch.plan.verifyCmd,
      newCmd: verifyCmdOverride,
    });
  }

  orch.status = "acceptance";
  await saveOrchestration(orch);

  // Broadcast status update
  await broadcastOrchestrationEvent(
    {
      type: "orchestration.updated",
      payload: buildOrchestrationSnapshot(orch),
    },
    opts.config,
  );

  // Trigger acceptance:started hook
  const { triggerOrchestrationHook } = await import("./hooks.js");
  await triggerOrchestrationHook("acceptance:started", {
    orchestrationId: orchId,
    orchestration: orch,
  });

  const { runAcceptanceTests } = await import("./acceptance.js");
  const result = await runAcceptanceTests({
    orchestration: orch,
    workspaceDir: orch.workspaceDir,
    verifyCmd,
    session: opts.acceptanceSession,
    sessionManager: opts.acceptanceSessionManager,
    evaluationCount: orch.acceptanceResults.length,
    memoryManager: opts.memoryManager,
  });

  orch.acceptanceResults.push(result);

  // Confidence-based filtering (inspired by Claude Code)
  // Only consider issues with confidence >= 70 as real failures
  const CONFIDENCE_THRESHOLD = 70;
  const highConfidenceFailures = result.verdicts.filter(
    (v) => !v.passed && v.confidence >= CONFIDENCE_THRESHOLD,
  );
  const lowConfidenceFailures = result.verdicts.filter(
    (v) => !v.passed && v.confidence < CONFIDENCE_THRESHOLD,
  );

  // Log low-confidence issues for visibility but don't block completion
  if (lowConfidenceFailures.length > 0) {
    logger.info("Low-confidence issues detected (not blocking completion)", {
      orchId,
      count: lowConfidenceFailures.length,
      issues: lowConfidenceFailures.map((v) => ({
        subtaskId: v.subtaskId,
        confidence: v.confidence,
        reasoning: v.reasoning?.slice(0, 200),
      })),
    });
  }

  // Only fail if there are high-confidence issues
  const effectivelyPassed = highConfidenceFailures.length === 0;

  if (effectivelyPassed) {
    orch.status = "completed";
    orch.completedAtMs = Date.now();
  } else {
    if (orch.currentFixCycle >= orch.maxFixCycles) {
      orch.status = "failed";
      orch.error = `Acceptance failed after ${orch.maxFixCycles} fix cycles`;

      // Trigger orchestration:failed hook
      await triggerOrchestrationHook("orchestration:failed", {
        orchestrationId: orchId,
        orchestration: orch,
      });
    } else {
      orch.status = "fixing";
    }
  }

  await saveOrchestration(orch);

  // Broadcast status update
  await broadcastOrchestrationEvent(
    {
      type: "orchestration.updated",
      payload: buildOrchestrationSnapshot(orch),
    },
    opts.config,
  );

  // Trigger acceptance:completed hook
  await triggerOrchestrationHook("acceptance:completed", {
    orchestrationId: orchId,
    orchestration: orch,
    acceptance: result,
  });

  return jsonResult({
    orchestrationId: orchId,
    status: orch.status,
    passed: effectivelyPassed,
    passedCount: result.verdicts.filter((v) => v.passed).length,
    failedCount: highConfidenceFailures.length,
    lowConfidenceFailures: lowConfidenceFailures.length,
    currentFixCycle: orch.currentFixCycle,
    maxFixCycles: orch.maxFixCycles,
    currentVerifyCmd: orch.plan.verifyCmd,
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    // Minimal response to reduce context accumulation
    // Use check-status if you need detailed verdict information
    message: effectivelyPassed
      ? lowConfidenceFailures.length > 0
        ? `All high-confidence tests passed (${lowConfidenceFailures.length} low-confidence issues ignored). Call complete to copy results to output directory.`
        : "All acceptance tests passed. Call complete to copy results to output directory."
      : orch.status === "failed"
        ? `Acceptance failed after ${orch.maxFixCycles} fix cycles. Orchestration marked as failed.`
        : `Acceptance failed: ${highConfidenceFailures.length} high-confidence issues need fixes (${lowConfidenceFailures.length} low-confidence issues ignored). If verifyCmd is incorrect, you can correct it by calling run-acceptance with verifyCmd parameter. Otherwise, call revise-plan to add fix tasks.`,
  });
}

/**
 * revise-plan: Modify the plan mid-flight.
 *
 * Three operations (all optional, applied in order):
 *   1. cancelTaskIds — cancel these tasks + cascade to pending dependents
 *   2. addSubtasks   — add new tasks (IDs auto-assigned as r1, r2, ...)
 *   3. rewireDeps    — repoint existing task dependencies to new tasks
 *
 * Use cases:
 *   - Acceptance failed → add fix tasks targeting specific issues
 *   - Task exhausted auto-retry → cancel old chain, add replacement chain
 *   - Approach doesn't work → cancel + replace with different strategy
 */
async function handleRevisePlan(params: Record<string, unknown>, opts: OrchestrateToolOptions) {
  const orchId = readStringParam(params, "orchestrationId", { required: true });
  const orch = await loadOrchestration(orchId);
  if (!orch) {
    return jsonResult({ error: `Orchestration ${orchId} not found` });
  }
  if (!orch.plan) {
    return jsonResult({ error: "No plan found" });
  }

  const cancelTaskIds = Array.isArray(params.cancelTaskIds)
    ? (params.cancelTaskIds as string[])
    : [];
  const rawAddSubtasks = Array.isArray(params.addSubtasks)
    ? (params.addSubtasks as Array<Record<string, unknown>>)
    : [];
  const rawRewireDeps = Array.isArray(params.rewireDeps)
    ? (params.rewireDeps as Array<Record<string, unknown>>)
    : [];

  if (cancelTaskIds.length === 0 && rawAddSubtasks.length === 0 && rawRewireDeps.length === 0) {
    return jsonResult({
      error: "At least one of cancelTaskIds, addSubtasks, or rewireDeps is required",
    });
  }

  orch.currentFixCycle += 1;
  const allSubtasks = orch.plan.subtasks;

  // --- 1. Cancel tasks + cascade to blocked dependents ---
  let cancelledCount = 0;
  if (cancelTaskIds.length > 0) {
    const toCancel = new Set(cancelTaskIds);

    // Cascade: if a pending/failed task depends on a cancelled task, cancel it too
    // Must propagate through failed nodes — otherwise orphaned pending tasks
    // behind a failed intermediate remain stuck forever.
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of allSubtasks) {
        if ((s.status === "pending" || s.status === "failed") && !toCancel.has(s.id)) {
          const blockedByCancel = s.dependsOn?.some((depId) => toCancel.has(depId));
          if (blockedByCancel) {
            toCancel.add(s.id);
            changed = true;
          }
        }
      }
    }

    for (const s of allSubtasks) {
      if (toCancel.has(s.id) && (s.status === "pending" || s.status === "failed")) {
        s.status = "cancelled";
        cancelledCount++;
      }
    }
  }

  // --- 2. Add new subtasks ---
  const addedTasks: Array<{ id: string; title: string }> = [];
  if (rawAddSubtasks.length > 0) {
    // Find next revision task counter
    const existingRevisionIds = allSubtasks
      .filter((s) => s.id.startsWith("r"))
      .map((s) => parseInt(s.id.slice(1), 10))
      .filter((n) => !isNaN(n));
    let counter = existingRevisionIds.length > 0 ? Math.max(...existingRevisionIds) + 1 : 1;

    for (const raw of rawAddSubtasks) {
      const id = `r${counter++}`;
      const specialization =
        typeof raw.specialization === "string" ? raw.specialization : "generic";

      const subtask = createSubtask({
        id,
        title: typeof raw.title === "string" ? raw.title : `Revision task ${id}`,
        description: typeof raw.description === "string" ? raw.description : "",
        acceptanceCriteria: Array.isArray(raw.acceptanceCriteria)
          ? (raw.acceptanceCriteria as string[]).map(String)
          : [],
        specialization: specialization as Subtask["specialization"],
        dependsOn: Array.isArray(raw.dependsOn)
          ? (raw.dependsOn as string[]).map(String)
          : undefined,
      });

      allSubtasks.push(subtask);
      addedTasks.push({ id, title: subtask.title });
    }
  }

  // --- 3. Rewire dependencies ---
  let rewiredCount = 0;
  if (rawRewireDeps.length > 0) {
    for (const raw of rawRewireDeps) {
      const taskId = typeof raw.taskId === "string" ? raw.taskId : "";
      const oldDepId = typeof raw.oldDepId === "string" ? raw.oldDepId : "";
      const newDepId = typeof raw.newDepId === "string" ? raw.newDepId : "";

      const task = allSubtasks.find((s) => s.id === taskId);
      if (!task || !task.dependsOn) continue;

      const idx = task.dependsOn.indexOf(oldDepId);
      if (idx >= 0) {
        task.dependsOn[idx] = newDepId;
        rewiredCount++;
      }
    }
  }

  orch.status = "dispatching";
  await saveOrchestration(orch);

  await broadcastOrchestrationEvent(
    {
      type: "orchestration.updated",
      payload: buildOrchestrationSnapshot(orch),
    },
    opts.config,
  );

  return jsonResult({
    orchestrationId: orchId,
    fixCycle: orch.currentFixCycle,
    maxFixCycles: orch.maxFixCycles,
    cancelled: cancelledCount,
    added: addedTasks,
    rewired: rewiredCount,
    message: [
      `Plan revised (cycle ${orch.currentFixCycle}/${orch.maxFixCycles}).`,
      cancelledCount > 0
        ? `Cancelled ${cancelledCount} tasks (including cascaded dependents).`
        : null,
      addedTasks.length > 0
        ? `Added ${addedTasks.length} new tasks: ${addedTasks.map((t) => `${t.id}:"${t.title}"`).join(", ")}.`
        : null,
      rewiredCount > 0 ? `Rewired ${rewiredCount} dependencies.` : null,
      "Call dispatch to execute.",
    ]
      .filter(Boolean)
      .join(" "),
  });
}

async function handleComplete(params: Record<string, unknown>, opts: OrchestrateToolOptions) {
  const orchId = readStringParam(params, "orchestrationId", { required: true });
  const summary = readStringParam(params, "summary");
  const outputDir = readStringParam(params, "outputDir");
  const orch = await loadOrchestration(orchId);
  if (!orch) {
    return jsonResult({ error: `Orchestration ${orchId} not found` });
  }

  // Validate all tasks are completed before allowing completion
  if (orch.plan) {
    const subtasks = orch.plan.subtasks;
    const pending = subtasks.filter((s) => s.status === "pending");
    const running = subtasks.filter((s) => s.status === "running");

    if (pending.length > 0 || running.length > 0) {
      logger.warn("Cannot complete: tasks still pending/running", {
        orchId,
        pending: pending.length,
        running: running.length,
      });

      return jsonResult({
        error: `Cannot complete: ${pending.length} pending, ${running.length} running tasks remain`,
        orchestrationId: orchId,
        status: orch.status,
        pendingTasks: pending.map((s) => ({ id: s.id, title: s.title })),
        runningTasks: running.map((s) => ({ id: s.id, title: s.title })),
        message: `You must dispatch and complete all pending/running tasks before calling complete. Call dispatch to run pending tasks first.`,
      });
    }
  }

  // Default outputDir: create directory named after orchestration ID in source workspace
  // If baseProjectDir is set, use it as the output directory (replace original project)
  const finalOutputDir = outputDir || orch.baseProjectDir || `./orchestrator-output/${orchId}`;

  // Copy to output directory
  const copyResult = await copyMissionToOutput(orch.sourceWorkspaceDir, orchId, finalOutputDir);

  // Log the resolved output path for debugging
  logger.info("Orchestration completion", {
    orchId,
    copied: copyResult.copied,
    outputPath: copyResult.resolvedPath,
    sourceWorkspace: orch.sourceWorkspaceDir,
    baseProjectDir: orch.baseProjectDir,
    mode: orch.baseProjectDir ? "enhance" : "build-from-scratch",
    error: copyResult.error,
  });

  orch.status = "completed";
  orch.completedAtMs = Date.now();
  if (summary) {
    orch.error = undefined;
  }
  await saveOrchestration(orch);

  // Broadcast completion with output path
  await broadcastOrchestrationEvent(
    {
      type: "orchestration.completed",
      orchestrationId: orch.id,
      outputPath: copyResult.resolvedPath,
      summary:
        summary ?? `Orchestration completed. ${orch.plan?.subtasks.length ?? 0} subtasks executed.`,
    },
    opts.config,
  );

  // Trigger orchestration:completed hook
  const { triggerOrchestrationHook } = await import("./hooks.js");
  await triggerOrchestrationHook("orchestration:completed", {
    orchestrationId: orch.id,
    orchestration: orch,
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
      ? `✅ Orchestration completed successfully!\n\nProject files copied to: ${copyResult.resolvedPath}\n\nYou can find your completed project at the path above.`
      : `⚠️ Orchestration completed but copy failed: ${copyResult.error}\n\nMission workspace preserved at: ${orch.workspaceDir}\n\nPlease manually copy files from the mission workspace.`,
  });
}

async function handleAbort(params: Record<string, unknown>, opts: OrchestrateToolOptions) {
  const orchId = readStringParam(params, "orchestrationId", { required: true });
  const orch = await loadOrchestration(orchId);
  if (!orch) {
    return jsonResult({ error: `Orchestration ${orchId} not found` });
  }

  logger.info("Aborting orchestration", { orchId });

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
  orch.error = "Aborted by user";
  orch.completedAtMs = Date.now();
  await saveOrchestration(orch);

  // Broadcast abort event
  await broadcastOrchestrationEvent(
    {
      type: "orchestration.failed",
      orchestrationId: orchId,
      error: "Aborted by user",
    },
    opts.config,
  );

  // Trigger orchestration:failed hook
  const { triggerOrchestrationHook } = await import("./hooks.js");
  await triggerOrchestrationHook("orchestration:failed", {
    orchestrationId: orchId,
    orchestration: orch,
  });

  // Clean up mission workspace — no point keeping it after abort
  await cleanupMissionWorkspace(orch.sourceWorkspaceDir, orchId);

  logger.info("Orchestration aborted successfully", { orchId });

  // Return a result that signals the orchestrator agent to stop
  // The agent should see this as a terminal state and end the conversation
  return jsonResult({
    orchestrationId: orchId,
    status: "failed",
    aborted: true,
    message:
      "✅ Orchestration aborted successfully. All tasks cancelled and workspace cleaned up. You can now end this session.",
  });
}
