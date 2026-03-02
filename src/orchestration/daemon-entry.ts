// src/orchestration/daemon-entry.ts — Orchestrator daemon entry point
//
// This file is spawned as a detached background process.
// Each daemon runs exactly one orchestration task.

import { createSubsystemLogger } from "../logging/subsystem.js";
import { runOrchestratorDaemon } from "./daemon-runner.js";

const logger = createSubsystemLogger("orchestrator-daemon-entry");

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
}).catch((err) => {
  logger.error("Daemon crashed", { orchestrationId, error: String(err) });
  process.exit(1);
});
