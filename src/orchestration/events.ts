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

    logger.info("Broadcasted orchestration event", {
      type: event.type,
    });

    // For completion/failure events, inject a notification into the main agent session
    if (event.type === "orchestration.completed" || event.type === "orchestration.failed") {
      const orchId = event.orchestrationId;

      // Load orchestration to get the main session key
      const { loadOrchestration } = await import("./store.js");
      const orch = await loadOrchestration(orchId);

      if (!orch) {
        logger.warn("Cannot inject notification: orchestration not found", { orchId });
        return;
      }

      // Get main agent session key from orchestrator session key
      // Format: agent:<agentId>:orch:<orchId> → agent:<agentId>
      const mainSessionKey = orch.orchestratorSessionKey.split(":orch:")[0];

      if (!mainSessionKey) {
        logger.warn("Cannot determine main session key", {
          orchestratorSessionKey: orch.orchestratorSessionKey,
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

        logger.info("Injected orchestration notification into main session", {
          orchId,
          mainSessionKey,
          type: event.type,
        });
      } catch (err) {
        logger.error("Failed to inject orchestration notification", {
          error: String(err),
          orchId,
          mainSessionKey,
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
