// src/orchestration/model-resolver.ts — Model resolution for orchestrator and workers
//
// Shared model resolution logic similar to evolver's resolveAgentModel
// and novel-writer's resolveEmbeddingProvider.
// Handles config loading, LLM model selection, embedding provider, and auth injection.

import type { Model, Api } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { EmbeddingProviderResult, EmbeddingProviderOptions } from "../memory/embeddings.js";

export type ResolvedModel = {
  model: Model<Api>;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  embeddingProvider: EmbeddingProviderResult;
};

/**
 * Resolve the LLM model to use for orchestrator/worker agents.
 * Similar to evolver's resolveAgentModel function.
 *
 * Resolution order:
 * 1. Check ORCHESTRATOR_MODEL env var (format: "provider/model")
 * 2. Fall back to verso config defaults
 * 3. Inject API key from verso's auth chain
 */
export async function resolveAgentModel(): Promise<ResolvedModel> {
  const { loadConfig } = await import("../config/config.js");
  const { resolveConfiguredModelRef } = await import("../agents/model-selection.js");
  const { resolveModel } = await import("../agents/pi-embedded-runner/model.js");
  const { resolveApiKeyForProvider } = await import("../agents/model-auth.js");
  const { createEmbeddingProvider } = await import("../memory/embeddings.js");
  const { resolveAgentDir } = await import("../agents/agent-scope.js");

  const cfg = loadConfig();

  // --- LLM Model Resolution (evolver pattern) ---

  // Use ORCHESTRATOR_MODEL env if set, otherwise fall back to config defaults
  const envModel = process.env.ORCHESTRATOR_MODEL;
  let provider: string;
  let modelId: string;

  if (envModel && envModel.includes("/")) {
    [provider, modelId] = envModel.split("/", 2);
  } else {
    const ref = resolveConfiguredModelRef({
      cfg,
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-20250514",
    });
    provider = ref.provider;
    modelId = ref.model;
  }

  const agentDir = process.env.ORCHESTRATOR_AGENT_DIR || resolveAgentDir(cfg, "main");
  const resolveResult = resolveModel(provider, modelId, agentDir, cfg);

  if (!resolveResult.model || resolveResult.error) {
    const errorMsg = resolveResult.error ?? "Model resolution returned undefined";
    const availableModels = resolveResult.modelRegistry.getAvailable();
    const providers = [...new Set(availableModels.map((m) => m.provider))];
    throw new Error(
      `Failed to resolve model ${provider}/${modelId}: ${errorMsg}\n` +
        `Available providers: ${providers.join(", ")}\n` +
        `Check your verso config or ORCHESTRATOR_MODEL env var.`,
    );
  }

  const { model, authStorage, modelRegistry } = resolveResult;

  // Bridge verso's auth into pi-coding-agent's AuthStorage
  // This allows custom providers (e.g. "newapi") to work correctly
  try {
    const auth = await resolveApiKeyForProvider({ provider, cfg, agentDir });
    if (auth.apiKey) {
      authStorage.setRuntimeApiKey(provider, auth.apiKey);
    }
  } catch {
    // best-effort: if verso can't resolve the key, let pi-coding-agent
    // try its own fallbacks (env vars, auth.json, etc.)
  }

  // --- Embedding Provider Resolution (novel-writer pattern) ---

  // Try to get provider settings from verso config
  const memSearch = cfg?.agents?.defaults?.memorySearch;
  const embProvider: EmbeddingProviderOptions["provider"] = memSearch?.provider ?? "auto";
  const embModel = memSearch?.model ?? "";
  const embFallback: EmbeddingProviderOptions["fallback"] = memSearch?.fallback ?? "local";
  const embRemote = memSearch?.remote;
  const embLocal = memSearch?.local;

  const embeddingProvider = await createEmbeddingProvider({
    config: cfg,
    agentDir,
    provider: embProvider,
    model: embModel,
    fallback: embFallback,
    remote: embRemote,
    local: embLocal,
  });

  return { model, authStorage, modelRegistry, embeddingProvider };
}
