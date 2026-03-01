// src/orchestration/worker-runner.ts — In-memory worker pool with task claiming (evolver pattern)

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Orchestration, Subtask } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
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

// --- Model resolution (evolver pattern) ---

async function resolveAgentModel(): Promise<{
  model: import("@mariozechner/pi-ai").Model<import("@mariozechner/pi-ai").Api>;
  authStorage: import("@mariozechner/pi-coding-agent").AuthStorage;
  modelRegistry: import("@mariozechner/pi-coding-agent").ModelRegistry;
}> {
  const { loadConfig } = await import("../config/config.js");
  const { resolveConfiguredModelRef } = await import("../agents/model-selection.js");
  const { resolveModel } = await import("../agents/pi-embedded-runner/model.js");

  const cfg = loadConfig();
  const ref = resolveConfiguredModelRef({
    cfg,
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4-20250514",
  });

  const agentDir = (await import("../agents/agent-paths.js")).resolveOpenClawAgentDir();
  const { model, error, authStorage, modelRegistry } = resolveModel(
    ref.provider,
    ref.model,
    agentDir,
    cfg,
  );
  if (!model || error) {
    throw new Error(`Failed to resolve model ${ref.provider}/${ref.model}: ${error ?? "unknown"}`);
  }

  const { resolveApiKeyForProvider } = await import("../agents/model-auth.js");
  try {
    const auth = await resolveApiKeyForProvider({ provider: ref.provider, cfg, agentDir });
    if (auth.apiKey) {
      authStorage.setRuntimeApiKey(ref.provider, auth.apiKey);
    }
  } catch {
    // best-effort
  }

  return { model, authStorage, modelRegistry };
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
  timeoutMs?: number;
}): Promise<WorkerResult> {
  const {
    subtask,
    orchestrationId,
    missionWorkspaceDir,
    timeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
  } = params;
  const t0 = Date.now();

  let sandboxDir: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let session: any = null;

  try {
    // 1. Create tmpdir sandbox
    const { createTmpdirSandbox } = await import("../evolver/gep/sandbox-runner.js");
    const sandbox = createTmpdirSandbox(missionWorkspaceDir);
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
      const { cleanupTmpdir } = await import("../evolver/gep/sandbox-runner.js");
      cleanupTmpdir(sandboxDir);
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
  timeoutMs?: number;
}): Promise<WorkerResult[]> {
  const { orchestration: orch, maxWorkers, maxOrchestrations, timeoutMs } = params;

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

        const result = await runWorkerTask({
          subtask: task,
          orchestrationId: orch.id,
          missionWorkspaceDir: orch.workspaceDir,
          timeoutMs,
        });

        task.status = result.ok ? "completed" : "failed";
        task.completedAtMs = Date.now();
        task.resultSummary = result.resultSummary;
        task.error = result.error;
        await saveOrchestration(orch);

        results.push(result);
      }
    };

    const workerCount = Math.min(maxWorkers, pending.length);
    await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));

    return results;
  } finally {
    releaseOrchestrationSlot(orch.id);
  }
}
