// src/evolver/events.ts — Evolver event broadcasting

import type { VersoConfig } from "../config/types.js";

export type EvolverEvent =
  | { type: "evolver.started"; runId: string; mode: string }
  | { type: "evolver.cycle.started"; runId: string; cycleNumber: number }
  | {
      type: "evolver.cycle.completed";
      runId: string;
      cycleNumber: number;
      filesChanged: string[];
      elapsed: number;
    }
  | { type: "evolver.cycle.failed"; runId: string; cycleNumber: number; error: string }
  | { type: "evolver.solidify.started"; runId: string }
  | { type: "evolver.solidify.completed"; runId: string; filesChanged: string[] }
  | { type: "evolver.solidify.failed"; runId: string; error: string }
  | { type: "evolver.stopped"; runId: string; reason: string }
  | { type: "evolver.status"; status: EvolverStatus };

export type EvolverStatus = {
  running: boolean;
  mode?: "single" | "loop" | "solidify";
  currentCycle?: number;
  totalCycles?: number;
  lastRunTime?: number;
  lastError?: string;
  filesChanged?: string[];
};

/**
 * Broadcast an evolver event via gateway.
 */
export async function broadcastEvolverEvent(
  event: EvolverEvent,
  config?: VersoConfig,
): Promise<void> {
  const { createSubsystemLogger } = await import("../logging/subsystem.js");
  const logger = createSubsystemLogger("evolver-events");

  logger.info("Broadcasting evolver event", {
    type: event.type,
  });

  try {
    // Load config if not provided
    const { loadConfig } = await import("../config/config.js");
    const effectiveConfig = config ?? loadConfig();

    // Broadcast event via gateway
    const { callGateway } = await import("../gateway/call.js");
    const { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } =
      await import("../utils/message-channel.js");

    await callGateway({
      method: "evolver.broadcast",
      params: {
        event: event.type,
        payload: event,
      },
      timeoutMs: 5000,
      config: effectiveConfig,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "evolver",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });

    logger.info("Successfully broadcasted evolver event", {
      type: event.type,
    });
  } catch (err) {
    logger.error("Failed to broadcast evolver event", {
      error: String(err),
      event,
    });
  }
}

/**
 * Get current evolver status.
 */
export function getEvolverStatus(): EvolverStatus {
  // TODO: Read from state file or memory
  return {
    running: false,
  };
}
