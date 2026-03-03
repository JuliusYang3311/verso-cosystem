// src/orchestration/daemon-runner.ts — Orchestrator daemon runner (single-task per daemon)
//
// Each daemon runs exactly one orchestration task.
// Multiple daemons can run concurrently (controlled by maxOrchestrations).

import { createSubsystemLogger } from "../logging/subsystem.js";
import { broadcastOrchestrationEvent } from "./events.js";
import {
  initOrchestrationMemory,
  cleanupOrchestrationMemory,
  getOrchestrationMemoryEnv,
} from "./orchestrator-memory.js";
import { buildOrchestratorSystemPrompt } from "./orchestrator-prompt.js";
import { createOrchestrateTool } from "./orchestrator-tools.js";
import {
  loadOrchestration,
  saveOrchestration,
  initMissionWorkspace,
  cleanupMissionWorkspace,
} from "./store.js";
import { ORCHESTRATION_DEFAULTS } from "./types.js";

const logger = createSubsystemLogger("orchestrator-daemon");

export type OrchestratorDaemonOptions = {
  workspaceDir: string;
  agentId: string;
  agentSessionKey: string;
  orchestrationId: string;
  maxWorkers?: number;
  maxFixCycles?: number;
  verifyCmd?: string;
};

/**
 * Run a single orchestration task in this daemon.
 * The daemon exits when the task completes or fails.
 */
