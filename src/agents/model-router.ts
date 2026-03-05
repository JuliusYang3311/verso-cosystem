/**
 * Smart model router for dynamic model selection.
 * Analyzes user input and selects appropriate model from available candidates.
 */

import type { VersoConfig } from "../config/config.js";
import type { RouterConfig } from "../config/types.router.js";
import { logVerbose } from "../globals.js";
import { parseModelRef } from "./model-selection.js";

const DEFAULT_CLASSIFICATION_TIMEOUT_MS = 30000;

const DYNAMIC_SELECTION_PROMPT = `Select the best model ID from the VALID MODELS list for the USER INPUT.

### VALID MODELS:
{models}

### RULES:
1. You MUST pick exactly one ID from the list.
2. Wrap your selection in XML tags like this: <selected_model>model-id</selected_model>
3. DO NOT include any other text.
4. **PRIORITY RULE**: Unless the User Input requires high reasoning (e.g., coding, complex document analysis, creative writing) or specifically mentions a powerful model, ALWAYS prefer the most cost-effective model (typically 'flash' models) that can complete the task. Reserve 'pro' models for high-complexity work.
5. **MODEL HIERARCHY & COST RULES**:
   - **Gemini Series**: Ultra/Pro > Flash > Nano (Performance & Cost: High to Low).
   - **Claude Series**: Opus > Sonnet > Haiku (Performance & Cost: High to Low).
   - **OpenAI Series**: Codex > Pro > (No suffix) > Mini > Nano (Performance & Cost: High to Low).
   - **Cost Scaling**:
     - Flash < Pro/Sonnet (within same gen).
     - Faster models are typically cheaper.
     - Top-tier capability (Opus, Ultra, Codex) is significantly more expensive.
   - **Selection Strategy**: Choose the most cost-effective model that fully satisfies the user's intent. Prefer 'Flash' or 'Mini' for simple queries and 'Pro', 'Opus', or 'Codex' for complex reasoning/coding.

### EXAMPLES:
Input: "hello"
Response: <selected_model>google-gemini-cli/gemini-3.1-flash-lite-preview</selected_model>

Input: "help me write a complex python script"
Response: <selected_model>google-gemini-cli/gemini-3.1-pro-preview</selected_model>

Input: "use gemini 3 flash"
Response: <selected_model>google-gemini-cli/gemini-3.1-flash-lite-preview</selected_model>

Input: "Help me "
Response: <selected_model>google-gemini-cli/gemini-3.1-pro-preview</selected_model>

### TASK:
USER INPUT: "{input}"
Response:<selected_model>model-id</selected_model>`;

export function buildSelectionPrompt(params: { input: string; models: string[] }): string {
  return DYNAMIC_SELECTION_PROMPT.replace("{input}", params.input).replace(
    "{models}",
    params.models.map((m) => `- ${m}`).join("\n"),
  );
}

/**
 * Resolve router configuration from VersoConfig.
 */
export function resolveRouterConfig(cfg: VersoConfig): RouterConfig | null {
  const routerConfig = cfg.agents?.defaults?.router;
  if (!routerConfig?.enabled) {
    return null;
  }
  return routerConfig;
}

/**
 * Result of router model resolution.
 */
export type RouterModelResult = {
  /** Whether router was used (enabled and configured) */
  routerUsed: boolean;
  /** Resolved provider (if router provided a model) */
  provider?: string;
  /** Resolved model (if router provided a model) */
  model?: string;
  /** Classification time in ms */
  classificationTimeMs?: number;
  /** Error message if classification failed */
  error?: string;
};

export type SelectDynamicModelParams = {
  input: string;
  candidates: string[];
  callClassifier: (params: {
    provider: string;
    model: string;
    prompt: string;
    timeoutMs: number;
  }) => Promise<string>;
  classifierModel: string;
  timeoutMs?: number;
};

