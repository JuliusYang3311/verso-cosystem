import type { VersoConfig } from "../config/config.js";
import type { MemorySearchManager } from "./types.js";

export type MemorySearchManagerResult = {
  manager: MemorySearchManager | null;
  error?: string;
};

/**
 * Get the memory search manager for an agent.
 * Uses the builtin MemoryIndexManager with full feature set:
 * - Latent factors
 * - Hierarchical search
 * - Hybrid search (vector + BM25)
 * - MMR diversity
 * - Three-layer memory (L0/L1/L2)
 */
export async function getMemorySearchManager(params: {
  cfg: VersoConfig;
  agentId: string;
}): Promise<MemorySearchManagerResult> {
  try {
    const { MemoryIndexManager } = await import("./manager.js");
    const manager = await MemoryIndexManager.get(params);
    return { manager };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { manager: null, error: message };
  }
}