async function runOrchestrationTask(opts: OrchestratorDaemonOptions): Promise<void> {
  const orchId = opts.orchestrationId;
  const t0 = Date.now();

  logger.info("Starting orchestration task", { orchId });

  // Load orchestration
  const orch = await loadOrchestration(orchId);
  if (!orch) {
    logger.error("Orchestration not found", { orchId });
    throw new Error(`Orchestration ${orchId} not found`);
  }

  // Initialize mission workspace
  const missionDir = await initMissionWorkspace(opts.workspaceDir, orchId);
  orch.workspaceDir = missionDir;
  await saveOrchestration(orch);

  // Create shared sandbox directory inside mission workspace
  // All agents (orchestrator, workers, acceptance) work in this sandbox
  const fs = await import("node:fs");
  const path = await import("node:path");
  const sandboxDir = path.join(missionDir, "sandbox");
  fs.mkdirSync(sandboxDir, { recursive: true });
  logger.info("Created shared sandbox", { orchId, sandboxDir });

  // If baseProjectDir is provided, copy it to sandbox before orchestration starts
  if (orch.baseProjectDir) {
    logger.info("Copying base project to sandbox", {
      orchId,
      baseProjectDir: orch.baseProjectDir,
      sandboxDir,
    });
    try {
      const { copyWorkspace } = await import("./store.js");
      await copyWorkspace(orch.baseProjectDir, sandboxDir);
      logger.info("Base project copied to sandbox", { orchId });
    } catch (err) {
      logger.error("Failed to copy base project to sandbox", {
        orchId,
        error: String(err),
      });
      throw new Error(`Failed to copy base project: ${String(err)}`, { cause: err });
    }
  }

  // Broadcast orchestration started event
  await broadcastOrchestrationEvent({
    type: "orchestration.started",
    orchestrationId: orch.id,
    userPrompt: orch.userPrompt,
  });

  // Trigger orchestration:started hook
  const { triggerOrchestrationHook } = await import("./hooks.js");
  await triggerOrchestrationHook("orchestration:started", {
    orchestrationId: orch.id,
    orchestration: orch,
  });

  // Create shared memory for orchestrator + workers
  logger.info("Creating shared memory", { orchId });
  const memoryContext = await initOrchestrationMemory({
    orchId,
    sourceWorkspaceDir: opts.workspaceDir,
    agentId: opts.agentId,
  });
  const memoryEnv = getOrchestrationMemoryEnv(memoryContext.memoryDir);

  // Set memory env vars for orchestrator agent
  process.env.MEMORY_DIR = memoryEnv.MEMORY_DIR;
  process.env.VERSO_MEMORY_DIR = memoryEnv.VERSO_MEMORY_DIR;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let session: any = null;

  try {
    // Resolve model and auth
    const { resolveAgentModel } = await import("./model-resolver.js");
    const { model, authStorage, modelRegistry } = await resolveAgentModel();
    const { resolveOpenClawAgentDir } = await import("../agents/agent-paths.js");
    const agentDir = resolveOpenClawAgentDir();

    // Create orchestrate tool (pass sandboxDir instead of missionDir)
    logger.info("Creating orchestrate tool", { orchId });
    const orchestrateTool = createOrchestrateTool({
      agentSessionKey: opts.agentSessionKey,
      agentId: opts.agentId,
      workspaceDir: sandboxDir, // Use shared sandbox
      maxWorkers: opts.maxWorkers ?? ORCHESTRATION_DEFAULTS.maxWorkers,
      maxFixCycles: opts.maxFixCycles ?? ORCHESTRATION_DEFAULTS.maxFixCycles,
      maxOrchestrations: 1, // Single task per daemon
      verifyCmd: opts.verifyCmd ?? ORCHESTRATION_DEFAULTS.verifyCmd,
    });

    // Create web search and web fetch tools for orchestrator
    const { createWebSearchTool } = await import("../agents/tools/web-search.js");
    const { createWebFetchTool } = await import("../agents/tools/web-fetch.js");
    const { loadConfig } = await import("../config/config.js");
    const config = loadConfig();
    const webSearchTool = createWebSearchTool({ config, sandboxed: false });
    const webFetchTool = createWebFetchTool({ config, sandboxed: false });

    // Create Google Workspace tools for orchestrator (if enabled)
    // Only provide sheets, drive, docs, slides (minimal set for data analysis)
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

    // Create in-memory orchestrator agent session
    logger.info("Creating orchestrator agent session", { orchId });
    const { createAgentSession, SessionManager } = await import("@mariozechner/pi-coding-agent");

    // Use customTools parameter to add orchestrate + web_search + web_fetch + gworkspace tools
    const customToolsList = [
      orchestrateTool,
      ...(webSearchTool ? [webSearchTool] : []),
      ...(webFetchTool ? [webFetchTool] : []),
      ...gworkspaceTools,
    ];

    const created = await createAgentSession({
      cwd: sandboxDir, // Work in shared sandbox
      agentDir,
      authStorage,
      modelRegistry,
      model,
      customTools: customToolsList,
      sessionManager: SessionManager.inMemory(sandboxDir),
    });

    session = created.session;
    logger.info("Orchestrator agent session created", { orchId });

    // Verify tools are registered
    const sessionToolNames = session.getActiveToolNames();
    const missingTools = customToolsList
      .filter((t: { name: string }) => !sessionToolNames.includes(t.name))
      .map((t: { name: string }) => t.name);

    if (missingTools.length > 0) {
      logger.warn("Some tools not registered", { orchId, missingTools });
    }

    // Build orchestrator prompt
    const workspaceMode = orch.baseProjectDir
      ? `\n\nWORKSPACE MODE: ENHANCE EXISTING PROJECT
The workspace contains an existing project copied from: ${orch.baseProjectDir}
IMPORTANT: Before creating your plan, you MUST explore the existing codebase to understand its structure, patterns, and architecture. Use file reading tools to review key files. Then plan enhancements that build upon the existing code.`
      : `\n\nWORKSPACE MODE: BUILD FROM SCRATCH
The workspace is empty. You will build the project from scratch.`;

    const orchestratorMessage = `${buildOrchestratorSystemPrompt()}

ORCHESTRATION ID: ${orchId}
${workspaceMode}

TASK:
${orch.userPrompt}

CRITICAL INSTRUCTIONS:
You MUST use the orchestrate tool to complete this task. Do NOT provide a text response without calling the tool.

Your FIRST action must be to call the orchestrate tool with action "create-plan" to decompose the task into subtasks.
IMPORTANT: When calling create-plan, you MUST include the orchestrationId parameter: "${orchId}"

After creating the plan, follow this AUTOMATED workflow (do NOT wait for user input):
1. Call orchestrate with action "create-plan" and orchestrationId "${orchId}" (REQUIRED FIRST STEP)
2. Call orchestrate with action "dispatch" and orchestrationId "${orchId}" to run workers (BLOCKS until all workers complete)
3. After dispatch completes, check if there are still pending tasks. If yes, call "dispatch" again. Repeat until no pending tasks remain.
4. ONLY after all tasks are completed (no pending tasks), call orchestrate with action "run-acceptance" and orchestrationId "${orchId}" to verify results
5. If tests pass AND all tasks are completed, call orchestrate with action "complete" and orchestrationId "${orchId}"
6. If tests fail, call orchestrate with action "create-fix-tasks" and orchestrationId "${orchId}", then IMMEDIATELY call "dispatch" again (step 2), then repeat steps 3-6 until tests pass or max cycles reached

IMPORTANT:
- After calling "create-fix-tasks", you MUST immediately call "dispatch" again to run the fix workers. Do NOT stop after creating fix tasks.
- Do NOT call "run-acceptance" if there are still pending tasks. Call "dispatch" first to complete all pending tasks.
- Before calling "complete", ensure ALL tasks are done (no pending, no running).
- The "complete" action will reject if there are pending/running tasks remaining.
- If the orchestration is aborted (you receive a response with "aborted": true), acknowledge the abort and STOP immediately. Do not call any more tools.

Start now by calling orchestrate with action "create-plan" and orchestrationId "${orchId}".`;

    // Run orchestrator agent with abort monitoring
    logger.info("Running orchestrator agent", { orchId });

    // Set up periodic abort check
    let abortCheckInterval: NodeJS.Timeout | null = null;
    let shouldAbort = false;

    try {
      // Check for abort every 5 seconds
      abortCheckInterval = setInterval(async () => {
        const currentOrch = await loadOrchestration(orchId);
        if (currentOrch?.status === "failed" && currentOrch.error === "Aborted by user") {
          logger.info("Abort detected during execution", { orchId });
          shouldAbort = true;
          // Dispose session to stop agent execution
          if (session) {
            try {
              await session.dispose();
              logger.info("Session disposed due to abort", { orchId });
            } catch (disposeErr) {
              logger.warn("Error disposing session during abort", {
                orchId,
                error: String(disposeErr),
              });
            }
          }
        }
      }, 5000);

      await session.prompt(orchestratorMessage);
    } finally {
      // Clean up abort check interval
      if (abortCheckInterval) {
        clearInterval(abortCheckInterval);
      }
    }

    // Check if we were aborted
    if (shouldAbort) {
      logger.info("Orchestration was aborted by user", { orchId });
      return;
    }

    // After agent completes, check if orchestration was aborted
    const finalOrch = await loadOrchestration(orchId);
    if (finalOrch?.status === "failed" && finalOrch.error === "Aborted by user") {
      logger.info("Orchestration was aborted by user", { orchId });
      // Don't throw error - this is a clean abort, not a failure
      return;
    }

    const elapsed = Date.now() - t0;
    logger.info("Orchestration task completed", { orchId, elapsed_ms: elapsed });
  } catch (err) {
    const elapsed = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Orchestration task failed", { orchId, error: msg, elapsed_ms: elapsed });

    // Mark orchestration as failed
    const orch = await loadOrchestration(orchId);
    if (orch) {
      orch.status = "failed";
      orch.error = msg;
      orch.completedAtMs = Date.now();
      await saveOrchestration(orch);

      // Broadcast failure event
      await broadcastOrchestrationEvent({
        type: "orchestration.failed",
        orchestrationId: orch.id,
        error: msg,
      });
    }

    throw err;
  } finally {
    // Cleanup
    if (session) {
      try {
        session.dispose();
      } catch {
        // ignore
      }
    }

    // Close shared memory
    try {
      await cleanupOrchestrationMemory(memoryContext);
    } catch (err) {
      logger.warn("Failed to close shared memory", { orchId, error: String(err) });
    }

    // Cleanup mission workspace if failed
    const finalOrch = await loadOrchestration(orchId);
    if (finalOrch?.status === "failed") {
      try {
        await cleanupMissionWorkspace(opts.workspaceDir, orchId);
      } catch (err) {
        logger.warn("Failed to cleanup mission workspace", { orchId, error: String(err) });
      }
    }

    // Restore memory env vars
    delete process.env.MEMORY_DIR;
    delete process.env.VERSO_MEMORY_DIR;
  }
}

/**
 * Main daemon entry point.
 * Runs a single orchestration task and exits.
 */
export async function runOrchestratorDaemon(opts: OrchestratorDaemonOptions): Promise<void> {
  logger.info("Orchestrator daemon started", {
    orchestrationId: opts.orchestrationId,
    workspaceDir: opts.workspaceDir,
  });

  try {
    await runOrchestrationTask(opts);
    logger.info("Daemon exiting successfully", { orchestrationId: opts.orchestrationId });
    process.exit(0);
  } catch (err) {
    logger.error("Daemon exiting with error", {
      orchestrationId: opts.orchestrationId,
      error: String(err),
    });
    process.exit(1);
  }
}