export async function selectDynamicModel(params: SelectDynamicModelParams): Promise<string | null> {
  const { input, candidates, callClassifier, classifierModel } = params;
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  // Determine the classifier model to use.
  // If not explicitly provided or invalid, select from the candidates list (already filtered to allowed models).
  let effectiveClassifier = classifierModel;
  const classifierRef = parseModelRef(effectiveClassifier, "google");

  if (!classifierRef) {
    // Attempt to pick the first "flash" model from candidates as a fallback.
    // Favor "google-gemini-cli" provider as requested.
    // IMPORTANT: Only select from candidates, which are already filtered to allowed models.
    const flashFallback =
      candidates.find(
        (m) =>
          m.startsWith("google-gemini-cli/") &&
          (m.toLowerCase().includes("flash") || m.toLowerCase().includes("preview")),
      ) ??
      candidates.find(
        (m) => m.toLowerCase().includes("flash") || m.toLowerCase().includes("preview"),
      );
    if (flashFallback) {
      effectiveClassifier = flashFallback;
    } else {
      // Last resort fallback: use the first candidate
      effectiveClassifier = candidates[0];
    }
    logVerbose(
      `Router: No valid classifierModel configured. Auto-selected ${effectiveClassifier} from allowed models`,
    );
  }

  const parsed = parseModelRef(effectiveClassifier, "google");
  if (!parsed) {
    return candidates[0];
  } // fallback

  let attempts = 0;
  const maxAttempts = 3;
  let lastInvalid: string | undefined;

  while (attempts < maxAttempts) {
    attempts++;
    let prompt = buildSelectionPrompt({ input, models: candidates });

    if (lastInvalid) {
      prompt += `\n\nERROR: Your previous response was invalid. You MUST select an ID EXACTLY from the VALID MODELS list and wrap it in <selected_model> tags. Do not truncate!`;
    }

    try {
      const response = await callClassifier({
        provider: parsed.provider,
        model: parsed.model,
        prompt,
        timeoutMs: params.timeoutMs ?? DEFAULT_CLASSIFICATION_TIMEOUT_MS,
      });

      // Extract <selected_model>model-id</selected_model>
      const match = response.match(/<selected_model>(.*?)<\/selected_model>/i);
      let selected = match ? match[1].trim() : response.trim();

      // Clean markers if regex missed but trim/replace can catch
      if (!match) {
        selected = selected
          .replace(/<selected_model>/i, "")
          .replace(/<\/selected_model>/i, "")
          .trim();
        // Check if it's still truncated but maybe recognizable?
        // No, strict mode means it must match the list.
      }

      logVerbose(
        `Router classifier raw response: "${response.replace(/\n/g, "\\n")}" (extracted: "${selected}") (timeoutMs: ${params.timeoutMs ?? DEFAULT_CLASSIFICATION_TIMEOUT_MS})`,
      );

      if (
        !selected ||
        selected === "undefined" ||
        selected === "null" ||
        selected === "SELECTED" ||
        selected === "ID"
      ) {
        lastInvalid = selected || "EMPTY";
        continue;
      }

      // Verify selection is valid (Strict Mode)
      if (candidates.includes(selected)) {
        return selected;
      }

      // Reject invalid selection and improve loop prompt for next attempt
      logVerbose(`Router rejected invalid selection: "${selected}" (not in candidates)`);
      lastInvalid = selected;

      continue;
    } catch (err) {
      logVerbose(`[RouterLoop] Error during classification attempt ${attempts}: ${String(err)}`);
      if (attempts >= maxAttempts) {
        break;
      } // Break only if max attempts reached? No, break immediately on unexpected error makes sense but we want to know why.
      // actually, if it's a transient network error we might want to continue?
      // But for now, let's just log it so we see it.
      continue;
    }
  }

  logVerbose(`Router failed to select a valid model after ${maxAttempts} attempts.`);
  return null;
}

/**
 * Resolve all available models from config.
 */
function resolveAvailableModels(cfg: VersoConfig): string[] {
  const set = new Set<string>();
  const defaults = cfg.agents?.defaults;

  // Explicit models catalog
  if (defaults?.models) {
    Object.keys(defaults.models).forEach((k) => set.add(k));
  }

  // Primary/Fallback
  if (defaults?.model) {
    const m = defaults.model;
    if (typeof m === "string") {
      // Legacy/Simple support if needed
      set.add(m);
    } else {
      if (m.primary) {
        set.add(m.primary);
      }
      if (m.fallbacks) {
        m.fallbacks.forEach((f) => set.add(f));
      }
    }
  }

  return Array.from(set).filter(
    (m) => m && m !== "undefined" && m !== "null" && !m.endsWith("/undefined"),
  );
}

/**
 * Resolve model using smart router.
 * Returns null if router is disabled or not configured.
 */
export async function resolveRouterModel(params: {
  input: string;
  cfg: VersoConfig;
  defaultProvider: string;
  callClassifier: (params: {
    provider: string;
    model: string;
    prompt: string;
    timeoutMs: number;
  }) => Promise<string>;
  excludeModels?: string[];
}): Promise<RouterModelResult> {
  const { input, cfg, defaultProvider, callClassifier, excludeModels = [] } = params;

  const routerConfig = resolveRouterConfig(cfg);
  if (!routerConfig) {
    logVerbose(`Router is disabled (resolveRouterConfig returned null)`);
    return { routerUsed: false };
  }

  // 1. Skip explicit classification step as requested ("match model itself, not task").
  // We used to call classifyTask here. Now we treat all inputs as "general" or "dynamic"
  // and let the model selector decide purely based on capabilities.
  const _taskType = "general";
  const timeMs = 0;

  // 2. Static Mapping removed. System is Pure Dynamic.
  let resolvedModel: string | undefined;
  let resolvedProvider: string | undefined;

  // Proceed directly to Dynamic Selection

  // 3. Dynamic Selection (if no static match OR static match was excluded)
  if (!resolvedModel) {
    const available = resolveAvailableModels(cfg);
    const candidates = available.filter((m) => !excludeModels.includes(m));

    logVerbose(`Router candidates: ${JSON.stringify(candidates)}`);

    if (candidates.length > 0) {
      const selectedId = await selectDynamicModel({
        input,
        candidates,
        callClassifier,
        classifierModel: routerConfig.classifierModel ?? "",
        timeoutMs: routerConfig.classificationTimeoutMs ?? DEFAULT_CLASSIFICATION_TIMEOUT_MS,
      });

      logVerbose(`Router dynamic selection: ${selectedId}`);

      if (selectedId) {
        const parsed = parseModelRef(selectedId, defaultProvider);
        if (parsed && parsed.provider && parsed.model && parsed.model !== "undefined") {
          resolvedProvider = parsed.provider;
          resolvedModel = parsed.model;
        }
      }
    }
  }

  if (!resolvedModel || !resolvedProvider) {
    return {
      routerUsed: true,
      classificationTimeMs: timeMs,
      error: `No model available (excluded: ${excludeModels.join(", ")})`,
    };
  }

  return {
    routerUsed: true,
    provider: resolvedProvider,
    model: resolvedModel,
    classificationTimeMs: timeMs,
  };
}
