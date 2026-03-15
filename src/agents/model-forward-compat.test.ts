import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { ModelRegistry } from "./pi-model-discovery.js";
import {
  resolveForwardCompatModel,
  resolveGemini3ForwardCompatModel,
} from "./model-forward-compat.js";
import { resolveModel, buildInlineProviderModels } from "./pi-embedded-runner/model.js";

// ── Helpers ──────────────────────────────────────────────────────────

/** Minimal stub registry: only returns models explicitly registered. */
function createStubRegistry(
  entries: Array<{ provider: string; id: string; model?: Partial<Model<Api>> }> = [],
): ModelRegistry {
  const map = new Map<string, Model<Api>>();
  for (const e of entries) {
    const key = `${e.provider}/${e.id}`;
    map.set(key, {
      id: e.id,
      name: e.model?.name ?? e.id,
      provider: e.provider,
      api: e.model?.api ?? ("openai-responses" as Api),
      reasoning: e.model?.reasoning ?? false,
      input: e.model?.input ?? ["text"],
      cost: e.model?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: e.model?.contextWindow ?? 200_000,
      maxTokens: e.model?.maxTokens ?? 8_192,
      ...e.model,
    } as Model<Api>);
  }
  return {
    find: (provider: string, modelId: string) => map.get(`${provider}/${modelId}`) ?? null,
    getAll: () => [...map.values()],
  } as ModelRegistry;
}

// ── OpenAI forward-compat ────────────────────────────────────────────

describe("OpenAI forward-compat", () => {
  it("resolves gpt-5.4 via openai-codex provider with correct specs", () => {
    const registry = createStubRegistry([
      {
        provider: "openai-codex",
        id: "gpt-5.3-codex",
        model: { api: "openai-codex-responses" as Api },
      },
    ]);
    const result = resolveForwardCompatModel("openai-codex", "gpt-5.4", registry);
    expect(result).toBeDefined();
    expect(result!.id).toBe("gpt-5.4");
    expect(result!.api).toBe("openai-responses");
    expect(result!.contextWindow).toBe(1_050_000);
    expect(result!.maxTokens).toBe(128_000);
  });

  it("resolves gpt-5.4 via openai provider", () => {
    const registry = createStubRegistry([]);
    const result = resolveForwardCompatModel("openai", "gpt-5.4", registry);
    expect(result).toBeDefined();
    expect(result!.id).toBe("gpt-5.4");
    expect(result!.api).toBe("openai-responses");
  });

  it("resolves gpt-5.4 even with no templates (synthetic fallback)", () => {
    const registry = createStubRegistry([]);
    const result = resolveForwardCompatModel("openai-codex", "gpt-5.4", registry);
    expect(result).toBeDefined();
    expect(result!.contextWindow).toBe(1_050_000);
    expect(result!.maxTokens).toBe(128_000);
    expect(result!.reasoning).toBe(true);
  });

  it("resolves gpt-5.3-codex with correct specs", () => {
    const registry = createStubRegistry([{ provider: "openai-codex", id: "gpt-5.2-codex" }]);
    const result = resolveForwardCompatModel("openai-codex", "gpt-5.3-codex", registry);
    expect(result).toBeDefined();
    expect(result!.id).toBe("gpt-5.3-codex");
    expect(result!.api).toBe("openai-codex-responses");
    expect(result!.contextWindow).toBe(1_048_576);
  });

  it("resolves gpt-5.3 (non-codex) with correct API", () => {
    const registry = createStubRegistry([]);
    const result = resolveForwardCompatModel("openai-codex", "gpt-5.3", registry);
    expect(result).toBeDefined();
    expect(result!.api).toBe("openai-responses");
    expect(result!.contextWindow).toBe(1_048_576);
  });

  it("returns undefined for unknown openai model IDs", () => {
    const registry = createStubRegistry([]);
    expect(resolveForwardCompatModel("openai-codex", "gpt-99", registry)).toBeUndefined();
  });

  it("returns undefined for non-openai providers", () => {
    const registry = createStubRegistry([]);
    expect(resolveForwardCompatModel("anthropic", "gpt-5.4", registry)).toBeUndefined();
  });
});

// ── Anthropic forward-compat ─────────────────────────────────────────

