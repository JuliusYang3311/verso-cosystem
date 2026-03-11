/**
 * evolver-memory.ts — Pure SQL memory for the evolver daemon.
 *
 * Persistent across cycles and daemon restarts. Shared between sandbox-agent
 * and acceptance sessions via dynamic context (WeakMap on SessionManager).
 *
 * DB location: {workspace}/memory/evolver_memory.sql
 * No markdown files, no filesystem sync — purely indexContent() writes.
 */

import fs from "node:fs";
import path from "node:path";
import type { VersoConfig } from "../config/types.js";
import type { MemoryIndexManager } from "../memory/manager.js";
import type { MemorySearchManager } from "../memory/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const logger = createSubsystemLogger("evolver-memory");

// ---------- Types ----------

export type EvolverMemoryContext = {
  dbPath: string;
  memoryManager: MemoryIndexManager | null;
};

// ---------- Init / Close ----------

/**
 * Initialize persistent evolver memory.
 *
 * Creates a MemoryIndexManager.createIsolated() with a custom dbPath
 * pointing to `{workspace}/memory/evolver_memory.sql`. Filesystem sync
 * is disabled — all content is indexed via indexContent().
 */
export async function initEvolverMemory(params: {
  workspaceDir: string;
  config?: VersoConfig;
  agentId?: string;
}): Promise<EvolverMemoryContext> {
  const { workspaceDir, agentId = "evolver" } = params;
  const dbPath = path.join(workspaceDir, "memory", "evolver_memory.sql");

  // Ensure the memory directory exists
  const memoryDir = path.dirname(dbPath);
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true });
  }

  try {
    const { MemoryIndexManager } = await import("../memory/manager.js");
    const cfg = params.config ?? (await import("../config/config.js")).loadConfig();

    const memoryManager = await MemoryIndexManager.createIsolated({
      cfg,
      agentId,
      workspaceDir,
      dbPath,
      sources: ["memory"],
    });

    if (!memoryManager) {
      logger.warn("Failed to create isolated memory manager for evolver");
      return { dbPath, memoryManager: null };
    }

    logger.info("Initialized evolver memory", { dbPath });
    return { dbPath, memoryManager };
  } catch (err) {
    logger.error("Failed to initialize evolver memory", { error: String(err) });
    return { dbPath, memoryManager: null };
  }
}

/**
 * Close the evolver memory manager.
 * Does NOT delete the DB — memory persists across daemon restarts.
 */
export async function closeEvolverMemory(ctx: EvolverMemoryContext): Promise<void> {
  if (!ctx.memoryManager) return;
  try {
    await ctx.memoryManager.close();
    logger.info("Closed evolver memory");
  } catch (err) {
    logger.error("Failed to close evolver memory", { error: String(err) });
  }
}

// ---------- Indexing ----------

/**
 * Index a cycle's sandbox-agent result into evolver memory.
 */
export async function indexCycleResult(params: {
  memoryManager: MemorySearchManager | null;
  cycleId: string;
  gepPrompt?: string;
  filesChanged: string[];
  agentOutput: string;
  ok: boolean;
}): Promise<void> {
  const { memoryManager, cycleId, gepPrompt, filesChanged, agentOutput, ok } = params;
  if (!memoryManager?.indexContent) return;

  const content = [
    `# Evolution Cycle ${cycleId}`,
    `Status: ${ok ? "success" : "failed"}`,
    `Files: ${filesChanged.join(", ") || "none"}`,
    gepPrompt ? `\nGEP Prompt Summary:\n${gepPrompt.slice(0, 2000)}` : "",
    `\nAgent Output:\n${agentOutput}`,
  ].join("\n");

  try {
    await memoryManager.indexContent({ path: `cycle/${cycleId}`, content });
  } catch (err) {
    logger.warn("Failed to index cycle result (non-fatal)", { cycleId, error: String(err) });
  }
}

/**
 * Index an acceptance evaluation result into evolver memory.
 */
export async function indexAcceptanceResult(params: {
  memoryManager: MemorySearchManager | null;
  cycleId: string;
  passed: boolean;
  confidence: number;
  reasoning: string;
  verifyCmd?: string;
  issues?: string[];
}): Promise<void> {
  const { memoryManager, cycleId, passed, confidence, reasoning, verifyCmd, issues } = params;
  if (!memoryManager?.indexContent) return;

  const content = [
    `# Acceptance ${cycleId}`,
    `Passed: ${passed} (confidence: ${confidence})`,
    verifyCmd ? `Verify Command: ${verifyCmd}` : "",
    `Reasoning: ${reasoning}`,
    issues?.length ? `Issues:\n${issues.map((i) => `- ${i}`).join("\n")}` : "",
  ].join("\n");

  try {
    await memoryManager.indexContent({ path: `acceptance/${cycleId}`, content });
  } catch (err) {
    logger.warn("Failed to index acceptance result (non-fatal)", { cycleId, error: String(err) });
  }
}
