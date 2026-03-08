/**
 * acceptance-model.ts — Model resolution for evolver acceptance agent.
 * Reuses the same pattern as sandbox-agent.ts resolveAgentModel.
 */

import type { Model, Api } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";

export type ResolvedAcceptanceModel = {
  model: Model<Api>;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  agentDir: string;
};

/**
 * Resolve the model for the evolver acceptance evaluator.
 * Uses EVOLVER_MODEL env → config defaults → anthropic/claude-sonnet-4.
 */
export async function resolveAgentModel(): Promise<ResolvedAcceptanceModel> {
  const { loadConfig } = await import("../config/config.js");
  const { resolveConfiguredModelRef } = await import("../agents/model-selection.js");
  const { resolveModel } = await import("../agents/pi-embedded-runner/model.js");
  const { resolveApiKeyForProvider } = await import("../agents/model-auth.js");

  const cfg = loadConfig();

  const envModel = process.env.EVOLVER_MODEL;
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

  const agentDir = process.env.EVOLVER_AGENT_DIR || resolveOpenClawAgentDir();
  const { model, error, authStorage, modelRegistry } = resolveModel(
    provider,
    modelId,
    agentDir,
    cfg,
  );
  if (!model || error) {
    throw new Error(
      `Failed to resolve acceptance model ${provider}/${modelId}: ${error ?? "unknown"}`,
    );
  }

  // Bridge verso's auth into pi-coding-agent's AuthStorage
  try {
    const auth = await resolveApiKeyForProvider({ provider, cfg, agentDir });
    if (auth.apiKey) {
      authStorage.setRuntimeApiKey(provider, auth.apiKey);
    }
  } catch {
    // best-effort
  }

  return { model, authStorage, modelRegistry, agentDir };
}
