// src/orchestration/worker-runner.ts — In-memory worker pool with task claiming (evolver pattern)

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Orchestration, Subtask } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { broadcastOrchestrationEvent } from "./events.js";
import { resolveAgentModel } from "./model-resolver.js";
import { saveOrchestration } from "./store.js";
import { isSubtaskReady } from "./types.js";
import { buildWorkerSystemPrompt } from "./worker-prompt.js";

const logger = createSubsystemLogger("orchestration-worker");

const DEFAULT_WORKER_TIMEOUT_MS = 600_000; // 10 minutes of inactivity per task

// --- Concurrency tracking removed (multi-daemon architecture) ---
// Each daemon runs one orchestration, so no cross-orchestration tracking needed

// --- Types ---

export type WorkerResult = {
  subtaskId: string;
  ok: boolean;
  resultSummary: string;
  filesChanged: string[];
  error?: string;
};

// --- Sandbox creation (simplified for orchestration - no pnpm install) ---

// --- Sandbox helpers (adapted from evolver) ---

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
        // Exclude node_modules and other large directories
        // These should be installed in mission workspace and shared
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

/**
 * Install dependencies if package.json exists and is newer than node_modules.
 * Handles incremental updates as workers add dependencies during orchestration.
 */
function ensureDependenciesInstalled(missionWorkspaceDir: string): void {
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

    // Detect package manager
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

// --- Single worker task ---

async function runWorkerTask(params: {
  subtask: Subtask;
  orchestrationId: string;
  missionWorkspaceDir: string; // This is now the shared sandbox directory
  memoryDir?: string;
  timeoutMs?: number;
  hasExistingProject?: boolean;
  // Shared resources to avoid repeated resolution
  sharedResources?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authStorage: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modelRegistry: any;
    agentDir: string;
  };
}): Promise<WorkerResult> {
  const {
    subtask,
    orchestrationId,
    missionWorkspaceDir, // Shared sandbox directory
    memoryDir,
    timeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
    sharedResources,
    hasExistingProject,
  } = params;
  const t0 = Date.now();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let session: any = null;

  // Save original env to restore later
  const originalMemoryDir = process.env.MEMORY_DIR;
  const originalVersoMemoryDir = process.env.VERSO_MEMORY_DIR;

  try {
    // Set shared memory env vars if provided
    if (memoryDir) {
      process.env.MEMORY_DIR = memoryDir;
      process.env.VERSO_MEMORY_DIR = memoryDir;
    }

    // 0. Dependencies already installed by pool (skip redundant check)

    // 1. Work directly in shared sandbox (no tmpdir needed)
    // All agents (orchestrator, workers, acceptance) share the same sandbox
    // Init git tracking for change detection (if not already initialized)
    initGitTracking(missionWorkspaceDir);

    // 2. Use shared resources if provided, otherwise resolve
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let model: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let authStorage: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let modelRegistry: any;
    let agentDir: string;

    if (sharedResources) {
      ({ model, authStorage, modelRegistry, agentDir } = sharedResources);
    } else {
      const resolved = await resolveAgentModel();
      model = resolved.model;
      authStorage = resolved.authStorage;
      modelRegistry = resolved.modelRegistry;
      agentDir = (await import("../agents/agent-paths.js")).resolveOpenClawAgentDir();
    }

    // 3. Create in-memory agent session
    const { createAgentSession, SessionManager } = await import("@mariozechner/pi-coding-agent");

    // Create web search and web fetch tools for workers (same as orchestrator)
    const { createWebSearchTool } = await import("../agents/tools/web-search.js");
    const { createWebFetchTool } = await import("../agents/tools/web-fetch.js");
    const { loadConfig } = await import("../config/config.js");
    const config = loadConfig();
    const webSearchTool = createWebSearchTool({ config, sandboxed: false });
    const webFetchTool = createWebFetchTool({ config, sandboxed: false });

    // Create Google Workspace tools for workers (if enabled, same as orchestrator)
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

    const workerTools = [
      ...(webSearchTool ? [webSearchTool] : []),
      ...(webFetchTool ? [webFetchTool] : []),
      ...gworkspaceTools,
    ];

    const created = await createAgentSession({
      cwd: missionWorkspaceDir,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      customTools: workerTools, // Use customTools to add tools alongside coding tools
      sessionManager: SessionManager.inMemory(missionWorkspaceDir),
    });
    session = created.session;

    // 4. Build prompt and run
    const workerPrompt = buildWorkerSystemPrompt({
      subtask,
      orchestrationId,
      missionWorkspaceDir,
      hasExistingProject,
    });

    const prompt = [
      workerPrompt,
      "",
      `Execute subtask: ${subtask.title}`,
      "",
      subtask.description,
      "",
      "Acceptance criteria:",
      ...subtask.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`),
      "",
      "When done, output: TASK_COMPLETE",
      "If you cannot complete the task, output: TASK_FAILED",
    ].join("\n");

    // Activity-based timeout: reset timer on each tool use
    let lastActivityMs = Date.now();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    // Tool call loop detection: track recent tool calls to detect infinite loops
    const toolCallHistory: Array<{ name: string; timestamp: number }> = [];
    const LOOP_DETECTION_WINDOW = 10; // Check last 10 tool calls
    const LOOP_DETECTION_THRESHOLD = 8; // If 8 out of 10 are the same tool, it's a loop

    const checkTimeout = () => {
      const idleMs = Date.now() - lastActivityMs;
      if (idleMs >= timeoutMs) {
        return true; // Timed out
      }
      // Schedule next check
      timeoutHandle = setTimeout(checkTimeout, Math.min(30_000, timeoutMs - idleMs));
      return false;
    };

    // Start timeout checker
    timeoutHandle = setTimeout(checkTimeout, timeoutMs);

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
            logger.warn("Detected potential tool call loop", {
              subtaskId: subtask.id,
              tool: maxTool,
              count: maxCount,
              window: LOOP_DETECTION_WINDOW,
            });
            // Don't abort immediately - just log warning
            // The timeout will eventually catch it if it's truly stuck
          }
        }

        return originalOnToolUse.apply(session, args);
      };
    }

    try {
      await session.prompt(prompt);

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      // Check if we timed out
      if (checkTimeout()) {
        try {
          await session.abort();
        } catch {
          // ignore
        }
        return {
          subtaskId: subtask.id,
          ok: false,
          resultSummary: "",
          filesChanged: [],
          error: `Worker timed out after ${timeoutMs}ms of inactivity`,
        };
      }
    } catch (err) {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      throw err;
    }

    // 5. Extract result
    const lastText = session.getLastAssistantText?.() ?? "";
    const ok =
      lastText.includes("TASK_COMPLETE") ||
      (!lastText.includes("TASK_FAILED") && lastText.length > 0);

    // 6. Detect changed files (for logging and dependency detection)
    const filesChanged = getChangedFilesAfter(missionWorkspaceDir);

    const elapsed = Date.now() - t0;
    logger.info(`worker: subtask ${subtask.id} completed`, {
      ok,
      filesChanged: filesChanged.length,
      elapsed_ms: elapsed,
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
    logger.warn(`worker: subtask ${subtask.id} failed`, { error: msg, elapsed_ms: elapsed });
    return {
      subtaskId: subtask.id,
      ok: false,
      resultSummary: "",
      filesChanged: [],
      error: msg,
    };
  } finally {
    // 7. Guaranteed cleanup
    if (session) {
      try {
        session.dispose();
      } catch {
        // ignore
      }
    }
    // No tmpdir sandbox to cleanup - workers work directly in shared sandbox

    // Restore original memory env vars
    if (originalMemoryDir !== undefined) {
      process.env.MEMORY_DIR = originalMemoryDir;
    } else {
      delete process.env.MEMORY_DIR;
    }
    if (originalVersoMemoryDir !== undefined) {
      process.env.VERSO_MEMORY_DIR = originalVersoMemoryDir;
    } else {
      delete process.env.VERSO_MEMORY_DIR;
    }
  }
}

// --- Worker pool with task claiming ---

export async function runWorkerPool(params: {
  orchestration: Orchestration;
  maxWorkers: number;
  memoryDir?: string; // Shared memory directory
  timeoutMs?: number;
}): Promise<WorkerResult[]> {
  const { orchestration: orch, maxWorkers, memoryDir, timeoutMs } = params;

  if (!orch.plan) {
    throw new Error("No plan found");
  }

  const subtasks = orch.plan.subtasks;
  const subtaskById = new Map(subtasks.map((s) => [s.id, s]));

  // Optimize: Install dependencies once before starting workers (in sandbox directory)
  const sandboxDir = path.join(orch.workspaceDir, "sandbox");
  ensureDependenciesInstalled(sandboxDir);

  // Optimize: Resolve model/auth once and share across workers
  const { model, authStorage, modelRegistry } = await resolveAgentModel();
  const agentDir = (await import("../agents/agent-paths.js")).resolveOpenClawAgentDir();

  // Build initial pending queue: only ready (pending + deps met) subtasks
  const pending: string[] = subtasks.filter((s) => isSubtaskReady(s, subtasks)).map((s) => s.id);
  const claimed = new Set<string>(); // Track claimed tasks to avoid duplicates

  const results: WorkerResult[] = [];

  const claimNext = (): Subtask | null => {
    // First try to claim from existing pending queue
    while (pending.length > 0) {
      const id = pending.shift();
      if (id && !claimed.has(id)) {
        const task = subtaskById.get(id);
        if (task && task.status === "pending") {
          claimed.add(id);
          return task;
        }
      }
    }

    // If pending queue is empty, check if any new tasks became ready
    const newlyReady = subtasks.filter((s) => isSubtaskReady(s, subtasks) && !claimed.has(s.id));
    if (newlyReady.length > 0) {
      pending.push(...newlyReady.map((s) => s.id));
      const nextId = pending.shift();
      if (nextId && !claimed.has(nextId)) {
        const task = subtaskById.get(nextId);
        if (task) {
          claimed.add(nextId);
          return task;
        }
      }
    }

    return null;
  };

  const workerLoop = async (): Promise<void> => {
    while (true) {
      const task = claimNext();
      if (!task) {
        break;
      }

      task.status = "running";
      task.startedAtMs = Date.now();
      // Optimize: Save and broadcast in parallel (non-blocking)
      Promise.all([
        saveOrchestration(orch),
        broadcastOrchestrationEvent({
          type: "orchestration.subtask",
          payload: {
            orchestrationId: orch.id,
            subtaskId: task.id,
            status: task.status,
            title: task.title,
          },
        }),
      ]).catch((err) => logger.warn("Failed to save/broadcast task start", { error: String(err) }));

      // Trigger worker:started hook
      const { triggerOrchestrationHook } = await import("./hooks.js");
      await triggerOrchestrationHook("worker:started", {
        orchestrationId: orch.id,
        orchestration: orch,
        subtask: task,
      });

      try {
        const result = await runWorkerTask({
          subtask: task,
          orchestrationId: orch.id,
          missionWorkspaceDir: path.join(orch.workspaceDir, "sandbox"), // Use sandbox directory
          memoryDir,
          timeoutMs,
          hasExistingProject: !!orch.baseProjectDir,
          sharedResources: { model, authStorage, modelRegistry, agentDir },
        });

        task.status = result.ok ? "completed" : "failed";
        task.completedAtMs = Date.now();
        task.resultSummary = result.resultSummary;
        task.error = result.error;

        // Check if worker modified package.json and install dependencies if needed
        // This ensures next workers can use newly added dependencies
        if (result.filesChanged.some((f) => f === "package.json" || f.endsWith("/package.json"))) {
          logger.info("Worker modified package.json, installing dependencies", {
            subtaskId: task.id,
            orchestrationId: orch.id,
          });
          try {
            ensureDependenciesInstalled(orch.workspaceDir);
          } catch (err) {
            logger.warn("Failed to install dependencies after worker completion", {
              subtaskId: task.id,
              error: String(err),
            });
          }
        }

        // Optimize: Save and broadcast in parallel
        await Promise.all([
          saveOrchestration(orch),
          broadcastOrchestrationEvent({
            type: "orchestration.subtask",
            payload: {
              orchestrationId: orch.id,
              subtaskId: task.id,
              status: task.status,
              title: task.title,
              error: task.error,
            },
          }),
        ]);

        // Trigger worker:completed or worker:failed hook
        if (result.ok) {
          await triggerOrchestrationHook("worker:completed", {
            orchestrationId: orch.id,
            orchestration: orch,
            subtask: task,
            result,
          });
        } else {
          await triggerOrchestrationHook("worker:failed", {
            orchestrationId: orch.id,
            orchestration: orch,
            subtask: task,
            result,
          });
        }

        results.push(result);
      } catch (err) {
        // Ensure task is marked as failed even if there's an unhandled exception
        task.status = "failed";
        task.completedAtMs = Date.now();
        task.error = err instanceof Error ? err.message : String(err);

        await Promise.all([
          saveOrchestration(orch),
          broadcastOrchestrationEvent({
            type: "orchestration.subtask",
            payload: {
              orchestrationId: orch.id,
              subtaskId: task.id,
              status: task.status,
              title: task.title,
              error: task.error,
            },
          }),
        ]);

        // Trigger worker:failed hook for unhandled exceptions
        await triggerOrchestrationHook("worker:failed", {
          orchestrationId: orch.id,
          orchestration: orch,
          subtask: task,
        });

        results.push({
          subtaskId: task.id,
          ok: false,
          resultSummary: "",
          filesChanged: [],
          error: task.error,
        });
      }
    }
  };

  // Start workers based on maxWorkers, not just initial pending length
  // This ensures we have enough workers to handle tasks that become ready later
  const workerCount = Math.min(maxWorkers, subtasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));

  return results;
}
