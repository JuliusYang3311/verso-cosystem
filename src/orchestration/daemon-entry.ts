// src/orchestration/daemon-entry.ts — Orchestrator daemon entry point
//
// This file is spawned as a detached background process.
// Each daemon runs exactly one orchestration task.

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runOrchestratorDaemon } from "./daemon-runner.js";

const logger = createSubsystemLogger("orchestrator-daemon-entry");

// Load config for gateway access
const config = loadConfig();

const workspaceDir = process.env.ORCHESTRATOR_WORKSPACE || process.cwd();
const agentId = process.env.ORCHESTRATOR_AGENT_ID || "main";
const agentSessionKey = process.env.ORCHESTRATOR_SESSION_KEY || `agent:${agentId}`;
const orchestrationId = process.env.ORCHESTRATOR_ORCHESTRATION_ID;
const maxWorkers = parseInt(process.env.ORCHESTRATOR_MAX_WORKERS || "4", 10);
const maxFixCycles = parseInt(process.env.ORCHESTRATOR_MAX_FIX_CYCLES || "30", 10);
const verifyCmd = process.env.ORCHESTRATOR_VERIFY_CMD || "";

if (!orchestrationId) {
  logger.error("ORCHESTRATOR_ORCHESTRATION_ID environment variable is required");
  process.exit(1);
}

// Helper to clean up PID file on exit
function cleanupPidFile() {
  try {
    const stateDir = resolveStateDir();
    const logsDir = path.join(stateDir, "logs");
    const pidPath = path.join(logsDir, `orchestrator-${orchestrationId}.pid`);
    if (fs.existsSync(pidPath)) {
      fs.unlinkSync(pidPath);
      logger.info("Cleaned up PID file", { orchestrationId, pidPath });
    }
  } catch (err) {
    logger.warn("Failed to cleanup PID file", { orchestrationId, error: String(err) });
  }
}

// Register cleanup handlers
process.on("exit", cleanupPidFile);
process.on("SIGTERM", () => {
  logger.info("Received SIGTERM, cleaning up", { orchestrationId });
  cleanupPidFile();
  process.exit(0);
});
process.on("SIGINT", () => {
  logger.info("Received SIGINT, cleaning up", { orchestrationId });
  cleanupPidFile();
  process.exit(0);
});

logger.info("Orchestrator daemon starting", {
  orchestrationId,
  workspaceDir,
  agentId,
  maxWorkers,
  maxFixCycles,
});

runOrchestratorDaemon({
  workspaceDir,
  agentId,
  agentSessionKey,
  orchestrationId,
  maxWorkers,
  maxFixCycles,
  verifyCmd,
  config,
}).catch((err) => {
  logger.error("Daemon crashed", { orchestrationId, error: String(err) });
  cleanupPidFile();
  process.exit(1);
});
