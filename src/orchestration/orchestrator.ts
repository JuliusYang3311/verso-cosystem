// src/orchestration/orchestrator.ts — Orchestrator daemon management (multi-daemon architecture)
//
// Each orchestration runs in its own dedicated daemon process.
// maxOrchestrations controls the maximum number of concurrent daemons.
// Queuing: When max daemons reached, new orchestrations are queued and auto-started when a daemon completes.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { VersoConfig } from "../config/types.js";
import { resolveStateDir } from "../config/paths.js";
import { saveOrchestration } from "./store.js";
import { createOrchestration } from "./types.js";

const logger = {
  info: (...args: unknown[]) => console.log("[orchestrator-daemon-manager]", ...args),
  warn: (...args: unknown[]) => console.warn("[orchestrator-daemon-manager]", ...args),
  error: (...args: unknown[]) => console.error("[orchestrator-daemon-manager]", ...args),
};

type QueuedOrchestration = {
  orchestrationId: string;
  cfg?: VersoConfig;
  agentId: string;
  userPrompt: string;
  queuedAtMs: number;
};

type OrchestratorStartResult = {
  started: boolean;
  pid?: number;
  logPath: string;
  orchestrationId: string;
  error?: string;
};

type OrchestratorStopResult = {
  stopped: boolean;
  pid?: number;
};

export type OrchestratorDaemonOptions = {
  cfg?: VersoConfig;
  agentId?: string;
  orchestrationId: string;
  userPrompt: string;
  provider?: string;
  model?: string;
};

function ensureLogsDir(): string {
  const stateDir = resolveStateDir();
  const logsDir = path.join(stateDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

function resolveLogPath(orchestrationId: string): string {
  const logsDir = ensureLogsDir();
  return path.join(logsDir, `orchestrator-${orchestrationId}.log`);
}

function resolvePidPath(orchestrationId: string): string {
  const logsDir = ensureLogsDir();
  return path.join(logsDir, `orchestrator-${orchestrationId}.pid`);
}

function resolveLockPath(orchestrationId: string): string {
  const logsDir = ensureLogsDir();
  return path.join(logsDir, `orchestrator-${orchestrationId}.lock`);
}

function resolveQueuePath(): string {
  const stateDir = resolveStateDir();
  return path.join(stateDir, "orchestration-queue.json");
}

function loadQueue(): QueuedOrchestration[] {
  const queuePath = resolveQueuePath();
  try {
    if (!fs.existsSync(queuePath)) {
      return [];
    }
    const raw = fs.readFileSync(queuePath, "utf-8");
    return JSON.parse(raw) as QueuedOrchestration[];
  } catch {
    return [];
  }
}

function saveQueue(queue: QueuedOrchestration[]): void {
  const queuePath = resolveQueuePath();
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), "utf-8");
}

function enqueueOrchestration(item: QueuedOrchestration): void {
  const queue = loadQueue();
  queue.push(item);
  saveQueue(queue);
  logger.info("Orchestration queued", {
    orchestrationId: item.orchestrationId,
    queueLength: queue.length,
  });
}

function dequeueOrchestration(): QueuedOrchestration | null {
  const queue = loadQueue();
  if (queue.length === 0) {
    return null;
  }
  const item = queue.shift()!;
  saveQueue(queue);
  logger.info("Orchestration dequeued", {
    orchestrationId: item.orchestrationId,
    remainingInQueue: queue.length,
  });
  return item;
}

export { dequeueOrchestration };

