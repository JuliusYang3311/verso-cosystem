// src/orchestration/hooks.ts — Hook system for orchestration lifecycle events

import type { Orchestration, Subtask, AcceptanceResult } from "./types.js";
import type { WorkerResult } from "./worker-runner.js";

const logger = {
  debug: (...args: unknown[]) => console.debug("[orchestration-hooks]", ...args),
  warn: (...args: unknown[]) => console.warn("[orchestration-hooks]", ...args),
};

/**
 * Orchestration lifecycle hook types.
 * Hooks allow extending orchestration behavior without modifying core code.
 */
export type OrchestrationHook =
  | "orchestration:started" // When orchestration begins
  | "orchestration:plan-created" // After plan is created
  | "orchestration:phase-started" // When a phase begins (if using workflows)
  | "orchestration:phase-completed" // When a phase completes
  | "worker:started" // When a worker starts executing
  | "worker:completed" // When a worker completes successfully
  | "worker:failed" // When a worker fails
  | "acceptance:started" // Before acceptance testing
  | "acceptance:completed" // After acceptance testing
  | "orchestration:completed" // When orchestration completes successfully
  | "orchestration:failed"; // When orchestration fails

/**
 * Context passed to hook handlers.
 * Contains all relevant information about the current orchestration state.
 */
export type HookContext = {
  /** Orchestration ID */
  orchestrationId: string;
  /** Full orchestration object */
  orchestration: Orchestration;
  /** Current phase name (if using workflows) */
  phase?: string;
  /** Current subtask (for worker hooks) */
  subtask?: Subtask;
  /** Worker result (for worker:completed/failed hooks) */
  result?: WorkerResult;
  /** Acceptance result (for acceptance:completed hook) */
  acceptance?: AcceptanceResult;
};

/**
 * Hook handler function type.
 * Handlers can be async and should not throw errors (errors are caught and logged).
 */
export type HookHandler = (context: HookContext) => Promise<void> | void;

/**
 * Global hook registry.
 * Maps hook types to arrays of registered handlers.
 */
const hooks = new Map<OrchestrationHook, HookHandler[]>();

/**
 * Trigger all registered handlers for a specific hook.
 * Handlers are executed sequentially in registration order.
 * Errors in handlers are caught and logged but don't propagate.
 *
 * @param hook - The hook type to trigger
 * @param context - The context to pass to handlers
 *
 * @example
 * ```typescript
 * await triggerOrchestrationHook('orchestration:started', {
 *   orchestrationId: orch.id,
 *   orchestration: orch,
 * });
 * ```
 */
export async function triggerOrchestrationHook(
  hook: OrchestrationHook,
  context: HookContext,
): Promise<void> {
  const handlers = hooks.get(hook);
  if (!handlers || handlers.length === 0) {
    return;
  }

  logger.debug("Triggering hook", {
    hook,
    handlerCount: handlers.length,
    orchId: context.orchestrationId,
  });

  for (const handler of handlers) {
    try {
      await handler(context);
    } catch (err) {
      logger.warn("Hook handler failed", {
        hook,
        orchId: context.orchestrationId,
        error: String(err),
      });
    }
  }
}

/** Clear all registered hooks (useful for testing). */
export function clearAllHooks(): void {
  hooks.clear();
}
