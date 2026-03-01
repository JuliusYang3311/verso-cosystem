// src/orchestration/daemon-runner.ts — Orchestrator daemon runner
//
// Runs orchestration tasks in a background daemon process (similar to evolver daemon).
// Each orchestration runs in an isolated mission workspace and doesn't occupy gateway sessions.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { broadcastOrchestrationEvent } from "./events.js";
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
  maxWorkers?: number;
  maxFixCycles?: number;
  maxOrchestrations?: number;
  verifyCmd?: string;
};

export type OrchestrationRequest = {
  id: string;
  userPrompt: string;
  requestedAtMs: number;
};

const QUEUE_FILENAME = "orchestrator-queue.json";

function resolveQueuePath(): string {
  const stateDir = resolveStateDir();
  return path.join(stateDir, QUEUE_FILENAME);
}

function loadQueue(): OrchestrationRequest[] {
  try {
    const queuePath = resolveQueuePath();
    if (!fs.existsSync(queuePath)) {
      return [];
    }
    const raw = fs.readFileSync(queuePath, "utf-8");
    if (!raw.trim()) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      logger.warn("Queue file is not an array, resetting", { queuePath });
      return [];
    }
    return parsed as OrchestrationRequest[];
  } catch (err) {
    logger.error("Failed to load queue, resetting", { error: String(err) });
    return [];
  }
}

