import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "./pi-model-discovery.js";
import { DEFAULT_CONTEXT_TOKENS } from "./defaults.js";
import { normalizeModelCompat } from "./model-compat.js";
import { normalizeProviderId } from "./model-selection.js";

// ── OpenAI model specs table ────────────────────────────────────────
// Add new models here; the resolver walks the list top-down and falls
// back to the first available template in the registry.
const OPENAI_CODEX_MODELS: {
  id: string;
  templates: string[];
  api: string;
  contextWindow: number;
  maxTokens: number;
}[] = [
  // GPT-5.4 has no "-codex" variant; coding merged into base model.
  // Uses Responses API (Completions deprecated for 5.4+).
  {
    id: "gpt-5.4",
    templates: ["gpt-5.3-codex", "gpt-5.3", "gpt-5.2-codex"],
    api: "openai-responses",
    contextWindow: 1_050_000,
    maxTokens: 128_000,
  },
  {
    id: "gpt-5.3-codex",
    templates: ["gpt-5.2-codex"],
    api: "openai-codex-responses",
    contextWindow: 1_048_576,
    maxTokens: 100_000,
  },
  {
    id: "gpt-5.3",
    templates: ["gpt-5.2"],
    api: "openai-responses",
    contextWindow: 1_048_576,
    maxTokens: 100_000,
  },
];

const ANTHROPIC_OPUS_46_MODEL_ID = "claude-opus-4-6";
const ANTHROPIC_OPUS_46_DOT_MODEL_ID = "claude-opus-4.6";
const ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS = ["claude-opus-4-5", "claude-opus-4.5"] as const;

const ZAI_GLM5_MODEL_ID = "glm-5";
const ZAI_GLM5_TEMPLATE_MODEL_IDS = ["glm-4.7"] as const;

const ANTIGRAVITY_OPUS_46_MODEL_ID = "claude-opus-4-6";
const ANTIGRAVITY_OPUS_46_DOT_MODEL_ID = "claude-opus-4.6";
const ANTIGRAVITY_OPUS_TEMPLATE_MODEL_IDS = ["claude-opus-4-5", "claude-opus-4.5"] as const;
const ANTIGRAVITY_OPUS_46_THINKING_MODEL_ID = "claude-opus-4-6-thinking";
const ANTIGRAVITY_OPUS_46_DOT_THINKING_MODEL_ID = "claude-opus-4.6-thinking";
const ANTIGRAVITY_OPUS_THINKING_TEMPLATE_MODEL_IDS = [
  "claude-opus-4-5-thinking",
  "claude-opus-4.5-thinking",
] as const;

export function resolveGemini3ForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  if (modelId !== "gemini-3.1-flash-lite-preview" && modelId !== "gemini-3.1-pro-preview") {
    return undefined;
  }

  const normalizedProvider = normalizeProviderId(provider);
  // Try to find in registry first (it might be there under a different name or if registry was updated)
  const template = modelRegistry.find(normalizedProvider, modelId) as Model<Api> | null;

  if (template) {
    return normalizeModelCompat({
      ...template,
      api:
        normalizedProvider === "google"
          ? "google-generative-ai"
          : normalizedProvider === "google-antigravity"
            ? "google-antigravity"
            : "google-gemini-cli",
      baseUrl:
        normalizedProvider === "google"
          ? "https://generativelanguage.googleapis.com/v1beta"
          : "https://cloudcode-pa.googleapis.com",
      contextWindow: 1048576,
      reasoning: modelId === "gemini-3.1-pro-preview",
    } as Model<Api>);
  }

  // Fallback for missing registry entry
  if (
    normalizedProvider === "google-antigravity" ||
    normalizedProvider === "google-gemini-cli" ||
    normalizedProvider === "google"
  ) {
    return normalizeModelCompat({
      id: modelId,
      name:
        modelId === "gemini-3.1-pro-preview"
          ? "Gemini 3 Pro (Preview)"
          : "Gemini 3 Flash (Preview)",
      provider: normalizedProvider,
      api:
        normalizedProvider === "google"
          ? "google-generative-ai"
          : normalizedProvider === "google-antigravity"
            ? "google-antigravity"
            : "google-gemini-cli",
      baseUrl:
        normalizedProvider === "google"
          ? "https://generativelanguage.googleapis.com/v1beta"
          : "https://cloudcode-pa.googleapis.com",
      reasoning: modelId === "gemini-3.1-pro-preview",
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1048576,
      maxTokens: 65536,
    } as Model<Api>);
  }

  return undefined;
}

function resolveOpenAICodexFallbackModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  if (normalizedProvider !== "openai-codex" && normalizedProvider !== "openai") {
    return undefined;
  }

  const trimmedModelId = modelId.trim();
  const lower = trimmedModelId.toLowerCase();
  const spec = OPENAI_CODEX_MODELS.find((s) => s.id === lower);
  if (!spec) {
    return undefined;
  }

  // Try each template in order; first registry hit wins.
  for (const templateId of spec.templates) {
    const template = modelRegistry.find(normalizedProvider, templateId) as Model<Api> | null;
    if (!template) {
      continue;
    }
    return normalizeModelCompat({
      ...template,
      id: trimmedModelId,
      name: trimmedModelId,
      api: spec.api as Api,
      contextWindow: spec.contextWindow,
      maxTokens: spec.maxTokens,
    } as Model<Api>);
  }

  // No template in registry — synthesize from spec table.
  return normalizeModelCompat({
    id: trimmedModelId,
    name: trimmedModelId,
    api: spec.api as Api,
    provider: normalizedProvider,
    baseUrl: normalizedProvider === "openai-codex" ? "https://api.openai.com/v1" : undefined,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
  } as Model<Api>);
}

function resolveAnthropicOpus46ForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  // Support both native anthropic and google-antigravity (which routes Anthropic models)
  const isAnthropicCompatible =
    normalizedProvider === "anthropic" || normalizedProvider === "google-antigravity";
  if (!isAnthropicCompatible) {
    return undefined;
  }

  const trimmedModelId = modelId.trim();
  const lower = trimmedModelId.toLowerCase();
  const isOpus46 =
    lower === ANTHROPIC_OPUS_46_MODEL_ID ||
    lower === ANTHROPIC_OPUS_46_DOT_MODEL_ID ||
    lower.startsWith(`${ANTHROPIC_OPUS_46_MODEL_ID}-`) ||
    lower.startsWith(`${ANTHROPIC_OPUS_46_DOT_MODEL_ID}-`);
  if (!isOpus46) {
    return undefined;
  }

  const templateIds: string[] = [];
  if (lower.startsWith(ANTHROPIC_OPUS_46_MODEL_ID)) {
    templateIds.push(lower.replace(ANTHROPIC_OPUS_46_MODEL_ID, "claude-opus-4-5"));
  }
  if (lower.startsWith(ANTHROPIC_OPUS_46_DOT_MODEL_ID)) {
    templateIds.push(lower.replace(ANTHROPIC_OPUS_46_DOT_MODEL_ID, "claude-opus-4.5"));
  }
  templateIds.push(...ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS);

  // For google-antigravity, try looking up templates under both the actual provider
  // and under "anthropic" (where the base model definitions live)
  const lookupProviders =
    normalizedProvider === "google-antigravity"
      ? [normalizedProvider, "anthropic"]
      : [normalizedProvider];

  for (const lookupProvider of lookupProviders) {
    for (const templateId of [...new Set(templateIds)].filter(Boolean)) {
      const template = modelRegistry.find(lookupProvider, templateId) as Model<Api> | null;
      if (!template) {
        continue;
      }
      return normalizeModelCompat({
        ...template,
        id: trimmedModelId,
        name: trimmedModelId,
        provider: normalizedProvider,
      } as Model<Api>);
    }
  }

  return undefined;
}

