// src/orchestration/daemon-runner.ts — Orchestrator daemon runner (single-task per daemon)
//
// Each daemon runs exactly one orchestration task.
// Multiple daemons can run concurrently (controlled by maxOrchestrations).

import type { VersoConfig } from "../config/types.js";
import { broadcastOrchestrationEvent } from "./events.js";
import { initOrchestrationMemory, cleanupOrchestrationMemory } from "./orchestrator-memory.js";
import { buildOrchestratorSystemPrompt } from "./orchestrator-prompt.js";
import { createOrchestrateTool } from "./orchestrator-tools.js";
import {
  loadOrchestration,
  saveOrchestration,
  initMissionWorkspace,
  cleanupMissionWorkspace,
} from "./store.js";
import { ORCHESTRATION_DEFAULTS } from "./types.js";

const logger = {
  info: (...args: unknown[]) => console.log("[orchestrator-daemon]", ...args),
  warn: (...args: unknown[]) => console.warn("[orchestrator-daemon]", ...args),
  error: (...args: unknown[]) => console.error("[orchestrator-daemon]", ...args),
};

export type OrchestratorDaemonOptions = {
  workspaceDir: string;
  agentId: string;
  agentSessionKey: string;
  orchestrationId: string;
  maxFixCycles?: number;
  verifyCmd?: string;
  config?: VersoConfig;
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
  let orch = await loadOrchestration(orchId);
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
  await broadcastOrchestrationEvent(
    {
      type: "orchestration.started",
      orchestrationId: orch.id,
      userPrompt: orch.userPrompt,
    },
    opts.config,
  );

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
  const memoryManager = memoryContext.memoryManager;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let session: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let acceptanceSession: any = null;
  let pool: import("./worker-pool.js").WorkerPool | null = null;

  try {
    // Resolve model and auth
    const { resolveAgentModel } = await import("./model-resolver.js");
    const { model, authStorage, modelRegistry } = await resolveAgentModel();
    const { resolveOpenClawAgentDir } = await import("../agents/agent-paths.js");
    const agentDir = resolveOpenClawAgentDir();

    // Load config for gateway communication
    const { loadConfig } = await import("../config/config.js");
    const config = loadConfig();

    // --- Build shared tools (used by ALL agents: orchestrator, workers, acceptance) ---

    const { createWebSearchTool } = await import("../agents/tools/web-search.js");
    const { createWebFetchTool } = await import("../agents/tools/web-fetch.js");
    const webSearchTool = createWebSearchTool({ config, sandboxed: false });
    const webFetchTool = createWebFetchTool({ config, sandboxed: false });

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

    const memoryTools = [];
    if (memoryManager) {
      const { createMemorySearchTool, createMemoryGetTool } =
        await import("../agents/tools/memory-tool.js");
      const searchTool = createMemorySearchTool({ config, memoryManager });
      const getTool = createMemoryGetTool({ config, memoryManager });
      if (searchTool) memoryTools.push(searchTool);
      if (getTool) memoryTools.push(getTool);
    }

    const sharedTools = [
      ...(webSearchTool ? [webSearchTool] : []),
      ...(webFetchTool ? [webFetchTool] : []),
      ...gworkspaceTools,
      ...memoryTools,
    ];

    // --- Create all persistent sessions ---

    const { createVersoSession } = await import("../agents/session-factory.js");
    const { WorkerPool } = await import("./worker-pool.js");

    // 1. Worker pool — fixed specialization distribution, all get shared tools
    logger.info("Creating persistent worker pool", { orchId });
    pool = await WorkerPool.create({
      // Uses DEFAULT_WORKER_DISTRIBUTION: explorer×2, architect×2, implementer×4, reviewer×2, researcher×2, generic×2
      cwd: sandboxDir,
      agentDir,
      model,
      authStorage,
      modelRegistry,
      config: opts.config,
      memoryManager: memoryManager ?? null,
      customTools: sharedTools,
    });
    logger.info("Worker pool created", { orchId, poolSize: pool.size });

    // 2. Acceptance session (persistent across fix cycles)
    logger.info("Creating persistent acceptance session", { orchId });
    const acceptanceCreated = await createVersoSession({
      cwd: sandboxDir,
      agentDir,
      model,
      authStorage,
      modelRegistry,
      customTools: sharedTools,
      config: opts.config,
      provider: model.provider,
      modelId: model.id,
      memoryManager: memoryManager ?? null,
    });
    acceptanceSession = acceptanceCreated.session;
    const acceptanceSessionManager = acceptanceCreated.sessionManager;
    logger.info("Acceptance session created", { orchId });

    // 3. Orchestrate tool (holds references to pool + acceptance session)
    const orchestrateTool = createOrchestrateTool({
      agentSessionKey: opts.agentSessionKey,
      agentId: opts.agentId,
      workspaceDir: sandboxDir,
      pool,
      acceptanceSession,
      acceptanceSessionManager,
      maxFixCycles: opts.maxFixCycles ?? ORCHESTRATION_DEFAULTS.maxFixCycles,
      maxOrchestrations: 1,
      verifyCmd: opts.verifyCmd ?? ORCHESTRATION_DEFAULTS.verifyCmd,
      config: opts.config,
      memoryManager: memoryManager ?? undefined,
    });

    // 4. Orchestrator session (gets orchestrate tool + shared tools)
    //    orchestrate is the ONLY tool exclusive to the orchestrator
    const customToolsList = [orchestrateTool, ...sharedTools];

    // Debug: Log all parameters before creating session
    logger.info("Creating agent session with parameters", {
      orchId,
      sessionKey: opts.agentSessionKey,
      cwd: sandboxDir,
      agentDir,
      hasAuthStorage: !!authStorage,
      hasModelRegistry: !!modelRegistry,
      hasModel: !!model,
      modelProvider: model?.provider,
      modelId: model?.id,
      customToolsCount: customToolsList.length,
    });

    // Create orchestrator session via unified factory (3-layer context pipeline)
    let created: Awaited<ReturnType<typeof createVersoSession>>;
    try {
      created = await createVersoSession({
        cwd: sandboxDir,
        agentDir,
        model,
        authStorage,
        modelRegistry,
        customTools: customToolsList,
        config: opts.config,
        provider: model.provider,
        modelId: model.id,
        memoryManager: memoryManager ?? null,
      });
    } catch (err) {
      logger.error("Failed to create agent session", {
        orchId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        cwd: sandboxDir,
        agentDir,
        modelProvider: model?.provider,
        modelId: model?.id,
      });
      throw err;
    }

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

    // Build orchestrator prompt: system identity + task message
    const { buildOrchestratorTaskMessage } = await import("./orchestrator-prompt.js");
    const orchestratorMessage = `${buildOrchestratorSystemPrompt()}

${buildOrchestratorTaskMessage({
  orchestrationId: orchId,
  userPrompt: orch.userPrompt,
  baseProjectDir: orch.baseProjectDir,
})}`;

    // Run orchestrator agent with abort monitoring and timeout
    logger.info("Running orchestrator agent", { orchId });

    // Activity-based timeout for orchestrator agent (same pattern as workers)
    const ORCHESTRATOR_TIMEOUT_MS = 600_000; // 10 minutes of inactivity
    let lastActivityMs = Date.now();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    // Tool call loop detection: track recent tool calls to detect infinite loops
    const toolCallHistory: Array<{ name: string; timestamp: number }> = [];
    const LOOP_DETECTION_WINDOW = 10; // Check last 10 tool calls
    const LOOP_DETECTION_THRESHOLD = 8; // If 8 out of 10 are the same tool, it's a loop

    const checkTimeout = () => {
      const idleMs = Date.now() - lastActivityMs;
      if (idleMs >= ORCHESTRATOR_TIMEOUT_MS) {
        return true; // Timed out
      }
      // Schedule next check
      timeoutHandle = setTimeout(checkTimeout, Math.min(30_000, ORCHESTRATOR_TIMEOUT_MS - idleMs));
      return false;
    };

    // Start timeout checker
    timeoutHandle = setTimeout(checkTimeout, ORCHESTRATOR_TIMEOUT_MS);

    // Monitor session activity
    const originalOnToolUse = session.onToolUse;
    if (originalOnToolUse) {
      session.onToolUse = (...args: unknown[]) => {
        lastActivityMs = Date.now(); // Reset activity timer

        // Track tool call for loop detection
        const toolName = typeof args[0] === "string" ? args[0] : "unknown";
        toolCallHistory.push({ name: toolName, timestamp: Date.now() });

        // Keep only recent history
        if (toolCallHistory.length > LOOP_DETECTION_WINDOW) {
          toolCallHistory.shift();
        }

        // Check for loop: if most recent calls are the same tool
        if (toolCallHistory.length >= LOOP_DETECTION_WINDOW) {
          const recentTools = toolCallHistory.slice(-LOOP_DETECTION_WINDOW);
          const toolCounts = new Map<string, number>();
          for (const call of recentTools) {
            toolCounts.set(call.name, (toolCounts.get(call.name) || 0) + 1);
          }

          // Find most frequent tool
          let maxCount = 0;
          let maxTool = "";
          for (const [tool, count] of toolCounts) {
            if (count > maxCount) {
              maxCount = count;
              maxTool = tool;
            }
          }

          // If one tool dominates recent calls, likely a loop
          if (maxCount >= LOOP_DETECTION_THRESHOLD) {
            logger.warn("Detected potential tool call loop in orchestrator", {
              orchId,
              tool: maxTool,
              count: maxCount,
              window: LOOP_DETECTION_WINDOW,
            });
            // Don't abort immediately - just log warning
            // The timeout will eventually catch it if it's truly stuck
          }
        }

        return originalOnToolUse.apply(session, args);
      };
    }

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

          // Clear interval first
          if (abortCheckInterval) {
            clearInterval(abortCheckInterval);
            abortCheckInterval = null;
          }

          // Abort session to interrupt the running prompt
          if (session) {
            try {
              await session.abort();
              logger.info("Session aborted due to user abort", { orchId });
            } catch (disposeErr) {
              logger.warn("Error aborting session during abort", {
                orchId,
                error: String(disposeErr),
              });
            }
          }

          // Broadcast abort event
          try {
            await broadcastOrchestrationEvent(
              {
                type: "orchestration.failed",
                orchestrationId: orchId,
                error: "Aborted by user",
              },
              opts.config,
            );
          } catch (broadcastErr) {
            logger.warn("Failed to broadcast abort event", {
              orchId,
              error: String(broadcastErr),
            });
          }

          // Cleanup resources before exit
          try {
            if (session) {
              session.dispose();
            }
            if (orch) {
              await cleanupOrchestrationMemory(memoryContext);
            }
          } catch (cleanupErr) {
            logger.warn("Error during abort cleanup", {
              orchId,
              error: String(cleanupErr),
            });
          }

          // Exit the daemon process immediately
          logger.info("Daemon exiting due to abort", { orchId });
          process.exit(0);
        }
      }, 5000);

      await session.prompt(orchestratorMessage);

      // Prompt completed successfully - clear timeout immediately
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }

      // Debug: Check if agent actually did anything
      const messages = session.messages;
      const toolCalls = messages.filter((msg: any) => msg.role === "assistant" && msg.toolUse);

      // Post-turn attribution: record utilization of injected memory chunks
      if (memoryManager && created.sessionManager) {
        try {
          const { performPostTurnAttribution } = await import("../memory/post-turn-attribution.js");
          const { extractToolMetas } = await import("./worker-runner.js");
          const lastText = session.getLastAssistantText?.() ?? "";
          await performPostTurnAttribution({
            sessionManager: created.sessionManager,
            memoryManager,
            assistantOutput: lastText,
            toolMetas: extractToolMetas(session),
            sessionId: `orch:${orchId}`,
          });
        } catch {
          // Utilization tracking is non-critical
        }
      }

      // Index orchestrator's summary into shared memory
      if (memoryManager) {
        const lastText = session.getLastAssistantText?.() ?? "";
        if (lastText) {
          const { indexAgentResult } = await import("./orchestrator-memory.js");
          await indexAgentResult({
            memoryManager,
            agentType: "orchestrator",
            agentId: orchId,
            title: "Orchestrator Summary",
            content: lastText,
          });
        }
      }
      logger.info("Orchestrator agent completed successfully", {
        orchId,
        messagesCount: messages.length,
        toolCallCount: toolCalls.length,
      });
    } catch (err) {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      throw err;
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
      await broadcastOrchestrationEvent(
        {
          type: "orchestration.failed",
          orchestrationId: orch.id,
          error: msg,
        },
        opts.config,
      );
    }

    throw err;
  } finally {
    // Cleanup - dispose session first to stop new writes
    if (session) {
      try {
        session.dispose();
      } catch {
        // ignore
      }
    }

    // Dispose acceptance session (best-effort)
    if (acceptanceSession) {
      try {
        acceptanceSession.dispose();
      } catch {
        // ignore
      }
    }

    // Destroy worker pool (best-effort)
    if (pool) {
      try {
        await pool.destroy();
      } catch {
        // ignore
      }
    }

    // Wait a moment for any in-flight writes to complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Close shared memory and cleanup sessions directory
    try {
      // Reload orch in case it's undefined
      if (!orch) {
        orch = await loadOrchestration(orchId);
      }
      if (orch) {
        await cleanupOrchestrationMemory(memoryContext);
      }
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
