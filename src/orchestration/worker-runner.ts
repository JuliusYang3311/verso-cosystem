// src/orchestration/worker-runner.ts — In-memory worker pool with task claiming (evolver pattern)

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Orchestration, Subtask } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { broadcastOrchestrationEvent } from "./events.js";
import { resolveAgentModel } from "./model-resolver.js";
import { saveOrchestration } from "./store.js";
import { isSubtaskReady } from "./types.js";
import { buildWorkerSystemPrompt } from "./worker-prompt.js";

const logger = createSubsystemLogger("orchestration-worker");

const DEFAULT_WORKER_TIMEOUT_MS = 600_000; // 10 minutes per task

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

function createOrchestrationSandbox(missionWorkspaceDir: string): {
  ok: boolean;
  sandboxDir: string | null;
  error: string | null;
} {
  try {
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-worker-"));

    // Copy mission workspace contents (may be empty initially)
    if (fs.existsSync(missionWorkspaceDir)) {
      const files = fs.readdirSync(missionWorkspaceDir);
      for (const file of files) {
        const src = path.join(missionWorkspaceDir, file);
        const dst = path.join(sandboxDir, file);
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          fs.cpSync(src, dst, { recursive: true });
        } else {
          fs.copyFileSync(src, dst);
        }
      }
    }

    return { ok: true, sandboxDir, error: null };
  } catch (err) {
    return { ok: false, sandboxDir: null, error: String(err) };
  }
}

function cleanupSandbox(sandboxDir: string): void {
  try {
    if (fs.existsSync(sandboxDir)) {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  } catch (err) {
    logger.warn("Failed to cleanup sandbox", { sandboxDir, error: String(err) });
  }
}

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

function copyChangedFilesBack(sandboxDir: string, targetDir: string, files: string[]): void {
  for (const file of files) {
    const src = path.join(sandboxDir, file);
    const dst = path.join(targetDir, file);
    if (!fs.existsSync(src)) {
      continue;
    }
    const dstDir = path.dirname(dst);
    if (!dstDir || dstDir === ".") {
      continue;
    }
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true });
    }
    fs.copyFileSync(src, dst);
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
  missionWorkspaceDir: string;
  memoryDir?: string; // Shared memory directory
  timeoutMs?: number;
}): Promise<WorkerResult> {
  const {
    subtask,
    orchestrationId,
    missionWorkspaceDir,
    memoryDir,
    timeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
  } = params;
  const t0 = Date.now();

  let sandboxDir: string | null = null;
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

    // 0. Ensure dependencies are installed in mission workspace (if package.json exists)
    ensureDependenciesInstalled(missionWorkspaceDir);

    // 1. Create tmpdir sandbox (copies mission workspace including node_modules if present)
    const sandbox = createOrchestrationSandbox(missionWorkspaceDir);
    if (!sandbox.ok || !sandbox.sandboxDir) {
      return {
        subtaskId: subtask.id,
        ok: false,
        resultSummary: "",
        filesChanged: [],
        error: `Sandbox creation failed: ${sandbox.error}`,
      };
    }
    sandboxDir = sandbox.sandboxDir;

    // Init git tracking for change detection
    initGitTracking(sandboxDir);

    // 2. Resolve model
    const { model, authStorage, modelRegistry } = await resolveAgentModel();
    const agentDir = (await import("../agents/agent-paths.js")).resolveOpenClawAgentDir();

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
      cwd: sandboxDir,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      customTools: workerTools, // Use customTools to add tools alongside coding tools
      sessionManager: SessionManager.inMemory(sandboxDir),
    });
    session = created.session;

    // 4. Build prompt and run
    const workerPrompt = buildWorkerSystemPrompt({
      subtask,
      orchestrationId,
      missionWorkspaceDir: sandboxDir,
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

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const agentPromise = session.prompt(prompt).then(() => "done" as const);
    const result = await Promise.race([agentPromise, timeoutPromise]);

    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }

    if (result === "timeout") {
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
        error: `Worker timed out after ${timeoutMs}ms`,
      };
    }

    // 5. Extract result
    const lastText = session.getLastAssistantText?.() ?? "";
    const ok =
      lastText.includes("TASK_COMPLETE") ||
      (!lastText.includes("TASK_FAILED") && lastText.length > 0);

    // 6. Detect and copy changed files
    const filesChanged = getChangedFilesAfter(sandboxDir);
    if (filesChanged.length > 0) {
      copyChangedFilesBack(sandboxDir, missionWorkspaceDir, filesChanged);
    }

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
    if (sandboxDir) {
      cleanupSandbox(sandboxDir);
    }

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

  // Build initial pending queue: only ready (pending + deps met) subtasks
  const pending: string[] = subtasks.filter((s) => isSubtaskReady(s, subtasks)).map((s) => s.id);

  const results: WorkerResult[] = [];

  const claimNext = (): Subtask | null => {
    // First try to claim from existing pending queue
    const id = pending.shift();
    if (id) {
      return subtaskById.get(id) ?? null;
    }

    // If pending queue is empty, check if any new tasks became ready
    const newlyReady = subtasks.filter((s) => isSubtaskReady(s, subtasks));
    if (newlyReady.length > 0) {
      pending.push(...newlyReady.map((s) => s.id));
      const nextId = pending.shift();
      return nextId ? (subtaskById.get(nextId) ?? null) : null;
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
      await saveOrchestration(orch);

      // Broadcast subtask started
      await broadcastOrchestrationEvent({
        type: "orchestration.subtask",
        payload: {
          orchestrationId: orch.id,
          subtaskId: task.id,
          status: task.status,
          title: task.title,
        },
      });

      try {
        const result = await runWorkerTask({
          subtask: task,
          orchestrationId: orch.id,
          missionWorkspaceDir: orch.workspaceDir,
          memoryDir, // Pass shared memory dir
          timeoutMs,
        });

        task.status = result.ok ? "completed" : "failed";
        task.completedAtMs = Date.now();
        task.resultSummary = result.resultSummary;
        task.error = result.error;
        await saveOrchestration(orch);

        // Broadcast subtask completed/failed
        await broadcastOrchestrationEvent({
          type: "orchestration.subtask",
          payload: {
            orchestrationId: orch.id,
            subtaskId: task.id,
            status: task.status,
            title: task.title,
            error: task.error,
          },
        });

        results.push(result);
      } catch (err) {
        // Ensure task is marked as failed even if there's an unhandled exception
        task.status = "failed";
        task.completedAtMs = Date.now();
        task.error = err instanceof Error ? err.message : String(err);
        await saveOrchestration(orch);

        // Broadcast subtask failed
        await broadcastOrchestrationEvent({
          type: "orchestration.subtask",
          payload: {
            orchestrationId: orch.id,
            subtaskId: task.id,
            status: task.status,
            title: task.title,
            error: task.error,
          },
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

  const workerCount = Math.min(maxWorkers, pending.length);
  await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));

  return results;
}
