import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { VersoConfig } from "../../config/config.js";
import { log } from "./logger.js";

const OPENROUTER_APP_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://verso.ai",
  "X-Title": "Verso",
};

/**
 * Resolve provider-specific extra params from model config.
 * Used to pass through stream params like temperature/maxTokens.
 *
 * @internal Exported for testing only
 */
export function resolveExtraParams(params: {
  cfg: VersoConfig | undefined;
  provider: string;
  modelId: string;
}): Record<string, unknown> | undefined {
  const modelKey = `${params.provider}/${params.modelId}`;
  const modelConfig = params.cfg?.agents?.defaults?.models?.[modelKey];
  return modelConfig?.params ? { ...modelConfig.params } : undefined;
}

type CacheRetention = "none" | "short" | "long";
type ThinkingConfig = { type: "adaptive" } | { type: "enabled"; budget_tokens: number };
type CacheRetentionStreamOptions = Partial<SimpleStreamOptions> & {
  cacheRetention?: CacheRetention;
  thinking?: ThinkingConfig;
};

/**
 * Resolve cacheRetention from extraParams, supporting both new `cacheRetention`
 * and legacy `cacheControlTtl` values for backwards compatibility.
 *
 * Mapping: "5m" → "short", "1h" → "long"
 *
 * Only applies to Anthropic provider (OpenRouter uses openai-completions API
 * with hardcoded cache_control, not the cacheRetention stream option).
 */
function resolveCacheRetention(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
): CacheRetention | undefined {
  if (provider !== "anthropic") {
    return undefined;
  }

  // Prefer new cacheRetention if present
  const newVal = extraParams?.cacheRetention;
  if (newVal === "none" || newVal === "short" || newVal === "long") {
    return newVal;
  }

  // Fall back to legacy cacheControlTtl with mapping
  const legacy = extraParams?.cacheControlTtl;
  if (legacy === "5m") {
    return "short";
  }
  if (legacy === "1h") {
    return "long";
  }
  return undefined;
}

/**
 * Resolve thinking config from extraParams for Anthropic models.
 * Supports adaptive thinking and extended thinking (legacy).
 *
 * Examples:
 * - { thinking: { type: "adaptive" } }
 * - { thinking: { type: "enabled", budget_tokens: 10000 } }
 * - { thinking: "adaptive" } (shorthand)
 * - { extended_thinking: 10000 } (legacy shorthand, converted to thinking)
 */
function resolveThinking(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
): ThinkingConfig | undefined {
  // Only for Anthropic API (not for other providers even if they use Claude models)
  if (provider !== "anthropic") {
    return undefined;
  }

  const thinkingVal = extraParams?.thinking;
  const extendedThinkingVal = extraParams?.extended_thinking;

  // Prefer new thinking parameter
  if (thinkingVal) {
    // Shorthand: "adaptive"
    if (thinkingVal === "adaptive") {
      return { type: "adaptive" };
    }

    // Full object format
    if (typeof thinkingVal === "object" && thinkingVal !== null) {
      const obj = thinkingVal as { type?: unknown; budget_tokens?: unknown };
      if (obj.type === "adaptive") {
        return { type: "adaptive" };
      }
      if (obj.type === "enabled" && typeof obj.budget_tokens === "number") {
        return { type: "enabled", budget_tokens: obj.budget_tokens };
      }
    }
  }

  // Legacy extended_thinking support (convert to thinking format)
  if (extendedThinkingVal) {
    // Shorthand: just a number
    if (typeof extendedThinkingVal === "number" && extendedThinkingVal > 0) {
      return { type: "enabled", budget_tokens: extendedThinkingVal };
    }

    // Full object format
    if (
      typeof extendedThinkingVal === "object" &&
      extendedThinkingVal !== null &&
      (extendedThinkingVal as { type?: unknown }).type === "enabled" &&
      typeof (extendedThinkingVal as { budget_tokens?: unknown }).budget_tokens === "number"
    ) {
      return {
        type: "enabled",
        budget_tokens: (extendedThinkingVal as { budget_tokens: number }).budget_tokens,
      };
    }
  }

  return undefined;
}

/**
 * Check if a model is Claude 4.6 series and should use adaptive thinking.
 * Works across different providers (anthropic, newapi, openrouter, etc.)
 */
