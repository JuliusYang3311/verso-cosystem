// src/orchestration/orchestrator-memory.ts — Shared memory management for orchestration
//
// Creates an ISOLATED MemoryIndexManager instance for each orchestration.
// Uses MemoryIndexManager.createIsolated() to get the full memory feature set
// (embedding, latent factors, MMR, three-layer memory, hybrid search)
// without polluting the main agent's memory cache.
//
// Modeled after novel-writer's NovelMemoryStore pattern:
// independent DB, independent provider, independent lifecycle.

import fs from "node:fs";
import path from "node:path";
import type { MemoryIndexManager } from "../memory/manager.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const logger = createSubsystemLogger("orchestrator-memory");

export type OrchestrationMemoryContext = {
  memoryDir: string;
  memoryManager: MemoryIndexManager | null;
};

/**
 * Create a temporary memory directory for an orchestration.
 * Layout: <sourceWorkspace>/.verso-missions/<orchId>/memory/
 */
export function createOrchestrationMemoryDir(sourceWorkspaceDir: string, orchId: string): string {
  const memoryDir = path.join(sourceWorkspaceDir, ".verso-missions", orchId, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  return memoryDir;
}

/**
 * Initialize an isolated memory engine for orchestration.
 *
 * Creates a MemoryIndexManager.createIsolated() instance that:
 * - Uses the real agentId to resolve full memory config
 * - Points to the orchestration's mission workspace (isolated DB)
 * - Has its own embedding provider, latent factors, MMR, hybrid search
 * - Is NOT in the global INDEX_CACHE (won't affect main agent)
 * - Can be safely closed and cleaned up after orchestration completes
 *
 * Both orchestrator and workers share this instance via MEMORY_DIR env.
 */
export async function initOrchestrationMemory(params: {
  orchId: string;
  sourceWorkspaceDir: string;
  agentId: string;
}): Promise<OrchestrationMemoryContext> {
  const { orchId, sourceWorkspaceDir, agentId } = params;

  try {
    // Create temporary memory directory
    const memoryDir = createOrchestrationMemoryDir(sourceWorkspaceDir, orchId);

    const { MemoryIndexManager } = await import("../memory/manager.js");
    const { loadConfig } = await import("../config/config.js");

    const cfg = loadConfig();

    // Create isolated instance — not cached, independent lifecycle
    // Uses real agentId to resolve config (embedding, latent factors, MMR, etc.)
    // but workspaceDir points to the orchestration's mission workspace
    const memoryManager = await MemoryIndexManager.createIsolated({
      cfg,
      agentId,
      workspaceDir: memoryDir,
    });

    if (!memoryManager) {
      logger.warn("Failed to create isolated memory manager for orchestration", { orchId });
      return { memoryDir, memoryManager: null };
    }

    logger.info("Initialized isolated orchestration memory", {
      orchId,
      memoryDir,
      agentId,
    });

    return { memoryDir, memoryManager };
  } catch (err) {
    logger.error("Failed to initialize orchestration memory", {
      orchId,
      error: String(err),
    });
    return {
      memoryDir: createOrchestrationMemoryDir(sourceWorkspaceDir, orchId),
      memoryManager: null,
    };
  }
}

/**
 * Cleanup orchestration memory.
 * Closes the isolated memory manager and removes the memory directory.
 * Safe to call — the manager is not in the global cache.
 */
export async function cleanupOrchestrationMemory(
  memoryContext: OrchestrationMemoryContext,
): Promise<void> {
  const errors: string[] = [];

  // Close isolated memory manager (releases DB connections, watchers, etc.)
  if (memoryContext.memoryManager) {
    try {
      await memoryContext.memoryManager.close();
      logger.info("Closed isolated orchestration memory manager");
    } catch (err) {
      const errMsg = `Failed to close memory manager: ${String(err)}`;
      logger.error(errMsg);
      errors.push(errMsg);
    }
  }

  // Remove memory directory
  if (memoryContext.memoryDir && fs.existsSync(memoryContext.memoryDir)) {
    try {
      fs.rmSync(memoryContext.memoryDir, { recursive: true, force: true });
      logger.info("Removed orchestration memory directory", {
        memoryDir: memoryContext.memoryDir,
      });
    } catch (err) {
      const errMsg = `Failed to remove memory directory: ${String(err)}`;
      logger.error(errMsg);
      errors.push(errMsg);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Cleanup errors: ${errors.join("; ")}`);
  }
}

/**
 * Get the memory directory path for environment variables.
 * Workers will use this to access the shared memory.
 */
export function getOrchestrationMemoryEnv(memoryDir: string): Record<string, string> {
  return {
    MEMORY_DIR: memoryDir,
    VERSO_MEMORY_DIR: memoryDir,
  };
}