function resolveZaiGlm5ForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  if (normalizeProviderId(provider) !== "zai") {
    return undefined;
  }
  const trimmed = modelId.trim();
  const lower = trimmed.toLowerCase();
  if (lower !== ZAI_GLM5_MODEL_ID && !lower.startsWith(`${ZAI_GLM5_MODEL_ID}-`)) {
    return undefined;
  }

  for (const templateId of ZAI_GLM5_TEMPLATE_MODEL_IDS) {
    const template = modelRegistry.find("zai", templateId) as Model<Api> | null;
    if (!template) {
      continue;
    }
    return normalizeModelCompat({
      ...template,
      id: trimmed,
      name: trimmed,
      reasoning: true,
    } as Model<Api>);
  }

  return normalizeModelCompat({
    id: trimmed,
    name: trimmed,
    api: "openai-completions",
    provider: "zai",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: DEFAULT_CONTEXT_TOKENS,
  } as Model<Api>);
}

function resolveAntigravityOpus46ForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  if (normalizedProvider !== "google-antigravity") {
    return undefined;
  }

  const trimmedModelId = modelId.trim();
  const lower = trimmedModelId.toLowerCase();
  const isOpus46 =
    lower === ANTIGRAVITY_OPUS_46_MODEL_ID ||
    lower === ANTIGRAVITY_OPUS_46_DOT_MODEL_ID ||
    lower.startsWith(`${ANTIGRAVITY_OPUS_46_MODEL_ID}-`) ||
    lower.startsWith(`${ANTIGRAVITY_OPUS_46_DOT_MODEL_ID}-`);
  const isOpus46Thinking =
    lower === ANTIGRAVITY_OPUS_46_THINKING_MODEL_ID ||
    lower === ANTIGRAVITY_OPUS_46_DOT_THINKING_MODEL_ID ||
    lower.startsWith(`${ANTIGRAVITY_OPUS_46_THINKING_MODEL_ID}-`) ||
    lower.startsWith(`${ANTIGRAVITY_OPUS_46_DOT_THINKING_MODEL_ID}-`);
  if (!isOpus46 && !isOpus46Thinking) {
    return undefined;
  }

  const templateIds: string[] = [];
  if (lower.startsWith(ANTIGRAVITY_OPUS_46_MODEL_ID)) {
    templateIds.push(lower.replace(ANTIGRAVITY_OPUS_46_MODEL_ID, "claude-opus-4-5"));
  }
  if (lower.startsWith(ANTIGRAVITY_OPUS_46_DOT_MODEL_ID)) {
    templateIds.push(lower.replace(ANTIGRAVITY_OPUS_46_DOT_MODEL_ID, "claude-opus-4.5"));
  }
  if (lower.startsWith(ANTIGRAVITY_OPUS_46_THINKING_MODEL_ID)) {
    templateIds.push(
      lower.replace(ANTIGRAVITY_OPUS_46_THINKING_MODEL_ID, "claude-opus-4-5-thinking"),
    );
  }
  if (lower.startsWith(ANTIGRAVITY_OPUS_46_DOT_THINKING_MODEL_ID)) {
    templateIds.push(
      lower.replace(ANTIGRAVITY_OPUS_46_DOT_THINKING_MODEL_ID, "claude-opus-4.5-thinking"),
    );
  }
  templateIds.push(...ANTIGRAVITY_OPUS_TEMPLATE_MODEL_IDS);
  templateIds.push(...ANTIGRAVITY_OPUS_THINKING_TEMPLATE_MODEL_IDS);

  // Fallback to "anthropic" for base Opus templates if needed
  const lookupProviders = [normalizedProvider, "anthropic"];

  for (const lookupProvider of lookupProviders) {
    for (const templateId of [...new Set(templateIds)].filter(Boolean)) {
      const template = modelRegistry.find(lookupProvider, templateId) as Model<Api> | null;
      if (!template) {
        continue;
      }
      return normalizeModelCompat({
        ...template,
        id: trimmedModelId,
        name: trimmedModelId,
        provider: normalizedProvider,
      } as Model<Api>);
    }
  }

  return undefined;
}

export function resolveForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  return (
    resolveGemini3ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveOpenAICodexFallbackModel(provider, modelId, modelRegistry) ??
    resolveAnthropicOpus46ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveZaiGlm5ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveAntigravityOpus46ForwardCompatModel(provider, modelId, modelRegistry)
  );
}
