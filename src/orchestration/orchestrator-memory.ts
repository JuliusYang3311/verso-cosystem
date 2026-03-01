// src/orchestration/orchestrator-memory.ts — Shared memory management for orchestration
//
// Creates a MemoryIndexManager instance shared by orchestrator and workers.
// Uses the real agentId (e.g. "main") to resolve config, embedding provider,
// latent factors, MMR, three-layer memory, and hybrid search — identical to
// the main agent's memory system.
//
// Memory is automatically cleaned up after orchestration completes.

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
 * Initialize shared memory for orchestration.
 *
 * Uses the real agentId (e.g. "main") so that MemoryIndexManager resolves
 * the full memory config chain: embedding provider, latent factors, MMR,
 * three-layer memory (L0/L1/chunks), hybrid search (vector + BM25), and
 * dynamic context loading — identical to the main agent.
 *
 * Both orchestrator and workers share this memory instance via MEMORY_DIR env.
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

    // Import memory manager
    const { MemoryIndexManager } = await import("../memory/manager.js");
    const { loadConfig } = await import("../config/config.js");

    const cfg = loadConfig();

    // Use the real agentId (e.g. "main") so MemoryIndexManager resolves:
    // - resolveMemorySearchConfig: provider, model, fallback, hybrid, sources
    // - resolveAgentWorkspaceDir: correct workspace for file watching
    // - createEmbeddingProvider: embedding model (local/remote)
    // - latent factors, MMR, three-layer memory, dynamic context
    const memoryManager = await MemoryIndexManager.get({
      cfg,
      agentId, // Real agent ID, not orch-prefixed
    });

    if (!memoryManager) {
      logger.warn("Failed to create memory manager for orchestration", { orchId });
      return { memoryDir, memoryManager: null };
    }

    logger.info("Initialized orchestration memory", {
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
 * Note: We do NOT close the memory manager here because it may be shared
 * with the main agent via the INDEX_CACHE. We only clean up the temporary
 * memory directory.
 */
export async function cleanupOrchestrationMemory(
  memoryContext: OrchestrationMemoryContext,
): Promise<void> {
  try {
    // Remove memory directory (temporary orchestration data only)
    if (fs.existsSync(memoryContext.memoryDir)) {
      fs.rmSync(memoryContext.memoryDir, { recursive: true, force: true });
      logger.info("Removed orchestration memory directory", {
        memoryDir: memoryContext.memoryDir,
      });
    }
  } catch (err) {
    logger.error("Failed to cleanup orchestration memory", { error: String(err) });
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
