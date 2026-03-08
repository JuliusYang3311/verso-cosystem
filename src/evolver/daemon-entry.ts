/**
 * daemon-entry.ts
 * Entry point for the evolver daemon process.
 * Spawned as a detached process by src/agents/evolver.ts.
 *
 * Because the daemon runs detached (stdio: "ignore"), we initialise the
 * logging subsystem to write directly to EVOLVER_LOG_PATH so that both
 * structured logger calls (runner.ts) and raw console.log (evolve.ts)
 * are captured in evolver-daemon.log.
 */

import { enableConsoleCapture, routeLogsToStderr } from "../logging/console.js";
import { setLoggerOverride } from "../logging/logger.js";
import { runDaemonLoop } from "./runner.js";

// --- Logging bootstrap (must run before anything else) ---
const logPath = process.env.EVOLVER_LOG_PATH;
if (logPath) {
  setLoggerOverride({ file: logPath, level: "info" });
  // Route console.* through the file logger so evolve.ts console output is captured.
  enableConsoleCapture();
  // Daemon has no TTY; avoid writes to the severed stdout.
  routeLogsToStderr();
}

// --- Config ---
const review = process.env.EVOLVER_REVIEW === "true";
const workspace = process.env.VERSO_WORKSPACE || process.env.OPENCLAW_WORKSPACE;
const model = process.env.EVOLVER_MODEL || undefined;
const agentDir = process.env.EVOLVER_AGENT_DIR || undefined;

// --- Run ---
runDaemonLoop({
  mode: "loop",
  review,
  workspace,
  model,
  agentDir,
}).catch((error) => {
  // Last-resort logging: the file logger may already be initialised, but
  // guard against the case where it failed to set up.
  console.error(`evolver-daemon: fatal ${String(error)}`);
  process.exit(1);
});
