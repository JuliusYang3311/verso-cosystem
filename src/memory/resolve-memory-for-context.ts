/**
 * resolve-memory-for-context.ts — Resolve memory manager for dynamic context injection.
 *
 * Extracted from attempt.ts for testability. Used by all session runners
 * (main agent, cron, orchestration) that need to resolve a MemorySearchManager.
 */

import type { MemorySearchManager } from "./types.js";

const logger = {
  warn: (...args: unknown[]) => console.warn("[memory-resolve]", ...args),
};

export type ResolveMemoryResult = {
  manager: MemorySearchManager | null;
  /** Warning message if initialization failed (non-fatal). */
  warning?: string;
};

/**
 * Resolve memory manager for dynamic context.
 * Returns { manager, warning } — never throws.
 *
 * @param explicitManager — Pre-provided manager (e.g. from orchestration shared memory)
 * @param dynamicContextEnabled — Whether dynamic context is enabled in config
 * @param cfg — Verso config for getMemorySearchManager fallback
 * @param agentId — Agent ID for getMemorySearchManager fallback
 */
export async function resolveMemoryForContext(params: {
  explicitManager?: MemorySearchManager | null;
  dynamicContextEnabled: boolean;
  cfg?: Record<string, unknown>;
  agentId: string;
}): Promise<ResolveMemoryResult> {
  if (!params.dynamicContextEnabled) {
    return { manager: null };
  }

  // Use explicit manager if provided (orchestration, subagents)
  if (params.explicitManager) {
    return { manager: params.explicitManager };
  }

  // Fallback: resolve from config
  try {
    const { getMemorySearchManager } = await import("./search-manager.js");
    const result = await getMemorySearchManager({
      cfg: (params.cfg ?? {}) as import("../config/config.js").VersoConfig,
      agentId: params.agentId,
    });

    if (!result.manager && result.error) {
      const warning = `Memory manager initialization failed: ${result.error}`;
      logger.warn(warning, { agentId: params.agentId });
      return { manager: null, warning };
    }

    return { manager: result.manager ?? null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const warning = `Memory manager initialization threw: ${msg}`;
    logger.warn(warning, { agentId: params.agentId });
    return { manager: null, warning };
  }
}
