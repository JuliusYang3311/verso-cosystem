// src/orchestration/orchestrator.ts — Orchestrator daemon management
//
// Start/stop/status functions for the orchestrator daemon.
// Similar to src/agents/evolver.ts

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { VersoConfig } from "../config/types.js";
import { resolveStateDir } from "../config/paths.js";
import { enqueueOrchestration } from "./daemon-runner.js";

type OrchestratorStartResult = {
  started: boolean;
  pid?: number;
  logPath: string;
  error?: string;
};

type OrchestratorStopResult = {
  stopped: boolean;
  pid?: number;
};

type OrchestratorStatus = {
  running: boolean;
  pid?: number;
  logPath: string;
  queuePath: string;
};

const LOG_FILENAME = "orchestrator-daemon.log";
const PID_FILENAME = "orchestrator-daemon.pid";
const LOCK_FILENAME = "orchestrator-daemon.lock";

function ensureLogsDir(): string {
  const stateDir = resolveStateDir();
  const logsDir = path.join(stateDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

function resolveLogPaths(): {
  logPath: string;
  pidPath: string;
  queuePath: string;
  lockPath: string;
} {
  const logsDir = ensureLogsDir();
  const stateDir = resolveStateDir();
  return {
    logPath: path.join(logsDir, LOG_FILENAME),
    pidPath: path.join(logsDir, PID_FILENAME),
    queuePath: path.join(stateDir, "orchestrator-queue.json"),
    lockPath: path.join(logsDir, LOCK_FILENAME),
  };
}

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
  return (
    cfg?.agents?.defaults?.workspace?.trim() || process.env.OPENCLAW_WORKSPACE || process.cwd()
  );
}

export type OrchestratorDaemonOptions = {
  cfg?: VersoConfig;
  agentId?: string;
};

/**
 * Start the orchestrator daemon in the background.
 * The daemon will process queued orchestration requests.
 */
export async function startOrchestratorDaemon(
  opts?: OrchestratorDaemonOptions,
): Promise<OrchestratorStartResult> {
  const cfg = opts?.cfg;
  const { logPath, pidPath, lockPath } = resolveLogPaths();

  // Acquire lock to prevent duplicate daemon starts
  let lockFd: number;
  try {
    // Try to create lock file exclusively (fails if already exists)
    lockFd = fs.openSync(lockPath, "wx");
  } catch {
    // Lock file exists, check if daemon is actually running
    const existingPid = readPid(pidPath);
    if (existingPid && isPidAlive(existingPid)) {
      return { started: false, pid: existingPid, logPath };
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
      return { started: false, error: "Failed to acquire daemon start lock", logPath };
    }
  }

  try {
    const existingPid = readPid(pidPath);
    if (existingPid && isPidAlive(existingPid)) {
      return { started: false, pid: existingPid, logPath };
    }

    const workspace = resolveWorkspace(cfg);
    const agentId = opts?.agentId ?? "main";
    const agentSessionKey = `agent:${agentId}`;

    // Get orchestration config
    const orchConfig = cfg?.agents?.list?.find((a) => a.id === agentId)?.orchestration;
    const maxWorkers = orchConfig?.maxWorkers ?? 4;
    const maxFixCycles = orchConfig?.maxFixCycles ?? 30;
    const maxOrchestrations = orchConfig?.maxOrchestrations ?? 2;
    const verifyCmd = orchConfig?.verifyCmd ?? "";

    const scriptPath = path.join(process.cwd(), "dist", "orchestration", "daemon-entry.js");

    // Open log file for daemon output
    const logFd = fs.openSync(logPath, "a");

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
        ORCHESTRATOR_MAX_ORCHESTRATIONS: String(maxOrchestrations),
        ORCHESTRATOR_VERIFY_CMD: verifyCmd,
      },
    });
    child.unref();
    fs.writeFileSync(pidPath, String(child.pid));
    return { started: true, pid: child.pid, logPath };
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
 * Stop the orchestrator daemon.
 */
export async function stopOrchestratorDaemon(): Promise<OrchestratorStopResult> {
  const { pidPath } = resolveLogPaths();
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
 * Get the status of the orchestrator daemon.
 */
export async function getOrchestratorStatus(): Promise<OrchestratorStatus> {
  const { logPath, pidPath, queuePath, lockPath } = resolveLogPaths();
  const pid = readPid(pidPath);
  const running = pid ? isPidAlive(pid) : false;

  // Clean up stale lock if daemon is not running
  if (!running) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }

  return { running, pid: running ? (pid ?? undefined) : undefined, logPath, queuePath };
}

/**
 * Submit an orchestration request.
 * If the daemon is not running, it will be started automatically.
 */
export async function submitOrchestration(
  userPrompt: string,
  opts?: OrchestratorDaemonOptions,
): Promise<{ orchestrationId: string; daemonStarted: boolean }> {
  const { lockPath } = resolveLogPaths();

  // Acquire lock to prevent race condition when checking/starting daemon
  let lockFd: number | null = null;
  try {
    lockFd = fs.openSync(lockPath, "wx");
  } catch {
    // Lock exists, wait a bit and retry (another request is starting daemon)
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Try again without lock - daemon should be running now
    const status = await getOrchestratorStatus();
    if (!status.running) {
      // Still not running, try to acquire lock
      try {
        lockFd = fs.openSync(lockPath, "wx");
      } catch {
        throw new Error("Failed to acquire orchestration submit lock");
      }
    } else {
      // Daemon is running, just enqueue (no lock needed)
      const orchestrationId = enqueueOrchestration(userPrompt);
      return { orchestrationId, daemonStarted: false };
    }
  }

  try {
    // Check if daemon is running
    const status = await getOrchestratorStatus();
    let daemonStarted = false;

    if (!status.running) {
      // Start the daemon
      const startResult = await startOrchestratorDaemon(opts);
      if (!startResult.started && !startResult.pid) {
        throw new Error("Failed to start orchestrator daemon");
      }
      daemonStarted = true;
    }

    // Enqueue the orchestration request
    const orchestrationId = enqueueOrchestration(userPrompt);

    return { orchestrationId, daemonStarted };
  } finally {
    // Release lock if we acquired it
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
        fs.unlinkSync(lockPath);
      } catch {
        // ignore
      }
    }
  }
}
