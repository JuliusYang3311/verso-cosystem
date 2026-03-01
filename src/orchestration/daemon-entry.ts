// src/orchestration/daemon-entry.ts — Orchestrator daemon entry point
//
// This file is spawned as a detached background process.
// It runs the orchestrator daemon loop that processes queued orchestration requests.

import { createSubsystemLogger } from "../logging/subsystem.js";
import { runOrchestratorDaemon } from "./daemon-runner.js";

const logger = createSubsystemLogger("orchestrator-daemon-entry");

const workspaceDir = process.env.ORCHESTRATOR_WORKSPACE || process.cwd();
const agentId = process.env.ORCHESTRATOR_AGENT_ID || "main";
const agentSessionKey = process.env.ORCHESTRATOR_SESSION_KEY || `agent:${agentId}`;
const maxWorkers = parseInt(process.env.ORCHESTRATOR_MAX_WORKERS || "4", 10);
const maxFixCycles = parseInt(process.env.ORCHESTRATOR_MAX_FIX_CYCLES || "3", 10);
const maxOrchestrations = parseInt(process.env.ORCHESTRATOR_MAX_ORCHESTRATIONS || "2", 10);
const verifyCmd = process.env.ORCHESTRATOR_VERIFY_CMD || "";

logger.info("Orchestrator daemon starting", {
  workspaceDir,
  agentId,
  maxWorkers,
  maxFixCycles,
  maxOrchestrations,
});

runOrchestratorDaemon({
  workspaceDir,
  agentId,
  agentSessionKey,
  maxWorkers,
  maxFixCycles,
  maxOrchestrations,
  verifyCmd,
}).catch((err) => {
  logger.error("Daemon crashed", { error: String(err) });
  process.exit(1);
});
