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

  try {
    // 1. Initialize mission workspace (empty directory)
    const missionDir = await initMissionWorkspace(opts.workspaceDir, orchId);

    // 2. Initialize shared memory for orchestrator + workers
    const { initOrchestrationMemory } = await import("./orchestrator-memory.js");
    memoryContext = await initOrchestrationMemory({
      orchId,
      sourceWorkspaceDir: opts.workspaceDir,
      agentId: opts.agentId,
    });

    // 3. Broadcast start event
    await broadcastOrchestrationEvent({
      type: "orchestration.started",
      orchestrationId: orchId,
      userPrompt: request.userPrompt,
    });

    // 4. Run Orchestrator agent
    // The orchestrator agent will use the orchestrate tool to:
    // - create-plan (task decomposition)
    // - dispatch (spawn workers)
    // - run-acceptance (verify results)
    // - create-fix-tasks + dispatch (if needed)
    // - complete (copy to output)

    const { buildOrchestratorSystemPrompt } = await import("./orchestrator-prompt.js");
    const { createOrchestrateTool } = await import("./orchestrator-tools.js");
    const { resolveAgentModel } = await import("./model-resolver.js");
    const { resolveOpenClawAgentDir } = await import("../agents/agent-paths.js");

    const { model, authStorage, modelRegistry } = await resolveAgentModel();
    const agentDir = resolveOpenClawAgentDir();

    // Create orchestrate tool
    const orchestrateTool = createOrchestrateTool({
      agentSessionKey: opts.agentSessionKey,
      agentId: opts.agentId,
      workspaceDir: missionDir,
      maxWorkers: opts.maxWorkers ?? ORCHESTRATION_DEFAULTS.maxWorkers,
      maxFixCycles: opts.maxFixCycles ?? ORCHESTRATION_DEFAULTS.maxFixCycles,
      maxOrchestrations: opts.maxOrchestrations ?? ORCHESTRATION_DEFAULTS.maxOrchestrations,
      verifyCmd: opts.verifyCmd ?? ORCHESTRATION_DEFAULTS.verifyCmd,
    });

    // Create in-memory orchestrator agent session
    const { createAgentSession, codingTools, SessionManager } =
      await import("@mariozechner/pi-coding-agent");

    const created = await createAgentSession({
      cwd: missionDir,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      tools: [orchestrateTool, ...codingTools], // Provide orchestrate tool + coding tools
      sessionManager: SessionManager.inMemory(missionDir),
    });

    const session = created.session;

    const orchestratorMessage = `${buildOrchestratorSystemPrompt()}

Execute this orchestration task:

${request.userPrompt}

Follow the orchestration workflow:
1. Call orchestrate with action "create-plan" to decompose the task
2. Call orchestrate with action "dispatch" to run workers
3. Call orchestrate with action "run-acceptance" to verify results
4. If tests pass, call orchestrate with action "complete"
5. If tests fail, call orchestrate with action "create-fix-tasks" and repeat

Execute the entire workflow automatically.`;

    let result = "";
    try {
      await session.prompt(orchestratorMessage);
      result = session.getLastAssistantText?.() ?? "";
      logger.info("Orchestrator agent completed", { orchId, result: result.slice(0, 200) });
    } finally {
      session.dispose();
    }

    // 5. Load final orchestration state
    const orch = await loadOrchestration(orchId);

    if (!orch) {
      throw new Error("Orchestration state not found after execution");
    }

    // 6. Broadcast completion or failure event
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
    logger.error("Orchestration failed", { orchId, error: String(err) });

    // Ensure orchestration is marked as failed
    try {
      const orch = await loadOrchestration(orchId);
      if (orch && orch.status !== "failed") {
        orch.status = "failed";
        orch.error = err instanceof Error ? err.message : String(err);
        orch.completedAtMs = Date.now();
        await saveOrchestration(orch);
      }
    } catch (saveErr) {
      logger.error("Failed to save error state", { orchId, error: String(saveErr) });
    }

    // Broadcast failure event
    try {
      await broadcastOrchestrationEvent({
        type: "orchestration.failed",
        orchestrationId: orchId,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch (broadcastErr) {
      logger.error("Failed to broadcast failure event", {
        orchId,
        error: String(broadcastErr),
      });
    }
  } finally {
    // 7. Cleanup resources
    try {
      if (memoryContext) {
        const { cleanupOrchestrationMemory } = await import("./orchestrator-memory.js");
        await cleanupOrchestrationMemory(memoryContext);
        logger.info("Cleaned up orchestration memory", { orchId });
      }
    } catch (cleanupErr) {
      logger.error("Failed to cleanup memory", { orchId, error: String(cleanupErr) });
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
 */
export async function runOrchestratorDaemon(opts: OrchestratorDaemonOptions): Promise<void> {
  logger.info("Orchestrator daemon started", { workspaceDir: opts.workspaceDir });

  const maxConcurrent = opts.maxOrchestrations ?? ORCHESTRATION_DEFAULTS.maxOrchestrations;
  const runningTasks = new Set<Promise<void>>();

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
          // No running tasks either, sleep for a bit
          await new Promise((resolve) => setTimeout(resolve, 5000));
        } else {
          // Wait for any running task to complete
          await Promise.race(runningTasks);
        }
        continue;
      }

      // Process the first request
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
