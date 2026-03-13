// src/orchestration/worker-runner.ts — Persistent worker pool with task claiming
//
// Workers are pre-created sessions from WorkerPool. Each dispatch cycle claims
// workers, sends first-task or subsequent-task prompts, then releases back.
// Sessions persist across dispatch cycles (initial + fix cycles).

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ToolMeta } from "../memory/post-turn-attribution.js";
import type { Orchestration, Subtask } from "./types.js";
import type { PoolWorker, WorkerPool } from "./worker-pool.js";
import { broadcastOrchestrationEvent } from "./events.js";
import { saveOrchestration } from "./store.js";
import { TaskDispatcher } from "./task-dispatcher.js";

const logger = {
  info: (...args: unknown[]) => console.log("[orchestration-worker]", ...args),
  warn: (...args: unknown[]) => console.warn("[orchestration-worker]", ...args),
  error: (...args: unknown[]) => console.error("[orchestration-worker]", ...args),
};

/**
 * Extract memory_get tool call metadata from session messages for l1_miss detection.
 * Scans assistant messages for tool_use blocks where name === "memory_get",
 * returning ToolMeta[] with the JSON-stringified input as `meta`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractToolMetas(session: any): ToolMeta[] {
  const metas: ToolMeta[] = [];
  try {
    const messages = session?.messages;
    if (!Array.isArray(messages)) return metas;

    for (const msg of messages) {
      if (msg?.role !== "assistant") continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type !== "tool_use") continue;

        const toolName = typeof b.name === "string" ? b.name : "";
        if (!toolName) continue;

        // Only collect memory_get and memory_search — these are the ones
        // post-turn attribution actually uses for l1_miss and retrieval_gaps.
        if (toolName === "memory_get" || toolName === "memory_search") {
          let meta: string | undefined;
          if (b.input != null) {
            try {
              meta = typeof b.input === "string" ? b.input : JSON.stringify(b.input);
            } catch {
              // non-critical
            }
          }
          metas.push({ toolName, meta });
        }
      }
    }
  } catch {
    // Extraction is non-critical — return what we have
  }
  return metas;
}

const DEFAULT_WORKER_TIMEOUT_MS = 600_000; // 10 minutes of inactivity per task
const MAX_SESSION_RETRIES = 2; // retries on "already processing" before giving up

// --- Types ---

export type WorkerResult = {
  subtaskId: string;
  ok: boolean;
  resultSummary: string;
  filesChanged: string[];
  error?: string;
};

// --- Sandbox helpers ---

function getChangedFilesAfter(sandboxDir: string): string[] {
  try {
    const result = execSync(
      "git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null",
      { cwd: sandboxDir, encoding: "utf-8", timeout: 10_000 },
    );
    return result
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((file) => {
        return (
          !file.startsWith("node_modules/") &&
          !file.startsWith(".git/") &&
          !file.startsWith("dist/") &&
          !file.startsWith("build/")
        );
      });
  } catch {
    return [];
  }
}

function initGitTracking(sandboxDir: string): void {
  try {
    const hasGit = fs.existsSync(path.join(sandboxDir, ".git"));
    if (!hasGit) {
      execSync("git init && git add -A && git commit -m init --allow-empty", {
        cwd: sandboxDir,
        stdio: "ignore",
        timeout: 30_000,
      });
    }
  } catch {
    // ignore
  }
}

export function ensureDependenciesInstalled(missionWorkspaceDir: string): void {
  try {
    const packageJsonPath = path.join(missionWorkspaceDir, "package.json");
    const nodeModulesPath = path.join(missionWorkspaceDir, "node_modules");

    if (!fs.existsSync(packageJsonPath)) {
      return;
    }

    const needsInstall =
      !fs.existsSync(nodeModulesPath) ||
      fs.statSync(packageJsonPath).mtimeMs > fs.statSync(nodeModulesPath).mtimeMs;

    if (!needsInstall) {
      return;
    }

    logger.info("Installing dependencies", { missionWorkspaceDir });

    const lockFiles = {
      "pnpm-lock.yaml": "pnpm install",
      "yarn.lock": "yarn install",
    };

    let installCmd = "npm install";
    for (const [lockFile, cmd] of Object.entries(lockFiles)) {
      if (fs.existsSync(path.join(missionWorkspaceDir, lockFile))) {
        installCmd = cmd;
        break;
      }
    }

    execSync(installCmd, {
      cwd: missionWorkspaceDir,
      stdio: "pipe",
      timeout: 300_000,
    });

    logger.info("Dependencies installed", { missionWorkspaceDir });
  } catch (err) {
    logger.warn("Failed to install dependencies", {
      missionWorkspaceDir,
      error: String(err),
    });
  }
}

// --- Execute a single task on a persistent worker session ---

async function executeTaskOnWorker(params: {
  worker: PoolWorker;
  subtask: Subtask;
  orchestrationId: string;
  missionWorkspaceDir: string;
  hasExistingProject?: boolean;
  memoryManager?: import("../memory/types.js").MemorySearchManager;
  timeoutMs?: number;
}): Promise<WorkerResult> {
  const {
    worker,
    subtask,
    orchestrationId,
    missionWorkspaceDir,
    hasExistingProject,
    memoryManager,
    timeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
  } = params;
  const t0 = Date.now();
  const session = worker.session;

  try {
    initGitTracking(missionWorkspaceDir);

    // Build prompt based on whether this is the worker's first task
    const isFirstTask = worker.taskCount === 0;
    let prompt: string;

    if (isFirstTask) {
      const { buildWorkerFirstTaskPrompt } = await import("./worker-prompt.js");
      prompt = buildWorkerFirstTaskPrompt({
        subtask,
        orchestrationId,
        missionWorkspaceDir,
        hasExistingProject,
      });
    } else {
      const { buildWorkerSubsequentTaskPrompt } = await import("./worker-prompt.js");
      prompt = buildWorkerSubsequentTaskPrompt({
        subtask,
        orchestrationId,
        workerSpecialization: worker.specialization,
      });
    }

    // Activity-based timeout + loop detection
    let lastActivityMs = Date.now();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const toolCallHistory: Array<{ name: string; timestamp: number }> = [];
    const LOOP_WINDOW = 10;
    const LOOP_THRESHOLD = 8;

    const checkTimeout = () => {
      const idleMs = Date.now() - lastActivityMs;
      if (idleMs >= timeoutMs) {
        return true;
      }
      timeoutHandle = setTimeout(checkTimeout, Math.min(30_000, timeoutMs - idleMs));
      return false;
    };
    timeoutHandle = setTimeout(checkTimeout, timeoutMs);

    // Hook into tool use for activity tracking (re-attach each task)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionAny = session as any;
    const originalOnToolUse = sessionAny.onToolUse;
    if (originalOnToolUse) {
      sessionAny.onToolUse = (...args: unknown[]) => {
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
            logger.warn("Potential tool loop", {
              subtaskId: subtask.id,
              tool: maxTool,
              count: maxCount,
            });
          }
        }

        return originalOnToolUse.apply(sessionAny, args);
      };
    }

    try {
      await session.prompt(prompt);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    } catch (err) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      throw err;
    } finally {
      // Restore original onToolUse to avoid stacking wrappers
      if (originalOnToolUse) sessionAny.onToolUse = originalOnToolUse;
    }

    // Extract result
    const lastText = session.getLastAssistantText?.() ?? "";
    const ok =
      lastText.includes("TASK_COMPLETE") ||
      (!lastText.includes("TASK_FAILED") && lastText.length > 0);

    // Post-turn attribution: record utilization of injected memory chunks
    if (memoryManager && worker.sessionManager) {
      try {
        const { performPostTurnAttribution } = await import("../memory/post-turn-attribution.js");
        // Extract tool metas from session messages for l1_miss detection
        const toolMetas = extractToolMetas(session);
        await performPostTurnAttribution({
          sessionManager: worker.sessionManager,
          memoryManager,
          assistantOutput: lastText,
          toolMetas,
          sessionId: `orch:${orchestrationId}:${subtask.id}`,
        });
      } catch {
        // Utilization tracking is non-critical
      }
    }

    const filesChanged = getChangedFilesAfter(missionWorkspaceDir);

    // Index result into shared memory
    if (memoryManager) {
      const { indexAgentResult } = await import("./orchestrator-memory.js");
      await indexAgentResult({
        memoryManager,
        agentType: "worker",
        agentId: subtask.id,
        title: `Worker: ${subtask.title}`,
        content: [
          `Status: ${ok ? "completed" : "failed"}`,
          `Files changed: ${filesChanged.join(", ") || "none"}`,
          "",
          lastText,
        ].join("\n"),
      });
    }

    const elapsed = Date.now() - t0;
    logger.info(`worker ${worker.id}: subtask ${subtask.id} ${ok ? "completed" : "failed"}`, {
      ok,
      filesChanged: filesChanged.length,
      elapsed_ms: elapsed,
      workerTaskCount: worker.taskCount + 1,
    });

    return {
      subtaskId: subtask.id,
      ok,
      resultSummary: lastText.slice(0, 2000),
      filesChanged,
      error: ok ? undefined : lastText.slice(0, 500) || "Task failed",
    };
  } catch (err) {
    const elapsed = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`worker ${worker.id}: subtask ${subtask.id} error`, {
      error: msg,
      elapsed_ms: elapsed,
    });
    return {
      subtaskId: subtask.id,
      ok: false,
      resultSummary: "",
      filesChanged: [],
      error: msg,
    };
  }
  // NOTE: No session.dispose() — worker session persists in the pool
}

// --- Event helpers (reduce noise in the main loop) ---

async function broadcastTaskStatus(
  orch: Orchestration,
  task: Subtask,
  config?: import("../config/types.js").VersoConfig,
): Promise<void> {
  await Promise.all([
    saveOrchestration(orch),
    broadcastOrchestrationEvent(
      {
        type: "orchestration.subtask",
        payload: {
          orchestrationId: orch.id,
          subtaskId: task.id,
          status: task.status,
          title: task.title,
          error: task.error,
        },
      },
      config,
    ),
  ]);
}

async function triggerHook(
  event: import("./hooks.js").OrchestrationHook,
  orch: Orchestration,
  task: Subtask,
  extra?: Record<string, unknown>,
): Promise<void> {
  const { triggerOrchestrationHook } = await import("./hooks.js");
  await triggerOrchestrationHook(event, {
    orchestrationId: orch.id,
    orchestration: orch,
    subtask: task,
    ...extra,
  });
}

// --- Dispatch tasks through the persistent worker pool ---

export type DispatchResult = {
  results: WorkerResult[];
  /** FixTask records from auto-fix (to persist in orch.fixTasks). */
  autoFixTasks: import("./types.js").FixTask[];
  /** Tasks that exhausted auto-retry — Orchestrator must re-plan. */
  exhaustedTasks: Array<{ id: string; title: string; retryCount: number }>;
};