describe("Anthropic forward-compat", () => {
  it("resolves claude-opus-4-6 from opus-4-5 template", () => {
    const registry = createStubRegistry([
      {
        provider: "anthropic",
        id: "claude-opus-4-5",
        model: { api: "anthropic-messages" as Api, contextWindow: 200_000 },
      },
    ]);
    const result = resolveForwardCompatModel("anthropic", "claude-opus-4-6", registry);
    expect(result).toBeDefined();
    expect(result!.id).toBe("claude-opus-4-6");
    expect(result!.api).toBe("anthropic-messages");
  });

  it("resolves claude-opus-4.6 (dot notation)", () => {
    const registry = createStubRegistry([
      {
        provider: "anthropic",
        id: "claude-opus-4.5",
        model: { api: "anthropic-messages" as Api },
      },
    ]);
    const result = resolveForwardCompatModel("anthropic", "claude-opus-4.6", registry);
    expect(result).toBeDefined();
    expect(result!.id).toBe("claude-opus-4.6");
  });

  it("returns undefined for non-anthropic provider", () => {
    const registry = createStubRegistry([]);
    expect(resolveForwardCompatModel("openai", "claude-opus-4-6", registry)).toBeUndefined();
  });
});

// ── Google Gemini forward-compat ─────────────────────────────────────

describe("Google Gemini forward-compat", () => {
  it("resolves gemini-3.1-pro-preview with reasoning=true", () => {
    const registry = createStubRegistry([]);
    const result = resolveGemini3ForwardCompatModel("google", "gemini-3.1-pro-preview", registry);
    expect(result).toBeDefined();
    expect(result!.id).toBe("gemini-3.1-pro-preview");
    expect(result!.api).toBe("google-generative-ai");
    expect(result!.reasoning).toBe(true);
    expect(result!.contextWindow).toBe(1_048_576);
  });

  it("resolves gemini-3.1-flash-lite-preview with reasoning=false", () => {
    const registry = createStubRegistry([]);
    const result = resolveGemini3ForwardCompatModel(
      "google",
      "gemini-3.1-flash-lite-preview",
      registry,
    );
    expect(result).toBeDefined();
    expect(result!.reasoning).toBe(false);
  });

  it("uses google-antigravity API for antigravity provider", () => {
    const registry = createStubRegistry([]);
    const result = resolveGemini3ForwardCompatModel(
      "google-antigravity",
      "gemini-3.1-pro-preview",
      registry,
    );
    expect(result).toBeDefined();
    expect(result!.api).toBe("google-antigravity");
  });

  it("returns undefined for non-google provider", () => {
    const registry = createStubRegistry([]);
    expect(
      resolveGemini3ForwardCompatModel("openai", "gemini-3.1-pro-preview", registry),
    ).toBeUndefined();
  });

  it("returns undefined for unknown gemini model", () => {
    const registry = createStubRegistry([]);
    expect(resolveGemini3ForwardCompatModel("google", "gemini-99", registry)).toBeUndefined();
  });
});

// ── Custom model routing (inline providers) ──────────────────────────