function readPid(pidPath: string): number | null {
  try {
    const raw = fs.readFileSync(pidPath, "utf-8").trim();
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveWorkspace(cfg?: VersoConfig): string {
  const workspace =
    cfg?.agents?.defaults?.workspace?.trim() || process.env.OPENCLAW_WORKSPACE || process.cwd();
  // Ensure absolute path to prevent issues when daemon cwd changes
  return path.resolve(workspace);
}

function countActiveDaemons(): number {
  const logsDir = ensureLogsDir();
  const files = fs.readdirSync(logsDir);
  let count = 0;
  for (const file of files) {
    if (file.startsWith("orchestrator-") && file.endsWith(".pid")) {
      const pidPath = path.join(logsDir, file);
      const pid = readPid(pidPath);
      if (pid && isPidAlive(pid)) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Start a dedicated daemon for a specific orchestration.
 * If max daemons reached, the orchestration is queued.
 */
export async function startOrchestratorDaemon(
  opts: OrchestratorDaemonOptions,
): Promise<OrchestratorStartResult> {
  const cfg = opts.cfg;
  const orchestrationId = opts.orchestrationId;
  const logPath = resolveLogPath(orchestrationId);
  const pidPath = resolvePidPath(orchestrationId);
  const lockPath = resolveLockPath(orchestrationId);

  // Check max concurrent daemons
  const agentId = opts.agentId ?? "main";
  const orchConfig = cfg?.agents?.list?.find((a) => a.id === agentId)?.orchestration;
  const maxOrchestrations = orchConfig?.maxOrchestrations ?? 2;
  const activeDaemons = countActiveDaemons();

  if (activeDaemons >= maxOrchestrations) {
    // Queue this orchestration
    enqueueOrchestration({
      orchestrationId,
      cfg,
      agentId,
      userPrompt: opts.userPrompt,
      queuedAtMs: Date.now(),
    });

    return {
      started: false,
      orchestrationId,
      logPath,
      error: `Maximum concurrent orchestrations reached (${activeDaemons}/${maxOrchestrations}). Orchestration queued.`,
    };
  }

  // Acquire lock to prevent duplicate daemon starts
  let lockFd: number;
  try {
    lockFd = fs.openSync(lockPath, "wx");
  } catch {
    // Lock file exists, check if daemon is actually running
    const existingPid = readPid(pidPath);
    if (existingPid && isPidAlive(existingPid)) {
      return { started: false, pid: existingPid, orchestrationId, logPath };
    }
    // Stale lock, remove it and retry
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
    try {
      lockFd = fs.openSync(lockPath, "wx");
    } catch {
      return {
        started: false,
        orchestrationId,
        logPath,
        error: "Failed to acquire daemon start lock",
      };
    }
  }

  try {
    const existingPid = readPid(pidPath);
    if (existingPid && isPidAlive(existingPid)) {
      return { started: false, pid: existingPid, orchestrationId, logPath };
    }

    const workspace = resolveWorkspace(cfg);
    const agentSessionKey = `agent:${agentId}:orch:${orchestrationId}`;

    // Get orchestration config
    const maxWorkers = orchConfig?.maxWorkers ?? 4;
    const maxFixCycles = orchConfig?.maxFixCycles ?? 30;
    const verifyCmd = orchConfig?.verifyCmd ?? "";

    const scriptPath = path.join(process.cwd(), "dist", "orchestration", "daemon-entry.js");

    // Open log file for daemon output
    const logFd = fs.openSync(logPath, "a");

    // Build model slug from calling session's provider/model (like evolver)
    const modelSlug = opts.provider && opts.model ? `${opts.provider}/${opts.model}` : undefined;

    const child = spawn(process.execPath, [scriptPath], {
      detached: true,
      stdio: ["ignore", logFd, logFd], // Redirect stdout and stderr to log file
      env: {
        ...process.env,
        ORCHESTRATOR_WORKSPACE: workspace,
        ORCHESTRATOR_AGENT_ID: agentId,
        ORCHESTRATOR_SESSION_KEY: agentSessionKey,
        ORCHESTRATOR_MAX_WORKERS: String(maxWorkers),
        ORCHESTRATOR_MAX_FIX_CYCLES: String(maxFixCycles),
        ORCHESTRATOR_VERIFY_CMD: verifyCmd,
        ORCHESTRATOR_ORCHESTRATION_ID: orchestrationId, // Pass orchestration ID
        ...(modelSlug ? { ORCHESTRATOR_MODEL: modelSlug } : {}),
      },
    });
    child.unref();
    fs.writeFileSync(pidPath, String(child.pid));
    return { started: true, pid: child.pid, orchestrationId, logPath };
  } finally {
    // Release lock
    try {
      fs.closeSync(lockFd);
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

/**
 * Stop a specific orchestrator daemon.
 */
export async function stopOrchestratorDaemon(
  orchestrationId: string,
): Promise<OrchestratorStopResult> {
  const pidPath = resolvePidPath(orchestrationId);
  const pid = readPid(pidPath);
  if (!pid) {
    return { stopped: false };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(pidPath);
  } catch {
    // ignore
  }
  return { stopped: true, pid };
}

/**
 * Submit an orchestration request.
 * Creates the orchestration and starts a dedicated daemon for it.
 */
export async function submitOrchestration(
  userPrompt: string,
  opts?: {
    cfg?: VersoConfig;
    agentId?: string;
    baseProjectDir?: string;
    provider?: string;
    model?: string;
  },
): Promise<{ orchestrationId: string; daemonStarted: boolean; error?: string }> {
  const cfg = opts?.cfg;
  const agentId = opts?.agentId ?? "main";
  const workspace = resolveWorkspace(cfg);

  // Generate orchestration ID
  const orchestrationId = `orch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  // Get orchestration config
  const orchConfig = cfg?.agents?.list?.find((a) => a.id === agentId)?.orchestration;
  const maxFixCycles = orchConfig?.maxFixCycles ?? 30;

  // Resolve baseProjectDir to absolute path if provided
  const baseProjectDir = opts?.baseProjectDir
    ? path.isAbsolute(opts.baseProjectDir)
      ? opts.baseProjectDir
      : path.resolve(workspace, opts.baseProjectDir)
    : undefined;

  // Create orchestration record
  const orchestration = createOrchestration({
    id: orchestrationId,
    userPrompt,
    orchestratorSessionKey: `agent:${agentId}:orch:${orchestrationId}`,
    agentId,
    workspaceDir: "", // Will be set by daemon
    sourceWorkspaceDir: workspace,
    baseProjectDir,
    maxFixCycles,
  });

  await saveOrchestration(orchestration);

  // Start dedicated daemon for this orchestration
  const startResult = await startOrchestratorDaemon({
    cfg,
    agentId,
    orchestrationId,
    userPrompt,
    provider: opts?.provider,
    model: opts?.model,
  });

  if (!startResult.started) {
    return {
      orchestrationId,
      daemonStarted: false,
      error: startResult.error || "Failed to start daemon",
    };
  }

  return { orchestrationId, daemonStarted: true };
}

/**
 * Get current orchestrator status including active daemons and queue length.
 */
export type OrchestratorStatus = {
  activeDaemons: number;
  maxOrchestrations: number;
  queueLength: number;
  activeOrchestrationIds: string[];
};

export function getOrchestratorStatus(cfg?: VersoConfig, agentId?: string): OrchestratorStatus {
  const orchConfig = cfg?.agents?.list?.find((a) => a.id === (agentId ?? "main"))?.orchestration;
  const maxOrchestrations = orchConfig?.maxOrchestrations ?? 2;
  const queue = loadQueue();

  // Get active orchestration IDs
  const logsDir = ensureLogsDir();
  const files = fs.readdirSync(logsDir);
  const activeIds: string[] = [];

  for (const file of files) {
    if (file.startsWith("orchestrator-") && file.endsWith(".pid")) {
      const pidPath = path.join(logsDir, file);
      const pid = readPid(pidPath);
      if (pid && isPidAlive(pid)) {
        // Extract orchestration ID from filename: orchestrator-{id}.pid
        const orchId = file.slice("orchestrator-".length, -".pid".length);
        activeIds.push(orchId);
      }
    }
  }

  return {
    activeDaemons: activeIds.length,
    maxOrchestrations,
    queueLength: queue.length,
    activeOrchestrationIds: activeIds,
  };
}