function isClaude46Model(modelId: string): boolean {
  const normalized = modelId.toLowerCase().trim();
  return (
    normalized.includes("claude-opus-4-6") ||
    normalized.includes("claude-sonnet-4-6") ||
    normalized.includes("claude-haiku-4-6") ||
    normalized.includes("claude-4-6") ||
    normalized.includes("claude-4.6") ||
    normalized.includes("opus-4-6") ||
    normalized.includes("opus-4.6") ||
    normalized.includes("sonnet-4-6") ||
    normalized.includes("sonnet-4.6")
  );
}

function createStreamFnWithExtraParams(
  baseStreamFn: StreamFn | undefined,
  extraParams: Record<string, unknown> | undefined,
  provider: string,
  modelId: string,
): StreamFn | undefined {
  // Auto-enable adaptive thinking for Claude 4.6 models if not explicitly configured
  // Only for Anthropic provider (not for proxies like newapi, openrouter, etc.)
  let effectiveParams = extraParams;
  if (
    provider === "anthropic" &&
    isClaude46Model(modelId) &&
    (!extraParams ||
      (extraParams.thinking === undefined && extraParams.extended_thinking === undefined))
  ) {
    // Opus 4.6: use adaptive thinking (recommended)
    // Sonnet 4.6: use adaptive thinking (recommended, also supports manual mode)
    effectiveParams = {
      ...extraParams,
      thinking: { type: "adaptive" },
    };
    log.debug(`auto-enabling adaptive thinking for Claude 4.6 model: ${modelId}`);
  }

  if (!effectiveParams || Object.keys(effectiveParams).length === 0) {
    return undefined;
  }

  const streamParams: CacheRetentionStreamOptions = {};
  if (typeof effectiveParams.temperature === "number") {
    streamParams.temperature = effectiveParams.temperature;
  }
  if (typeof effectiveParams.maxTokens === "number") {
    streamParams.maxTokens = effectiveParams.maxTokens;
  }
  const cacheRetention = resolveCacheRetention(effectiveParams, provider);
  if (cacheRetention) {
    streamParams.cacheRetention = cacheRetention;
  }
  const thinking = resolveThinking(effectiveParams, provider);
  if (thinking) {
    streamParams.thinking = thinking;
  }

  if (Object.keys(streamParams).length === 0) {
    return undefined;
  }

  log.debug(`creating streamFn wrapper with params: ${JSON.stringify(streamParams)}`);

  const underlying = baseStreamFn ?? streamSimple;
  const wrappedStreamFn: StreamFn = (model, context, options) =>
    underlying(model, context, {
      ...streamParams,
      ...options,
    });

  return wrappedStreamFn;
}

/**
 * Create a streamFn wrapper that adds OpenRouter app attribution headers.
 * These headers allow Verso to appear on OpenRouter's leaderboard.
 */
function createOpenRouterHeadersWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      headers: {
        ...OPENROUTER_APP_HEADERS,
        ...options?.headers,
      },
    });
}

/**
 * Apply extra params (like temperature) to an agent's streamFn.
 * Also adds OpenRouter app attribution headers when using the OpenRouter provider.
 *
 * @internal Exported for testing
 */
export function applyExtraParamsToAgent(
  agent: { streamFn?: StreamFn },
  cfg: VersoConfig | undefined,
  provider: string,
  modelId: string,
  extraParamsOverride?: Record<string, unknown>,
): void {
  const extraParams = resolveExtraParams({
    cfg,
    provider,
    modelId,
  });
  const override =
    extraParamsOverride && Object.keys(extraParamsOverride).length > 0
      ? Object.fromEntries(
          Object.entries(extraParamsOverride).filter(([, value]) => value !== undefined),
        )
      : undefined;
  const merged = Object.assign({}, extraParams, override);
  const wrappedStreamFn = createStreamFnWithExtraParams(agent.streamFn, merged, provider, modelId);

  if (wrappedStreamFn) {
    log.debug(`applying extraParams to agent streamFn for ${provider}/${modelId}`);
    agent.streamFn = wrappedStreamFn;
  }

  if (provider === "openrouter") {
    log.debug(`applying OpenRouter app attribution headers for ${provider}/${modelId}`);
    agent.streamFn = createOpenRouterHeadersWrapper(agent.streamFn);
  }
}
