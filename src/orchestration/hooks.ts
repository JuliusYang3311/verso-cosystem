// src/orchestration/hooks.ts — Hook system for orchestration lifecycle events

import type { Orchestration, Subtask, AcceptanceResult } from "./types.js";
import type { WorkerResult } from "./worker-runner.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const logger = createSubsystemLogger("orchestration-hooks");

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
 * Register a hook handler for a specific hook type.
 *
 * @param hook - The hook type to register for
 * @param handler - The handler function to call when the hook is triggered
 *
 * @example
 * ```typescript
 * registerOrchestrationHook('worker:completed', async (ctx) => {
 *   if (ctx.result?.ok) {
 *     console.log(`Worker ${ctx.subtask?.id} completed successfully`);
 *   }
 * });
 * ```
 */
export function registerOrchestrationHook(hook: OrchestrationHook, handler: HookHandler): void {
  if (!hooks.has(hook)) {
    hooks.set(hook, []);
  }
  hooks.get(hook)!.push(handler);
  logger.debug("Hook registered", { hook, handlerCount: hooks.get(hook)!.length });
}

/**
 * Unregister a specific hook handler.
 *
 * @param hook - The hook type
 * @param handler - The handler function to remove
 */
export function unregisterOrchestrationHook(hook: OrchestrationHook, handler: HookHandler): void {
  const handlers = hooks.get(hook);
  if (!handlers) {
    return;
  }

  const index = handlers.indexOf(handler);
  if (index !== -1) {
    handlers.splice(index, 1);
    logger.debug("Hook unregistered", { hook, remainingHandlers: handlers.length });
  }
}

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

/**
 * Clear all registered hooks (useful for testing).
 */
export function clearAllHooks(): void {
  hooks.clear();
  logger.debug("All hooks cleared");
}

/**
 * Get the number of registered handlers for a hook type.
 */
export function getHookHandlerCount(hook: OrchestrationHook): number {
  return hooks.get(hook)?.length ?? 0;
}

// --- Example Hook Implementations ---

/**
 * Example: Auto-commit after each worker completes.
 * Disabled by default - uncomment to enable.
 */
// registerOrchestrationHook('worker:completed', async (ctx) => {
//   if (ctx.result?.ok && ctx.subtask) {
//     try {
//       execSync(
//         `git add -A && git commit -m "Worker completed: ${ctx.subtask.title}"`,
//         { cwd: ctx.orchestration.workspaceDir, stdio: 'ignore' }
//       );
//       logger.info('Auto-committed worker changes', {
//         orchId: ctx.orchestrationId,
//         subtaskId: ctx.subtask.id,
//       });
//     } catch (err) {
//       logger.warn('Auto-commit failed', {
//         orchId: ctx.orchestrationId,
//         error: String(err),
//       });
//     }
//   }
// });

/**
 * Example: Run security scan before completion.
 * Disabled by default - uncomment to enable.
 */
// registerOrchestrationHook('acceptance:completed', async (ctx) => {
//   if (ctx.acceptance?.passed) {
//     try {
//       execSync('npm audit', {
//         cwd: ctx.orchestration.workspaceDir,
//         stdio: 'pipe',
//         timeout: 60000,
//       });
//       logger.info('Security scan passed', { orchId: ctx.orchestrationId });
//     } catch (err) {
//       logger.warn('Security scan failed', {
//         orchId: ctx.orchestrationId,
//         error: String(err),
//       });
//     }
//   }
// });

/**
 * Example: Log orchestration metrics.
 * Disabled by default - uncomment to enable.
 */
// registerOrchestrationHook('orchestration:completed', async (ctx) => {
//   const duration = Date.now() - ctx.orchestration.createdAtMs;
//   const subtaskCount = ctx.orchestration.plan?.subtasks.length ?? 0;
//   const fixCycles = ctx.orchestration.currentFixCycle;
//
//   logger.info('Orchestration metrics', {
//     orchId: ctx.orchestrationId,
//     durationMs: duration,
//     subtaskCount,
//     fixCycles,
//     status: ctx.orchestration.status,
//   });
// });
