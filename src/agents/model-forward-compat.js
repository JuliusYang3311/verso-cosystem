import { DEFAULT_CONTEXT_TOKENS } from "./defaults.js";
import { normalizeModelCompat } from "./model-compat.js";
import { normalizeProviderId } from "./model-selection.js";
const OPENAI_CODEX_GPT_53_MODEL_ID = "gpt-5.3-codex";
const OPENAI_CODEX_TEMPLATE_MODEL_IDS = ["gpt-5.2-codex"];
const ANTHROPIC_OPUS_46_MODEL_ID = "claude-opus-4-6";
const ANTHROPIC_OPUS_46_DOT_MODEL_ID = "claude-opus-4.6";
const ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS = ["claude-opus-4-5", "claude-opus-4.5"];
const ZAI_GLM5_MODEL_ID = "glm-5";
const ZAI_GLM5_TEMPLATE_MODEL_IDS = ["glm-4.7"];
const ANTIGRAVITY_OPUS_46_MODEL_ID = "claude-opus-4-6";
const ANTIGRAVITY_OPUS_46_DOT_MODEL_ID = "claude-opus-4.6";
const ANTIGRAVITY_OPUS_TEMPLATE_MODEL_IDS = ["claude-opus-4-5", "claude-opus-4.5"];
const ANTIGRAVITY_OPUS_46_THINKING_MODEL_ID = "claude-opus-4-6-thinking";
const ANTIGRAVITY_OPUS_46_DOT_THINKING_MODEL_ID = "claude-opus-4.6-thinking";
const ANTIGRAVITY_OPUS_THINKING_TEMPLATE_MODEL_IDS = [
  "claude-opus-4-5-thinking",
  "claude-opus-4.5-thinking",
];
export function resolveGemini3ForwardCompatModel(provider, modelId, modelRegistry) {
  if (modelId !== "gemini-3.1-flash-lite-preview" && modelId !== "gemini-3.1-pro-preview") {
    return undefined;
  }
  const normalizedProvider = normalizeProviderId(provider);
  // Try to find in registry first (it might be there under a different name or if registry was updated)
  const template = modelRegistry.find(normalizedProvider, modelId);
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
    });
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
    });
  }
  return undefined;
}
function resolveOpenAICodexGpt53FallbackModel(provider, modelId, modelRegistry) {
  const normalizedProvider = normalizeProviderId(provider);
  const trimmedModelId = modelId.trim();
  if (normalizedProvider !== "openai-codex") {
    return undefined;
  }
  if (trimmedModelId.toLowerCase() !== OPENAI_CODEX_GPT_53_MODEL_ID) {
    return undefined;
  }
  for (const templateId of OPENAI_CODEX_TEMPLATE_MODEL_IDS) {
    const template = modelRegistry.find(normalizedProvider, templateId);
    if (!template) {
      continue;
    }
    return normalizeModelCompat({
      ...template,
      id: trimmedModelId,
      name: trimmedModelId,
    });
  }
  return normalizeModelCompat({
    id: trimmedModelId,
    name: trimmedModelId,
    api: "openai-codex-responses",
    provider: normalizedProvider,
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: DEFAULT_CONTEXT_TOKENS,
  });
}
function resolveAnthropicOpus46ForwardCompatModel(provider, modelId, modelRegistry) {
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
  const templateIds = [];
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
      const template = modelRegistry.find(lookupProvider, templateId);
      if (!template) {
        continue;
      }
      return normalizeModelCompat({
        ...template,
        id: trimmedModelId,
        name: trimmedModelId,
        provider: normalizedProvider,
      });
    }
  }
  return undefined;
}
function resolveZaiGlm5ForwardCompatModel(provider, modelId, modelRegistry) {
  if (normalizeProviderId(provider) !== "zai") {
    return undefined;
  }
  const trimmed = modelId.trim();
  const lower = trimmed.toLowerCase();
  if (lower !== ZAI_GLM5_MODEL_ID && !lower.startsWith(`${ZAI_GLM5_MODEL_ID}-`)) {
    return undefined;
  }
  for (const templateId of ZAI_GLM5_TEMPLATE_MODEL_IDS) {
    const template = modelRegistry.find("zai", templateId);
    if (!template) {
      continue;
    }
    return normalizeModelCompat({
      ...template,
      id: trimmed,
      name: trimmed,
      reasoning: true,
    });
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
  });
}
function resolveAntigravityOpus46ForwardCompatModel(provider, modelId, modelRegistry) {
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
  const templateIds = [];
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
      const template = modelRegistry.find(lookupProvider, templateId);
      if (!template) {
        continue;
      }
      return normalizeModelCompat({
        ...template,
        id: trimmedModelId,
        name: trimmedModelId,
        provider: normalizedProvider,
      });
    }
  }
  return undefined;
}
export function resolveForwardCompatModel(provider, modelId, modelRegistry) {
  return (
    resolveGemini3ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveOpenAICodexGpt53FallbackModel(provider, modelId, modelRegistry) ??
    resolveAnthropicOpus46ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveZaiGlm5ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveAntigravityOpus46ForwardCompatModel(provider, modelId, modelRegistry)
  );
}