export async function runWorkerPool(params: {
  orchestration: Orchestration;
  pool: WorkerPool;
  memoryManager?: import("../memory/types.js").MemorySearchManager;
  timeoutMs?: number;
  config?: import("../config/types.js").VersoConfig;
}): Promise<DispatchResult> {
  const { orchestration: orch, pool, memoryManager, timeoutMs, config } = params;

  if (!orch.plan) {
    throw new Error("No plan found");
  }

  const subtasks = orch.plan.subtasks;
  const sandboxDir = path.join(orch.workspaceDir, "sandbox");
  ensureDependenciesInstalled(sandboxDir);

  const dispatcher = new TaskDispatcher(subtasks);
  const results: WorkerResult[] = [];

  const workerLoop = async (): Promise<void> => {
    while (true) {
      // 1. Wait for a ready task (blocks until dependencies resolve or all done)
      const task = await dispatcher.next();
      if (!task) return;

      // 2. Notify: task starting
      broadcastTaskStatus(orch, task, config).catch((err) =>
        logger.warn("Failed to broadcast task start", { error: String(err) }),
      );
      await triggerHook("worker:started", orch, task);

      // 3. Claim a worker and execute — with retry on session contention.
      //    If the session is still streaming (race between settle and claim),
      //    release that worker, exclude it, and claim a different one.
      const excludeWorkers: string[] = [];
      let attempts = 0;
      let taskDone = false;

      while (!taskDone && attempts <= MAX_SESSION_RETRIES) {
        const worker = await pool.claim(task.specialization, {
          dependsOn: task.dependsOn,
          exclude: excludeWorkers.length > 0 ? excludeWorkers : undefined,
        });

        try {
          const result = await executeTaskOnWorker({
            worker,
            subtask: task,
            orchestrationId: orch.id,
            missionWorkspaceDir: sandboxDir,
            hasExistingProject: !!orch.baseProjectDir,
            memoryManager,
            timeoutMs,
          });

          pool.release(worker, task.id);
          taskDone = true;

          task.status = result.ok ? "completed" : "failed";
          task.completedAtMs = Date.now();
          task.resultSummary = result.resultSummary;
          task.error = result.error;

          if (
            result.filesChanged.some((f) => f === "package.json" || f.endsWith("/package.json"))
          ) {
            logger.info("Worker modified package.json, installing dependencies", {
              subtaskId: task.id,
            });
            try {
              ensureDependenciesInstalled(sandboxDir);
            } catch {
              /* non-fatal */
            }
          }

          await broadcastTaskStatus(orch, task, config);
          await triggerHook(result.ok ? "worker:completed" : "worker:failed", orch, task, {
            result,
          });

          results.push(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isSessionBusy = msg.includes("already processing");

          pool.release(worker);

          if (isSessionBusy && attempts < MAX_SESSION_RETRIES) {
            // Session contention — exclude this worker and try another
            excludeWorkers.push(worker.id);
            attempts++;
            logger.warn(`worker ${worker.id}: session busy, retrying on different worker`, {
              subtaskId: task.id,
              attempt: attempts,
            });
            continue;
          }

          taskDone = true;
          task.status = "failed";
          task.completedAtMs = Date.now();
          task.error = msg;

          await broadcastTaskStatus(orch, task, config);
          await triggerHook("worker:failed", orch, task);

          results.push({
            subtaskId: task.id,
            ok: false,
            resultSummary: "",
            filesChanged: [],
            error: task.error,
          });
        }
      }

      // 4. Signal dispatcher: unblock dependents, wake waiting loops
      dispatcher.onTaskDone();
    }
  };

  // Launch pool.size concurrent loops — they block-wait when no tasks are ready
  await Promise.all(Array.from({ length: pool.size }, () => workerLoop()));

  return {
    results,
    autoFixTasks: dispatcher.autoFixTasks,
    exhaustedTasks: [...dispatcher.exhaustedTasks],
  };
}