describe("Custom model routing via inline providers", () => {
  it("routes a user-added custom openai model with correct API", () => {
    const models = buildInlineProviderModels({
      "my-openai": {
        baseUrl: "https://api.openai.com/v1",
        api: "openai-responses",
        models: [
          {
            id: "gpt-6.0",
            name: "GPT-6.0",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 2_000_000,
            maxTokens: 256_000,
          },
        ],
      },
    });
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("gpt-6.0");
    expect(models[0].api).toBe("openai-responses");
    expect(models[0].provider).toBe("my-openai");
    expect(models[0].contextWindow).toBe(2_000_000);
  });

  it("routes a custom anthropic model with correct API", () => {
    const models = buildInlineProviderModels({
      "custom-anthropic": {
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
        models: [
          {
            id: "claude-opus-5-0",
            name: "Claude Opus 5.0",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 2_000_000,
            maxTokens: 256_000,
          },
        ],
      },
    });
    expect(models[0].api).toBe("anthropic-messages");
    expect(models[0].provider).toBe("custom-anthropic");
  });

  it("routes a custom google model with correct API", () => {
    const models = buildInlineProviderModels({
      google: {
        baseUrl: "https://generativelanguage.googleapis.com",
        api: "google-generative-ai",
        models: [
          {
            id: "gemini-4.0-ultra",
            name: "Gemini 4.0 Ultra",
            reasoning: true,
            input: ["text", "image", "video"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4_000_000,
            maxTokens: 512_000,
          },
        ],
      },
    });
    expect(models[0].api).toBe("google-generative-ai");
    expect(models[0].contextWindow).toBe(4_000_000);
  });

  it("defaults to openai-responses when no API specified", () => {
    const models = buildInlineProviderModels({
      "some-provider": {
        baseUrl: "https://example.com/v1",
        models: [
          {
            id: "custom-model",
            name: "Custom",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 8_192,
          },
        ],
      },
    });
    expect(models[0].api).toBe("openai-responses");
  });

  it("uses provider-level API for anthropic", () => {
    const models = buildInlineProviderModels({
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        models: [
          {
            id: "future-claude",
            name: "Future Claude",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 8_192,
          },
        ],
      },
    });
    // anthropic provider without explicit api → resolveDefaultApi("anthropic") = "anthropic-messages"
    expect(models[0].api).toBe("anthropic-messages");
  });

  it("preserves model metadata through the pipeline", () => {
    const models = buildInlineProviderModels({
      "my-provider": {
        baseUrl: "https://example.com",
        api: "openai-responses",
        models: [
          {
            id: "test-model",
            name: "Test Model",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.5 },
            contextWindow: 500_000,
            maxTokens: 50_000,
          },
        ],
      },
    });
    const m = models[0];
    expect(m.reasoning).toBe(true);
    expect(m.input).toEqual(["text", "image"]);
    expect(m.cost).toEqual({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.5 });
    expect(m.contextWindow).toBe(500_000);
    expect(m.maxTokens).toBe(50_000);
    expect(m.baseUrl).toBe("https://example.com");
  });
});

// ── Full resolveModel integration ────────────────────────────────────

describe("resolveModel end-to-end", () => {
  it("resolves a custom model defined in verso.json providers", () => {
    const cfg = {
      models: {
        providers: {
          "my-openai": {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses" as const,
            models: [
              {
                id: "gpt-future",
                name: "GPT Future",
                reasoning: true,
                input: ["text" as const, "image" as const],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 2_000_000,
                maxTokens: 256_000,
              },
            ],
          },
        },
      },
    };
    const { model, error } = resolveModel("my-openai", "gpt-future", undefined, cfg as any);
    expect(error).toBeUndefined();
    expect(model).toBeDefined();
    expect(model!.id).toBe("gpt-future");
    expect(model!.api).toBe("openai-responses");
    expect(model!.contextWindow).toBe(2_000_000);
  });

  it("applies global contextTokens cap to custom models", () => {
    const cfg = {
      agents: { defaults: { contextTokens: 100_000 } },
      models: {
        providers: {
          "my-provider": {
            baseUrl: "https://example.com",
            api: "openai-responses" as const,
            models: [
              {
                id: "big-model",
                name: "Big",
                reasoning: false,
                input: ["text" as const],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_000_000,
                maxTokens: 100_000,
              },
            ],
          },
        },
      },
    };
    const { model } = resolveModel("my-provider", "big-model", undefined, cfg as any);
    expect(model).toBeDefined();
    // contextWindow should be capped by agents.defaults.contextTokens
    expect(model!.contextWindow).toBe(100_000);
  });

  it("falls back gracefully for unknown models in known providers", () => {
    const cfg = {
      models: {
        providers: {
          "custom-openai": {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses" as const,
            models: [],
          },
        },
      },
    };
    // Model not in the models list, but provider exists → generic fallback
    const { model, error } = resolveModel("custom-openai", "gpt-99-turbo", undefined, cfg as any);
    expect(error).toBeUndefined();
    expect(model).toBeDefined();
    expect(model!.id).toBe("gpt-99-turbo");
    expect(model!.api).toBe("openai-responses");
  });

  it("returns error for completely unknown provider + model", () => {
    const { model, error } = resolveModel("nonexistent", "fake-model", undefined, {} as any);
    expect(model).toBeUndefined();
    expect(error).toContain("Unknown model");
  });
});
