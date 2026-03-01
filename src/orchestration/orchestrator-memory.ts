// src/orchestration/orchestrator-memory.ts — Shared memory management for orchestration
//
// Creates a temporary, isolated memory instance shared by orchestrator and workers.
// Memory is automatically cleaned up after orchestration completes.

import fs from "node:fs";
import path from "node:path";
import type { VersoConfig } from "../config/types.js";
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
 * Both orchestrator and workers will use this memory instance.
 */
export async function initOrchestrationMemory(params: {
  orchId: string;
  sourceWorkspaceDir: string;
  cfg?: VersoConfig;
  agentId: string;
}): Promise<OrchestrationMemoryContext> {
  const { orchId, sourceWorkspaceDir, cfg, agentId } = params;

  try {
    // Create temporary memory directory
    const memoryDir = createOrchestrationMemoryDir(sourceWorkspaceDir, orchId);

    // Import memory manager
    const { MemoryIndexManager } = await import("../memory/manager.js");
    const { loadConfig } = await import("../config/config.js");

    const config = cfg ?? loadConfig();

    // Create memory manager instance
    // Note: We use a custom cache key to ensure this is a separate instance
    const memoryManager = await MemoryIndexManager.get({
      cfg: config,
      agentId: `orch:${orchId}:${agentId}`, // Unique agent ID for this orchestration
    });

    if (!memoryManager) {
      logger.warn("Failed to create memory manager for orchestration", { orchId });
      return { memoryDir, memoryManager: null };
    }

    logger.info("Initialized orchestration memory", { orchId, memoryDir });

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
 * Closes the memory manager and removes the memory directory.
 */
export async function cleanupOrchestrationMemory(
  memoryContext: OrchestrationMemoryContext,
): Promise<void> {
  try {
    // Close memory manager
    if (memoryContext.memoryManager) {
      await memoryContext.memoryManager.close();
      logger.info("Closed orchestration memory manager");
    }

    // Remove memory directory
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
