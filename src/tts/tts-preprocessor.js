import { completeSimple } from "@mariozechner/pi-ai";
import { getApiKeyForModel, requireApiKey } from "../agents/model-auth.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
// ---------------------------------------------------------------------------
// Summary model resolution
// ---------------------------------------------------------------------------
export function resolveSummaryModelRef(cfg, config) {
  const defaultRef = resolveDefaultModelForAgent({ cfg });
  const override = config.summaryModel?.trim();
  if (!override) {
    return { ref: defaultRef, source: "default" };
  }
  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: defaultRef.provider });
  const resolved = resolveModelRefFromString({
    raw: override,
    defaultProvider: defaultRef.provider,
    aliasIndex,
  });
  if (!resolved) {
    return { ref: defaultRef, source: "default" };
  }
  return { ref: resolved.ref, source: "summaryModel" };
}
// ---------------------------------------------------------------------------
// Text content filter
// ---------------------------------------------------------------------------
function isTextContentBlock(block) {
  return block.type === "text";
}
// ---------------------------------------------------------------------------
// Summarizer
// ---------------------------------------------------------------------------
export async function summarizeText(params) {
  const { text, targetLength, cfg, config, timeoutMs } = params;
  if (targetLength < 100 || targetLength > 10_000) {
    throw new Error(`Invalid targetLength: ${targetLength}`);
  }
  const startTime = Date.now();
  const { ref } = resolveSummaryModelRef(cfg, config);
  const resolved = resolveModel(ref.provider, ref.model, undefined, cfg);
  if (!resolved.model) {
    throw new Error(resolved.error ?? `Unknown summary model: ${ref.provider}/${ref.model}`);
  }
  const apiKey = requireApiKey(
    await getApiKeyForModel({ model: resolved.model, cfg }),
    ref.provider,
  );
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await completeSimple(
        resolved.model,
        {
          messages: [
            {
              role: "user",
              content:
                `You are an assistant that summarizes texts concisely while keeping the most important information. ` +
                `Summarize the text to approximately ${targetLength} characters. Maintain the original tone and style. ` +
                `Reply only with the summary, without additional explanations.\n\n` +
                `<text_to_summarize>\n${text}\n</text_to_summarize>`,
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
          maxTokens: Math.ceil(targetLength / 2),
          temperature: 0.3,
          signal: controller.signal,
        },
      );
      const summary = res.content
        .filter(isTextContentBlock)
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join(" ")
        .trim();
      if (!summary) {
        throw new Error("No summary returned");
      }
      return {
        summary,
        latencyMs: Date.now() - startTime,
        inputLength: text.length,
        outputLength: summary.length,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const error = err;
    if (error.name === "AbortError") {
      throw new Error("Summarization timed out", { cause: err });
    }
    throw err;
  }
}
