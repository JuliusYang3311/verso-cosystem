// src/orchestration/events.ts — Orchestration event broadcasting

import type { Orchestration, Subtask } from "./types.js";

export type OrchestrationEvent =
  | { type: "orchestration.started"; orchestrationId: string; userPrompt: string }
  | {
      type: "orchestration.completed";
      orchestrationId: string;
      outputPath?: string;
      summary: string;
    }
  | { type: "orchestration.failed"; orchestrationId: string; error: string }
  | { type: "orchestration.updated"; payload: OrchestrationSnapshot }
  | { type: "orchestration.subtask"; payload: SubtaskEvent };

export type OrchestrationSnapshot = {
  id: string;
  status: Orchestration["status"];
  subtaskCounts: { pending: number; running: number; completed: number; failed: number };
  fixCycle: number;
  maxFixCycles: number;
  updatedAtMs: number;
};

export type SubtaskEvent = {
  orchestrationId: string;
  subtaskId: string;
  status: Subtask["status"];
  title?: string;
  error?: string;
};

export function buildOrchestrationSnapshot(orch: Orchestration): OrchestrationSnapshot {
  const subtasks = orch.plan?.subtasks ?? [];
  return {
    id: orch.id,
    status: orch.status,
    subtaskCounts: {
      pending: subtasks.filter((s) => s.status === "pending").length,
      running: subtasks.filter((s) => s.status === "running").length,
      completed: subtasks.filter((s) => s.status === "completed").length,
      failed: subtasks.filter((s) => s.status === "failed" || s.status === "cancelled").length,
    },
    fixCycle: orch.currentFixCycle,
    maxFixCycles: orch.maxFixCycles,
    updatedAtMs: orch.updatedAtMs,
  };
}

/**
 * Broadcast an orchestration event.
 * This function is called from the daemon to notify all connected clients.
 * For completion/failure events, also injects a notification into the main agent session.
 */
export async function broadcastOrchestrationEvent(event: OrchestrationEvent): Promise<void> {
  const { createSubsystemLogger } = await import("../logging/subsystem.js");
  const logger = createSubsystemLogger("orchestration-events");

  logger.info("Broadcasting orchestration event", {
    type: event.type,
    orchestrationId: "orchestrationId" in event ? event.orchestrationId : undefined,
  });

  try {
    // Broadcast event via gateway
    const { callGateway } = await import("../gateway/call.js");
    await callGateway({
      method: "orchestration.broadcast",
      params: {
        event: event.type,
        payload: event,
      },
      timeoutMs: 5000,
    });

    logger.info("Successfully broadcasted orchestration event via gateway", {
      type: event.type,
    });

    // For completion/failure events, inject a notification into the main agent session
    // AND process the queue to start the next orchestration
    if (event.type === "orchestration.completed" || event.type === "orchestration.failed") {
      const orchId = event.orchestrationId;

      logger.info("Processing completion/failure event", { orchId, type: event.type });

      // Load orchestration to get the main session key
      const { loadOrchestration } = await import("./store.js");
      const orch = await loadOrchestration(orchId);

      if (!orch) {
        logger.warn("Cannot inject notification: orchestration not found", { orchId });
        return;
      }

      // Get triggering session key (fallback to extracting from orchestratorSessionKey)
      // If triggeringSessionKey is set, use it (e.g., telegram:chat:123456)
      // Otherwise, extract from orchestratorSessionKey (agent:<agentId>:orch:<orchId> → agent:<agentId>)
      const mainSessionKey =
        orch.triggeringSessionKey || orch.orchestratorSessionKey.split(":orch:")[0];

      logger.info("Determined main session key", {
        orchId,
        mainSessionKey,
        orchestratorSessionKey: orch.orchestratorSessionKey,
        triggeringSessionKey: orch.triggeringSessionKey,
      });

      if (!mainSessionKey) {
        logger.warn("Cannot determine main session key", {
          orchestratorSessionKey: orch.orchestratorSessionKey,
          triggeringSessionKey: orch.triggeringSessionKey,
        });
        return;
      }

      // Inject notification message into main agent session
      let notificationMessage = "";
      if (event.type === "orchestration.completed") {
        const outputPath = "outputPath" in event ? event.outputPath : undefined;
        const summary = "summary" in event ? event.summary : "Orchestration completed";
        notificationMessage = `🎉 Orchestration ${orchId} completed successfully!\n\n${summary}${outputPath ? `\n\nOutput: ${outputPath}` : ""}`;
      } else {
        const error = "error" in event ? event.error : "Unknown error";
        notificationMessage = `❌ Orchestration ${orchId} failed.\n\nError: ${error}`;
      }

      logger.info("Injecting notification into main session", {
        orchId,
        mainSessionKey,
        messageLength: notificationMessage.length,
      });

      try {
        await callGateway({
          method: "chat.inject",
          params: {
            sessionKey: mainSessionKey,
            message: notificationMessage,
            label: "orchestration",
          },
          timeoutMs: 5000,
        });

        logger.info("Successfully injected orchestration notification into main session", {
          orchId,
          mainSessionKey,
          type: event.type,
        });
      } catch (err) {
        logger.error("Failed to inject orchestration notification", {
          error: String(err),
          errorStack: err instanceof Error ? err.stack : undefined,
          orchId,
          mainSessionKey,
        });
      }

      // Process queue: start next orchestration if any
      try {
        const { startOrchestratorDaemon, dequeueOrchestration } = await import("./orchestrator.js");

        const nextItem = dequeueOrchestration();
        if (nextItem) {
          logger.info("Starting next queued orchestration", {
            orchestrationId: nextItem.orchestrationId,
          });

          const startResult = await startOrchestratorDaemon({
            cfg: nextItem.cfg,
            agentId: nextItem.agentId,
            orchestrationId: nextItem.orchestrationId,
            userPrompt: nextItem.userPrompt,
          });

          if (startResult.started) {
            logger.info("Successfully started queued orchestration", {
              orchestrationId: nextItem.orchestrationId,
              pid: startResult.pid,
            });
          } else {
            logger.warn("Failed to start queued orchestration", {
              orchestrationId: nextItem.orchestrationId,
              error: startResult.error,
            });
          }
        }
      } catch (err) {
        logger.error("Failed to process orchestration queue", {
          error: String(err),
        });
      }
    }
  } catch (err) {
    logger.error("Failed to broadcast orchestration event", {
      error: String(err),
      event,
    });
  }
}

/**
 * Emit an orchestration event via a broadcast function.
 * The broadcast function is injected from the gateway context.
 */
export function emitOrchestrationEvent(
  broadcast: (event: string, payload: unknown) => void,
  event: OrchestrationEvent,
): void {
  broadcast(event.type, event);
}
