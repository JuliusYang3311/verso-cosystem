// src/orchestration/worker-runner.ts — In-memory worker pool with task claiming (evolver pattern)

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Orchestration, Subtask } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAgentModel } from "./model-resolver.js";
import { saveOrchestration } from "./store.js";
import { buildWorkerSystemPrompt } from "./worker-prompt.js";

const logger = createSubsystemLogger("orchestration-worker");

const DEFAULT_WORKER_TIMEOUT_MS = 600_000; // 10 minutes per task

// --- Concurrency tracking ---

const activeOrchestrationIds = new Set<string>();

export function getActiveOrchestrationCount(): number {
  return activeOrchestrationIds.size;
}

export function isOrchestrationActive(orchId: string): boolean {
  return activeOrchestrationIds.has(orchId);
}

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
      .filter(Boolean);
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

    // 1. Create tmpdir sandbox (simplified - no pnpm install)
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
    const { createAgentSession, codingTools, SessionManager } =
      await import("@mariozechner/pi-coding-agent");

    const created = await createAgentSession({
      cwd: sandboxDir,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      tools: codingTools,
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

// --- Orchestration waiting pool ---

const waitingQueue: Array<() => void> = [];

function releaseOrchestrationSlot(orchId: string): void {
  activeOrchestrationIds.delete(orchId);
  // Wake up the next waiting orchestration
  const next = waitingQueue.shift();
  if (next) {
    next();
  }
}

async function acquireOrchestrationSlot(orchId: string, maxOrchestrations: number): Promise<void> {
  if (activeOrchestrationIds.size < maxOrchestrations) {
    activeOrchestrationIds.add(orchId);
    return;
  }

  // Wait for a slot to open
  logger.info(
    `orchestration ${orchId}: waiting for slot (${activeOrchestrationIds.size}/${maxOrchestrations} active)`,
  );
  await new Promise<void>((resolve) => {
    waitingQueue.push(resolve);
  });
  activeOrchestrationIds.add(orchId);
}

// --- Worker pool with task claiming ---

export async function runWorkerPool(params: {
  orchestration: Orchestration;
  maxWorkers: number;
  maxOrchestrations: number;
  memoryDir?: string; // Shared memory directory
  timeoutMs?: number;
}): Promise<WorkerResult[]> {
  const { orchestration: orch, maxWorkers, maxOrchestrations, memoryDir, timeoutMs } = params;

  if (!orch.plan) {
    throw new Error("No plan found");
  }

  // Wait for a slot if at capacity
  await acquireOrchestrationSlot(orch.id, maxOrchestrations);

  try {
    const subtasks = orch.plan.subtasks;
    const subtaskById = new Map(subtasks.map((s) => [s.id, s]));

    // Build pending queue: only ready (pending + deps met) subtasks
    const pending: string[] = subtasks.filter((s) => s.status === "pending").map((s) => s.id);

    const results: WorkerResult[] = [];

    const claimNext = (): Subtask | null => {
      const id = pending.shift();
      return id ? (subtaskById.get(id) ?? null) : null;
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

          results.push(result);
        } catch (err) {
          // Ensure task is marked as failed even if there's an unhandled exception
          task.status = "failed";
          task.completedAtMs = Date.now();
          task.error = err instanceof Error ? err.message : String(err);
          await saveOrchestration(orch);

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
  } finally {
    releaseOrchestrationSlot(orch.id);
  }
}
