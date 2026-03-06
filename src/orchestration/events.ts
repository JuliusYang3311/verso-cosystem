// src/orchestration/events.ts — Orchestration event broadcasting

import type { VersoConfig } from "../config/types.js";
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
export async function broadcastOrchestrationEvent(
  event: OrchestrationEvent,
  config?: VersoConfig,
): Promise<void> {
  const { createSubsystemLogger } = await import("../logging/subsystem.js");
  const logger = createSubsystemLogger("orchestration-events");

  logger.info("Broadcasting orchestration event", {
    type: event.type,
    orchestrationId: "orchestrationId" in event ? event.orchestrationId : undefined,
  });

  // Load config if not provided (for calls from orchestrator-tools)
  const { loadConfig } = await import("../config/config.js");
  const effectiveConfig = config ?? loadConfig();

  try {
    // Broadcast event via gateway
    const { callGateway } = await import("../gateway/call.js");
    const { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } =
      await import("../utils/message-channel.js");
    await callGateway({
      method: "orchestration.broadcast",
      params: {
        event: event.type,
        payload: event,
      },
      timeoutMs: 5000,
      config: effectiveConfig,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "orchestrator",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });

    logger.info("Successfully broadcasted orchestration event via gateway", {
      type: event.type,
    });

    // For completion/failure events, send notification via message.send
    // AND process the queue to start the next orchestration
    if (event.type === "orchestration.completed" || event.type === "orchestration.failed") {
      const orchId = event.orchestrationId;

      logger.info("Processing completion/failure event", { orchId, type: event.type });

      // Load orchestration to get the triggering session key
      const { loadOrchestration } = await import("./store.js");
      const orch = await loadOrchestration(orchId);

      if (!orch) {
        logger.warn("Cannot send notification: orchestration not found", { orchId });
      } else {
        // Use chatSessionKey (validated real chat session) with fallback to triggeringSessionKey
        // chatSessionKey is guaranteed to be a valid chat session (not agent:main)
        const sessionKey = orch.chatSessionKey || orch.triggeringSessionKey;

        if (sessionKey) {
          logger.info("Sending notification via message.send", {
            orchId,
            sessionKey,
            usingChatSessionKey: !!orch.chatSessionKey,
          });

          // Build notification message
          let notificationMessage = "";
          if (event.type === "orchestration.completed") {
            const outputPath = "outputPath" in event ? event.outputPath : undefined;
            const summary = "summary" in event ? event.summary : "Orchestration completed";
            notificationMessage = `🎉 Orchestration ${orchId} completed successfully!\n\n${summary}${outputPath ? `\n\nOutput: ${outputPath}` : ""}`;
          } else {
            const error = "error" in event ? event.error : "Unknown error";
            notificationMessage = `❌ Orchestration ${orchId} failed.\n\nError: ${error}`;
          }

          // Parse sessionKey to extract channel and target
          // Format: channel:type:target (e.g., telegram:chat:123456, wecom:user:userid)
          const parts = sessionKey.split(":");
          if (parts.length >= 3) {
            const channel = parts[0];
            const target = parts.slice(2).join(":"); // Handle targets with colons

            logger.info("Sending notification", {
              orchId,
              channel,
              target,
              messageLength: notificationMessage.length,
            });

            try {
              const { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } =
                await import("../utils/message-channel.js");

              const sendResult = await callGateway({
                method: "message.send",
                params: {
                  channel,
                  target,
                  message: notificationMessage,
                },
                timeoutMs: 10000,
                config: effectiveConfig,
                clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
                clientDisplayName: "orchestrator",
                mode: GATEWAY_CLIENT_MODES.BACKEND,
              });

              logger.info("Successfully sent orchestration notification", {
                orchId,
                channel,
                target,
                type: event.type,
                result: sendResult,
              });
            } catch (err) {
              logger.error("Failed to send orchestration notification", {
                orchId,
                channel,
                target,
                error: String(err),
              });
            }
          } else {
            logger.warn("Invalid sessionKey format - cannot parse channel/target", {
              orchId,
              sessionKey,
            });
          }
        } else {
          logger.warn("No chatSessionKey or triggeringSessionKey available for notification", {
            orchId,
          });
        }
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
