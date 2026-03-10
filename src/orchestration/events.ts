// src/orchestration/events.ts — Orchestration event broadcasting

import type { VersoConfig } from "../config/types.js";
import type { Orchestration, Subtask } from "./types.js";

const logger = {
  info: (...args: unknown[]) => console.log("[orchestration-events]", ...args),
  warn: (...args: unknown[]) => console.warn("[orchestration-events]", ...args),
  error: (...args: unknown[]) => console.error("[orchestration-events]", ...args),
};

// ---------------------------------------------------------------------------
// Gateway RPC helper with retry + exponential backoff
// ---------------------------------------------------------------------------

async function callGatewayWithRetry(opts: {
  method: string;
  params: Record<string, unknown>;
  timeoutMs: number;
  config: VersoConfig;
  maxRetries?: number;
}): Promise<unknown> {
  const { method, params, timeoutMs, config, maxRetries = 3 } = opts;
  const { callGateway } = await import("../gateway/call.js");
  const { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } =
    await import("../utils/message-channel.js");

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callGateway({
        method,
        params,
        timeoutMs,
        config,
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        clientDisplayName: "orchestrator",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      });
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delayMs = Math.min(1000 * 2 ** attempt, 8000);
        logger.warn(
          `Gateway RPC ${method} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms`,
          {
            error: String(err),
          },
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

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
  logger.info("Broadcasting orchestration event", {
    type: event.type,
    orchestrationId: "orchestrationId" in event ? event.orchestrationId : undefined,
  });

  // Load config if not provided (for calls from orchestrator-tools)
  const { loadConfig } = await import("../config/config.js");
  const effectiveConfig = config ?? loadConfig();

  try {
    // Broadcast event via gateway (fire-and-forget, no retry needed for UI updates)
    await callGatewayWithRetry({
      method: "orchestration.broadcast",
      params: { event: event.type, payload: event },
      timeoutMs: 5000,
      config: effectiveConfig,
      maxRetries: 1,
    });

    logger.info("Successfully broadcasted orchestration event via gateway", {
      type: event.type,
    });

    // For subtask completion/failure, send progress update to originating channel
    if (event.type === "orchestration.subtask") {
      const { orchestrationId, subtaskId, status, title } = event.payload;
      if (status === "completed" || status === "failed") {
        try {
          const { loadOrchestration } = await import("./store.js");
          const orch = await loadOrchestration(orchestrationId);
          if (orch?.delivery?.channel && orch.delivery.to) {
            const subtasks = orch.plan?.subtasks ?? [];
            const done = subtasks.filter((s) => s.status === "completed").length;
            const total = subtasks.length;
            const icon = status === "completed" ? "✅" : "⚠️";
            const progressMsg = `${icon} [${done}/${total}] ${title ?? subtaskId} — ${status}`;
            await callGatewayWithRetry({
              method: "send",
              params: {
                channel: orch.delivery.channel,
                to: orch.delivery.to,
                message: progressMsg,
                idempotencyKey: `orch-progress-${orchestrationId}-${subtaskId}-${status}`,
              },
              timeoutMs: 10000,
              config: effectiveConfig,
              maxRetries: 1,
            }).catch((err) => {
              logger.warn("Failed to send subtask progress update (non-fatal)", {
                orchestrationId,
                subtaskId,
                error: String(err),
              });
            });
          }
        } catch {
          // Non-fatal: progress updates are best-effort
        }
      }
    }

    // For completion/failure events, send notification via message.send
    // AND process the queue to start the next orchestration
    if (event.type === "orchestration.completed" || event.type === "orchestration.failed") {
      const orchId = event.orchestrationId;

      logger.info("Processing completion/failure event", { orchId, type: event.type });

      // Load orchestration
      const { loadOrchestration } = await import("./store.js");
      const orch = await loadOrchestration(orchId);

      if (!orch) {
        logger.warn("Cannot send notification: orchestration not found", { orchId });
      } else {
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

        // Mutually exclusive delivery: outbound if configured, inject into main session if not
        if (orch.delivery?.channel && orch.delivery?.to) {
          // Outbound delivery via gateway "send" RPC (daemon has no channel plugins)
          logger.info("Delivering orchestration notification outbound via gateway send", {
            orchId,
            channel: orch.delivery.channel,
            to: orch.delivery.to,
          });

          try {
            await callGatewayWithRetry({
              method: "send",
              params: {
                channel: orch.delivery.channel,
                to: orch.delivery.to,
                message: notificationMessage,
                idempotencyKey: `orch-notify-${orchId}-${event.type}`,
              },
              timeoutMs: 30000,
              config: effectiveConfig,
            });

            logger.info("Successfully delivered orchestration notification outbound", {
              orchId,
              channel: orch.delivery.channel,
            });
          } catch (err) {
            if (!orch.delivery.bestEffort) {
              logger.error("Failed to deliver orchestration notification outbound", {
                orchId,
                error: String(err),
              });
            } else {
              logger.warn("Best-effort delivery failed (ignored)", {
                orchId,
                error: String(err),
              });
            }
          }
        } else {
          // No outbound delivery configured — inject into main session
          logger.info("Injecting notification into agent:main:main", {
            orchId,
            messageLength: notificationMessage.length,
          });

          try {
            await callGatewayWithRetry({
              method: "chat.inject",
              params: {
                sessionKey: "agent:main:main",
                message: notificationMessage,
              },
              timeoutMs: 10000,
              config: effectiveConfig,
            });

            logger.info("Successfully injected orchestration notification", {
              orchId,
              type: event.type,
            });
          } catch (err) {
            logger.error("Failed to inject orchestration notification", {
              orchId,
              error: String(err),
            });
          }
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
