import type { VersoConfig } from "../config/config.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";

export type ResolvedMemoryBackendConfig = {
  citations: MemoryCitationsMode;
};

const DEFAULT_CITATIONS: MemoryCitationsMode = "auto";

export function resolveMemoryBackendConfig(params: {
  cfg: VersoConfig;
  agentId: string;
}): ResolvedMemoryBackendConfig {
  const citations = params.cfg.memory?.citations ?? DEFAULT_CITATIONS;
  return { citations };
}
