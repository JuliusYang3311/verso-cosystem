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
  const missionDir = await initMissionWorkspace(orchId, opts.workspaceDir);
  orch.workspaceDir = missionDir;
  await saveOrchestration(orch);

  // Broadcast orchestration started event
  await broadcastOrchestrationEvent({
    type: "orchestration.started",
    orchestrationId: orch.id,
    userPrompt: orch.userPrompt,
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

    // Create orchestrate tool
    logger.info("Creating orchestrate tool", { orchId });
    const orchestrateTool = createOrchestrateTool({
      agentSessionKey: opts.agentSessionKey,
      agentId: opts.agentId,
      workspaceDir: missionDir,
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
      cwd: missionDir,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      customTools: customToolsList,
      sessionManager: SessionManager.inMemory(missionDir),
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
    const orchestratorMessage = `${buildOrchestratorSystemPrompt()}

ORCHESTRATION ID: ${orchId}

TASK:
${orch.userPrompt}

CRITICAL INSTRUCTIONS:
You MUST use the orchestrate tool to complete this task. Do NOT provide a text response without calling the tool.

Your FIRST action must be to call the orchestrate tool with action "create-plan" to decompose the task into subtasks.
IMPORTANT: When calling create-plan, you MUST include the orchestrationId parameter: "${orchId}"

After creating the plan, follow this AUTOMATED workflow (do NOT wait for user input):
1. Call orchestrate with action "create-plan" and orchestrationId "${orchId}" (REQUIRED FIRST STEP)
2. Call orchestrate with action "dispatch" and orchestrationId "${orchId}" to run workers (BLOCKS until all workers complete)
3. Call orchestrate with action "run-acceptance" and orchestrationId "${orchId}" to verify results
4. If tests pass, call orchestrate with action "complete" and orchestrationId "${orchId}"
5. If tests fail, call orchestrate with action "create-fix-tasks" and orchestrationId "${orchId}", then IMMEDIATELY call "dispatch" again (step 2), then "run-acceptance" again (step 3), then repeat until tests pass or max cycles reached

IMPORTANT: After calling "create-fix-tasks", you MUST immediately call "dispatch" again to run the fix workers. Do NOT stop after creating fix tasks.

Start now by calling orchestrate with action "create-plan" and orchestrationId "${orchId}".`;

    // Run orchestrator agent
    logger.info("Running orchestrator agent", { orchId });
    await session.prompt(orchestratorMessage);

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
