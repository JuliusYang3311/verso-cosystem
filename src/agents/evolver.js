import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
const LOG_FILENAME = "evolver-daemon.log";
const PID_FILENAME = "evolver-daemon.pid";
const ROLLBACK_FILENAME = "evolver-daemon.rollback.json";
/** Full verification command: typecheck + lint + build + test. */
const VERIFY_CMD = "npx tsc --noEmit && pnpm lint && pnpm build && pnpm vitest run";
function ensureLogsDir() {
  const stateDir = resolveStateDir();
  const logsDir = path.join(stateDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  return logsDir;
}
function resolveLogPaths() {
  const logsDir = ensureLogsDir();
  return {
    logPath: path.join(logsDir, LOG_FILENAME),
    pidPath: path.join(logsDir, PID_FILENAME),
    rollbackPath: path.join(logsDir, ROLLBACK_FILENAME),
  };
}
function readPid(pidPath) {
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
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function resolveWorkspace(cfg) {
  return (
    cfg?.agents?.defaults?.workspace?.trim() || process.env.OPENCLAW_WORKSPACE || process.cwd()
  );
}
function resolveMemoryDir(workspace) {
  const fromEnv = process.env.MEMORY_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(workspace, "memory");
}
export async function startEvolverDaemon(opts) {
  const cfg = opts?.cfg;
  const { logPath, pidPath } = resolveLogPaths();
  const existingPid = readPid(pidPath);
  if (existingPid && isPidAlive(existingPid)) {
    return { started: false, pid: existingPid, logPath };
  }
  const workspace = resolveWorkspace(cfg);
  const memoryDir = resolveMemoryDir(workspace);
  const review = cfg?.evolver?.review ?? false;
  const agentDir = resolveOpenClawAgentDir();
  // Build model slug from main session's provider/model
  const modelSlug = opts?.provider && opts?.model ? `${opts.provider}/${opts.model}` : undefined;
  const scriptPath = path.join(process.cwd(), "dist", "evolver", "daemon-entry.js");
  const child = spawn(process.execPath, [scriptPath], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      VERSO_WORKSPACE: workspace,
      OPENCLAW_WORKSPACE: workspace,
      MEMORY_DIR: memoryDir,
      EVOLVER_REVIEW: review ? "true" : "false",
      EVOLVER_VERIFY_CMD: VERIFY_CMD,
      EVOLVER_LOG_PATH: logPath,
      ...(modelSlug ? { EVOLVER_MODEL: modelSlug } : {}),
      EVOLVER_AGENT_DIR: agentDir,
    },
  });
  child.unref();
  fs.writeFileSync(pidPath, String(child.pid));
  return { started: true, pid: child.pid, logPath };
}
export async function stopEvolverDaemon() {
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
export async function getEvolverStatus() {
  const { logPath, pidPath, rollbackPath } = resolveLogPaths();
  const pid = readPid(pidPath);
  const running = pid ? isPidAlive(pid) : false;
  return { running, pid: running ? (pid ?? undefined) : undefined, logPath, rollbackPath };
}
export async function readEvolverRollbackInfo() {
  const { rollbackPath } = resolveLogPaths();
  try {
    const raw = fs.readFileSync(rollbackPath, "utf-8").trim();
    return raw ? raw : null;
  } catch {
    return null;
  }
}
