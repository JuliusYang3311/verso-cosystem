import type { VersoConfig } from "../config/config.js";
import type { AgentModelListConfig } from "../config/types.js";

export const OPENAI_CODEX_DEFAULT_MODEL = "openai-codex/gpt-5.4";

function shouldSetOpenAICodexModel(model?: string): boolean {
  const trimmed = model?.trim();
  if (!trimmed) {
    return true;
  }
  const normalized = trimmed.toLowerCase();
  // If already using an openai-codex model, keep it.
  if (normalized.startsWith("openai-codex/")) {
    return false;
  }
  // Otherwise, allow override (treat everything else as "not codex").
  return true;
}

function resolvePrimaryModel(model?: AgentModelListConfig | string): string | undefined {
  if (typeof model === "string") {
    return model;
  }
  if (model && typeof model === "object" && typeof model.primary === "string") {
    return model.primary;
  }
  return undefined;
}

export function applyOpenAICodexModelDefault(cfg: VersoConfig): {
  next: VersoConfig;
  changed: boolean;
} {
  const current = resolvePrimaryModel(cfg.agents?.defaults?.model);
  const shouldSet = shouldSetOpenAICodexModel(current);

  // Inject provider entry if missing for visibility.
  const providers = { ...cfg.models?.providers };
  let providerChanged = false;
  if (!providers["openai-codex"]) {
    providers["openai-codex"] = {
      baseUrl: "https://api.openai.com/v1",
      auth: "oauth",
      api: "openai-responses",
      models: [],
    };
    providerChanged = true;
  }

  if (!shouldSet && !providerChanged) {
    return { next: cfg, changed: false };
  }

  const next: VersoConfig = {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        model: shouldSet
          ? cfg.agents?.defaults?.model && typeof cfg.agents.defaults.model === "object"
            ? {
                ...cfg.agents.defaults.model,
                primary: OPENAI_CODEX_DEFAULT_MODEL,
              }
            : { primary: OPENAI_CODEX_DEFAULT_MODEL }
          : cfg.agents?.defaults?.model,
      },
    },
    models: {
      ...cfg.models,
      providers,
    },
  };

  return {
    next,
    changed: shouldSet || providerChanged,
  };
}