function saveQueue(queue: OrchestrationRequest[]): void {
  try {
    const queuePath = resolveQueuePath();
    const queueDir = path.dirname(queuePath);
    if (!fs.existsSync(queueDir)) {
      fs.mkdirSync(queueDir, { recursive: true });
    }
    const tempPath = `${queuePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(queue, null, 2), "utf-8");
    fs.renameSync(tempPath, queuePath);
  } catch (err) {
    logger.error("Failed to save queue", { error: String(err) });
    throw err;
  }
}

/**
 * Enqueue an orchestration request.
 * The daemon will pick it up and execute it in the background.
 */
export function enqueueOrchestration(userPrompt: string): string {
  if (!userPrompt || userPrompt.trim().length === 0) {
    throw new Error("User prompt cannot be empty");
  }

  const orchId = crypto.randomUUID().slice(0, 8);
  const queue = loadQueue();

  // Check for duplicate requests (same prompt within last 5 minutes)
  const recentDuplicate = queue.find(
    (req) => req.userPrompt === userPrompt && Date.now() - req.requestedAtMs < 5 * 60 * 1000,
  );

  if (recentDuplicate) {
    logger.warn("Duplicate orchestration request detected", {
      orchId: recentDuplicate.id,
      userPrompt: userPrompt.slice(0, 100),
    });
    return recentDuplicate.id;
  }

  queue.push({
    id: orchId,
    userPrompt,
    requestedAtMs: Date.now(),
  });
  saveQueue(queue);
  logger.info("Enqueued orchestration", { orchId, userPrompt: userPrompt.slice(0, 100) });
  return orchId;
}

/**
 * Run a single orchestration task.
 * This is called by the daemon for each queued request.
 *
 * Architecture: Daemon runs an Orchestrator agent that uses the orchestrate tool.
 * The Orchestrator agent decomposes tasks, dispatches workers, and runs acceptance tests.
 * Workers execute subtasks in the shared mission workspace with shared memory.
 */
async function runOrchestrationTask(
  request: OrchestrationRequest,
  opts: OrchestratorDaemonOptions,
): Promise<void> {
  const orchId = request.id;
  logger.info("Starting orchestration", { orchId });

  let memoryContext: import("./orchestrator-memory.js").OrchestrationMemoryContext | null = null;
  let agentDir: string | null = null;
  let missionDir: string | null = null;

  try {
    // 1. Initialize mission workspace (empty directory)
    missionDir = await initMissionWorkspace(opts.workspaceDir, orchId);

    // 2. Create initial orchestration record (so we have state even if agent fails early)
    const { createOrchestration } = await import("./types.js");
    const initialOrch = createOrchestration({
      id: orchId,
      userPrompt: request.userPrompt,
      orchestratorSessionKey: opts.agentSessionKey,
      agentId: opts.agentId,
      workspaceDir: missionDir,
      sourceWorkspaceDir: opts.workspaceDir,
      maxFixCycles: opts.maxFixCycles ?? ORCHESTRATION_DEFAULTS.maxFixCycles,
    });
    await saveOrchestration(initialOrch);
    logger.info("Created initial orchestration record", { orchId });

    // 3. Initialize shared memory for orchestrator + workers
    const { initOrchestrationMemory } = await import("./orchestrator-memory.js");
    memoryContext = await initOrchestrationMemory({
      orchId,
      sourceWorkspaceDir: opts.workspaceDir,
      agentId: opts.agentId,
    });

    // 4. Broadcast start event
    await broadcastOrchestrationEvent({
      type: "orchestration.started",
      orchestrationId: orchId,
      userPrompt: request.userPrompt,
    });

    // 5. Run Orchestrator agent
    // The orchestrator agent will use the orchestrate tool to:
    // - create-plan (task decomposition)
    // - dispatch (spawn workers)
    // - run-acceptance (verify results)
    // - create-fix-tasks + dispatch (if needed)
    // - complete (copy to output)

    logger.info("Initializing orchestrator agent", { orchId });

    const { buildOrchestratorSystemPrompt } = await import("./orchestrator-prompt.js");
    const { createOrchestrateTool } = await import("./orchestrator-tools.js");
    const { resolveAgentModel } = await import("./model-resolver.js");
    const { resolveOpenClawAgentDir } = await import("../agents/agent-paths.js");

    logger.info("Resolving agent model", { orchId });
    const { model, authStorage, modelRegistry } = await resolveAgentModel();
    const agentDir = resolveOpenClawAgentDir();
    logger.info("Agent model resolved", { orchId, modelId: model.id, agentDir });

    // Create orchestrate tool
    logger.info("Creating orchestrate tool", { orchId });
    const orchestrateTool = createOrchestrateTool({
      agentSessionKey: opts.agentSessionKey,
      agentId: opts.agentId,
      workspaceDir: missionDir,
      maxWorkers: opts.maxWorkers ?? ORCHESTRATION_DEFAULTS.maxWorkers,
      maxFixCycles: opts.maxFixCycles ?? ORCHESTRATION_DEFAULTS.maxFixCycles,
      maxOrchestrations: opts.maxOrchestrations ?? ORCHESTRATION_DEFAULTS.maxOrchestrations,
      verifyCmd: opts.verifyCmd ?? ORCHESTRATION_DEFAULTS.verifyCmd,
    });

    // Create web search tool for orchestrator
    logger.info("Creating web search tool", { orchId });
    const { createWebSearchTool } = await import("../agents/tools/web-search.js");
    const { loadConfig } = await import("../config/config.js");
    const config = loadConfig();
    const webSearchTool = createWebSearchTool({ config, sandboxed: false });
    logger.info("Web search tool created", { orchId, hasWebSearch: !!webSearchTool });

    // Create in-memory orchestrator agent session
    logger.info("Creating orchestrator agent session", { orchId });
    const { createAgentSession, codingTools, SessionManager } =
      await import("@mariozechner/pi-coding-agent");

    const orchestratorTools = [
      orchestrateTool,
      ...codingTools,
      ...(webSearchTool ? [webSearchTool] : []),
    ];

    logger.info("Creating agent session with tools", {
      orchId,
      toolCount: orchestratorTools.length,
      toolNames: orchestratorTools.map((t) => t.name),
    });

    const created = await createAgentSession({
      cwd: missionDir,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      tools: orchestratorTools, // Provide orchestrate tool + coding tools + web search
      sessionManager: SessionManager.inMemory(missionDir),
    });

    const session = created.session;
    logger.info("Orchestrator agent session created", { orchId });

    // Verify tools are actually available in the session
    const sessionTools = (session as any).tools || [];
    logger.info("Session tools verification", {
      orchId,
      sessionToolCount: sessionTools.length,
      sessionToolNames: sessionTools.map((t: any) => t.name || "unnamed"),
      hasOrchestrateToolInSession: sessionTools.some((t: any) => t.name === "orchestrate"),
    });

    const orchestratorMessage = `${buildOrchestratorSystemPrompt()}

TASK:
${request.userPrompt}

CRITICAL INSTRUCTIONS:
You MUST use the orchestrate tool to complete this task. Do NOT provide a text response without calling the tool.

Your FIRST action must be to call the orchestrate tool with action "create-plan" to decompose the task into subtasks.

After creating the plan, follow this workflow:
1. Call orchestrate with action "create-plan" (REQUIRED FIRST STEP)
2. Call orchestrate with action "dispatch" to run workers
3. Call orchestrate with action "run-acceptance" to verify results
4. If tests pass, call orchestrate with action "complete"
5. If tests fail, call orchestrate with action "create-fix-tasks" and repeat steps 2-4

Start now by calling orchestrate with action "create-plan".`;

    let result = "";
    try {
      logger.info("Starting orchestrator agent prompt execution", { orchId });

      // Dynamic context loading (copied from main agent's attempt.ts)
      const { buildDynamicContext, loadContextParams } =
        await import("../agents/dynamic-context.js");

      // Extract search query from user prompt
      const searchQuery = request.userPrompt.slice(0, 500);

      // Retrieve chunks from shared memory manager (graceful fallback to empty on error)
      let retrievedChunks: Parameters<typeof buildDynamicContext>[0]["retrievedChunks"] = [];
      if (searchQuery && memoryContext?.memoryManager) {
        try {
          const searchResults = await memoryContext.memoryManager.search(searchQuery, {
            maxResults: 20,
            sessionKey: `agent:${opts.agentId}:orch:${orchId}`,
          });
          retrievedChunks = searchResults.map(
            (r: {
              snippet: string;
              score: number;
              path: string;
              source: string;
              startLine: number;
              endLine: number;
              timestamp?: number;
              l0Abstract?: string;
              l1Overview?: string;
            }) => ({
              snippet: r.snippet,
              score: r.score,
              path: r.path,
              source: r.source,
              startLine: r.startLine,
              endLine: r.endLine,
              timestamp: r.timestamp,
              l0Abstract: r.l0Abstract,
              l1Overview: r.l1Overview,
            }),
          );
        } catch (retrievalErr) {
          logger.debug("Memory retrieval failed (non-fatal)", { error: String(retrievalErr) });
        }
      }

      // Load tunable context params (evolver-managed via context_params.json)
      const contextParams = await loadContextParams();

      // Estimate token counts (rough estimate: ~4 chars per token)
      const systemPromptTokens = Math.ceil(orchestratorMessage.length / 4);
      const contextLimit = model.contextWindow ?? 200000;
      const reserveForReply = 8000;

      // Get all messages from session (empty for first prompt)
      const allMessages = session.messages ?? [];

      // Apply dynamic context
      const dynamicResult = buildDynamicContext({
        allMessages,
        retrievedChunks,
        contextLimit,
        systemPromptTokens,
        reserveForReply,
        compactionSummary: null,
        params: contextParams,
      });

      logger.info("Dynamic context allocated", {
        orchId,
        recentTokens: dynamicResult.recentTokens,
        retrievalTokens: dynamicResult.retrievalTokens,
        totalTokens: dynamicResult.totalTokens,
        recentRatioUsed: dynamicResult.recentRatioUsed.toFixed(2),
        thresholdUsed: dynamicResult.thresholdUsed.toFixed(2),
      });

      logger.info("Sending prompt to orchestrator agent", {
        orchId,
        promptLength: orchestratorMessage.length,
      });

      await session.prompt(orchestratorMessage);
      result = session.getLastAssistantText?.() ?? "";

      // Log detailed agent response information
      const messages = session.messages ?? [];
      const lastMessage = messages[messages.length - 1];

      logger.info("Orchestrator agent response details", {
        orchId,
        resultLength: result.length,
        resultPreview: result.slice(0, 500),
        messageCount: messages.length,
        lastMessageRole: lastMessage?.role,
        hasToolCalls: !!(
          lastMessage &&
          "content" in lastMessage &&
          Array.isArray(lastMessage.content) &&
          lastMessage.content.some(
            (c: unknown) =>
              typeof c === "object" &&
              c !== null &&
              "type" in c &&
              (c as { type: string }).type === "tool_use",
          )
        ),
      });

      // If there are tool calls, log them
      if (lastMessage && "content" in lastMessage && Array.isArray(lastMessage.content)) {
        const toolCalls = lastMessage.content.filter(
          (c: unknown) =>
            typeof c === "object" &&
            c !== null &&
            "type" in c &&
            (c as { type: string }).type === "tool_use",
        );
        if (toolCalls.length > 0) {
          logger.info("Agent made tool calls", {
            orchId,
            toolCallCount: toolCalls.length,
            toolNames: toolCalls.map((tc: unknown) => (tc as { name: string }).name),
          });
        } else {
          logger.warn("Agent completed without making any tool calls", {
            orchId,
            contentTypes: lastMessage.content.map((c: unknown) =>
              typeof c === "object" && c !== null && "type" in c
                ? (c as { type: string }).type
                : "unknown",
            ),
          });
        }
      }

      logger.info("Orchestrator agent completed successfully", {
        orchId,
        resultLength: result.length,
        resultPreview: result.slice(0, 200),
      });
    } catch (promptErr) {
      logger.error("Orchestrator agent prompt execution failed", {
        orchId,
        error: promptErr instanceof Error ? promptErr.message : String(promptErr),
        stack: promptErr instanceof Error ? promptErr.stack : undefined,
      });
      throw promptErr; // Re-throw to be caught by outer catch block
    } finally {
      logger.info("Disposing orchestrator agent session", { orchId });
      session.dispose();
    }

    // 6. Load final orchestration state
    const orch = await loadOrchestration(orchId);

    if (!orch) {
      throw new Error("Orchestration state not found after execution");
    }

    // 7. Broadcast completion or failure event
    if (orch.status === "completed") {
      const outputPath = `./.verso-output/${orchId}`;
      await broadcastOrchestrationEvent({
        type: "orchestration.completed",
        orchestrationId: orchId,
        outputPath,
        summary: result ?? "Orchestration completed",
      });
    } else if (orch.status === "failed") {
      await broadcastOrchestrationEvent({
        type: "orchestration.failed",
        orchestrationId: orchId,
        error: orch.error ?? "Orchestration failed",
      });
    } else {
      // Orchestration ended in unexpected state
      logger.warn("Orchestration ended in unexpected state", {
        orchId,
        status: orch.status,
      });
      orch.status = "failed";
      orch.error = `Orchestration ended in unexpected state: ${orch.status}`;
      await saveOrchestration(orch);
      await broadcastOrchestrationEvent({
        type: "orchestration.failed",
        orchestrationId: orchId,
        error: orch.error,
      });
    }
  } catch (err) {
    // Capture detailed error information
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;

    logger.error("Orchestration failed with exception", {
      orchId,
      error: errorMessage,
      stack: errorStack,
    });

    // Ensure orchestration is marked as failed
    try {
      const orch = await loadOrchestration(orchId);
      if (orch) {
        orch.status = "failed";
        orch.error = errorStack || errorMessage; // Save full stack trace
        orch.completedAtMs = Date.now();
        await saveOrchestration(orch);
        logger.info("Saved failed orchestration state", { orchId });
      } else {
        logger.error("Cannot save failed state: orchestration not found", { orchId });
      }
    } catch (saveErr) {
      logger.error("Failed to save error state", { orchId, error: String(saveErr) });
    }

    // Broadcast failure event
    try {
      await broadcastOrchestrationEvent({
        type: "orchestration.failed",
        orchestrationId: orchId,
        error: errorMessage, // Use concise message for notification
      });
      logger.info("Broadcasted failure event", { orchId });
    } catch (broadcastErr) {
      logger.error("Failed to broadcast failure event", {
        orchId,
        error: String(broadcastErr),
      });
    }

    // Return early to avoid duplicate processing in the status check below
    return;
  } finally {
    // 8. Cleanup resources
    try {
      if (memoryContext) {
        const { cleanupOrchestrationMemory } = await import("./orchestrator-memory.js");
        await cleanupOrchestrationMemory(memoryContext);
        logger.info("Cleaned up orchestration memory", { orchId });
      }
    } catch (cleanupErr) {
      logger.error("Failed to cleanup memory", { orchId, error: String(cleanupErr) });
    }

    // Cleanup agent session directory
    try {
      if (agentDir) {
        const agentSessionDir = path.join(agentDir, `orch-${orchId}-${opts.agentId}`);
        if (fs.existsSync(agentSessionDir)) {
          fs.rmSync(agentSessionDir, { recursive: true, force: true });
          logger.info("Cleaned up agent session directory", { orchId, agentSessionDir });
        }
      }
    } catch (cleanupErr) {
      logger.error("Failed to cleanup agent session directory", {
        orchId,
        error: String(cleanupErr),
      });
    }

    // Cleanup mission workspace if orchestration failed
    try {
      const orch = await loadOrchestration(orchId);
      if (orch && orch.status === "failed") {
        await cleanupMissionWorkspace(opts.workspaceDir, orchId);
        logger.info("Cleaned up failed orchestration workspace", { orchId });
      }
    } catch (cleanupErr) {
      logger.error("Failed to cleanup workspace", { orchId, error: String(cleanupErr) });
    }
  }
}

/**
 * Main daemon loop.
 * Continuously processes queued orchestration requests.
 * Exits automatically after idle timeout when queue is empty.
 */
export async function runOrchestratorDaemon(opts: OrchestratorDaemonOptions): Promise<void> {
  logger.info("Orchestrator daemon started", { workspaceDir: opts.workspaceDir });

  const maxConcurrent = opts.maxOrchestrations ?? ORCHESTRATION_DEFAULTS.maxOrchestrations;
  const runningTasks = new Set<Promise<void>>();
  const IDLE_TIMEOUT_MS = 60000; // Exit after 60 seconds of inactivity
  let lastActivityMs = Date.now();

  while (true) {
    try {
      // Wait for running tasks to complete if at max capacity
      if (runningTasks.size >= maxConcurrent) {
        await Promise.race(runningTasks);
        continue;
      }

      const queue = loadQueue();

      if (queue.length === 0) {
        // No pending requests
        if (runningTasks.size === 0) {
          // No running tasks either, check idle timeout
          const idleMs = Date.now() - lastActivityMs;
          if (idleMs >= IDLE_TIMEOUT_MS) {
            logger.info("Daemon idle timeout reached, exiting gracefully", {
              idleMs,
              timeoutMs: IDLE_TIMEOUT_MS,
            });
            process.exit(0);
          }
          // Sleep for a bit before checking again
          await new Promise((resolve) => setTimeout(resolve, 5000));
        } else {
          // Wait for any running task to complete
          await Promise.race(runningTasks);
        }
        continue;
      }

      // Process the first request
      lastActivityMs = Date.now(); // Reset idle timer
      const request = queue.shift()!;
      saveQueue(queue);

      // Run task in background
      const taskPromise = runOrchestrationTask(request, opts)
        .catch((err) => {
          logger.error("Task execution failed", {
            orchId: request.id,
            error: String(err),
          });
        })
        .finally(() => {
          runningTasks.delete(taskPromise);
        });

      runningTasks.add(taskPromise);
    } catch (err) {
      logger.error("Daemon loop error", { error: String(err) });
      // Sleep before retrying
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }
}
