import { resolveVersoAgentDir } from "../agent-paths.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { normalizeModelCompat } from "../model-compat.js";
import { resolveForwardCompatModel } from "../model-forward-compat.js";
import { normalizeProviderId } from "../model-selection.js";
import { discoverAuthStorage, discoverModels } from "../pi-model-discovery.js";
export function buildInlineProviderModels(providers) {
  return Object.entries(providers).flatMap(([providerId, entry]) => {
    const trimmed = providerId.trim();
    if (!trimmed) {
      return [];
    }
    const resolveDefaultApi = (p) => {
      switch (p) {
        case "anthropic":
          return "anthropic-messages";
        case "google":
          return "google-generative-ai";
        case "bedrock":
          return "bedrock-converse-stream";
        case "copilot":
          return "github-copilot";
        default:
          return "openai-responses";
      }
    };
    return (entry?.models ?? []).map((model) => ({
      ...model,
      provider: trimmed,
      baseUrl: entry?.baseUrl,
      // FIX: Default to provider-specific API type or "openai-responses" if API is not specified.
      // This prevents "Unhandled API" crashes while respecting known provider protocols.
      api: model.api ?? entry?.api ?? resolveDefaultApi(trimmed),
    }));
  });
}
export function buildModelAliasLines(cfg) {
  const models = cfg?.agents?.defaults?.models ?? {};
  const entries = [];
  for (const [keyRaw, entryRaw] of Object.entries(models)) {
    const model = String(keyRaw ?? "").trim();
    if (!model) {
      continue;
    }
    const alias = String(entryRaw?.alias ?? "").trim();
    if (!alias) {
      continue;
    }
    entries.push({ alias, model });
  }
  return entries
    .toSorted((a, b) => a.alias.localeCompare(b.alias))
    .map((entry) => `- ${entry.alias}: ${entry.model}`);
}
export function resolveModel(provider, modelId, agentDir, cfg) {
  const resolvedAgentDir = agentDir ?? resolveVersoAgentDir();
  const authStorage = discoverAuthStorage(resolvedAgentDir);
  const modelRegistry = discoverModels(authStorage, resolvedAgentDir);
  // Fix: If modelId incorrectly includes the provider prefix (e.g. "custom-openai/my-model"),
  // strip it so we look up "my-model" instead. This ensures API calls use the clean ID.
  // This happens if the caller passes the full key as the model ID.
  const prefix = `${provider}/`;
  if (modelId.startsWith(prefix)) {
    modelId = modelId.slice(prefix.length);
  }
  // 1. Try to find in registry (built-in or dynamic providers)
  let rawModel = modelRegistry.find(provider, modelId);
  const providers = cfg?.models?.providers ?? {};
  if (!rawModel) {
    // 2. Try to find in custom inline providers
    const inlineModels = buildInlineProviderModels(providers);
    const normalizedProvider = normalizeProviderId(provider);
    const inlineMatch = inlineModels.find(
      (entry) => normalizeProviderId(entry.provider) === normalizedProvider && entry.id === modelId,
    );
    if (inlineMatch) {
      rawModel = normalizeModelCompat(inlineMatch);
    }
    // 3. Forward-compat fallbacks for known-new model IDs
    // must be checked BEFORE the generic providerCfg fallback.
    if (!rawModel) {
      rawModel = resolveForwardCompatModel(provider, modelId, modelRegistry) ?? null;
    }
    if (!rawModel) {
      // 4. Fallback logic for generic providers or mocks
      const providerCfg = providers[provider];
      if (providerCfg || modelId.startsWith("mock-")) {
        rawModel = normalizeModelCompat({
          id: modelId,
          name: modelId,
          api: providerCfg?.api ?? "openai-responses",
          provider,
          baseUrl: providerCfg?.baseUrl,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: providerCfg?.models?.[0]?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
          maxTokens: providerCfg?.models?.[0]?.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
        });
      }
    }
  }
  if (rawModel) {
    // Apply effective context window logic: min(model.contextWindow, global.contextTokens)
    // Clone to avoid mutating shared registry objects if they are cached
    const finalModel = { ...rawModel };
    const globalContextLimit = cfg?.agents?.defaults?.contextTokens;
    if (globalContextLimit !== undefined && globalContextLimit < finalModel.contextWindow) {
      finalModel.contextWindow = globalContextLimit;
    }
    return { model: normalizeModelCompat(finalModel), authStorage, modelRegistry };
  }
  return {
    error: `Unknown model: ${provider}/${modelId}`,
    authStorage,
    modelRegistry,
  };
}
