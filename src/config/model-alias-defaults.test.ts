import { describe, expect, it } from "vitest";
import type { VersoConfig } from "./types.js";
import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import { applyModelDefaults } from "./defaults.js";
import { ModelDefinitionSchema } from "./zod-schema.core.js";

describe("applyModelDefaults", () => {
  it("adds default aliases when models are present", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": {},
            "openai/gpt-5.2": {},
          },
        },
      },
    } satisfies VersoConfig;
    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["anthropic/claude-opus-4-6"]?.alias).toBe("opus");
    expect(next.agents?.defaults?.models?.["openai/gpt-5.2"]?.alias).toBe("gpt");
  });

  it("does not override existing aliases", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-5": { alias: "Opus" },
          },
        },
      },
    } satisfies VersoConfig;

    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]?.alias).toBe("Opus");
  });

  it("respects explicit empty alias disables", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "google/gemini-3.1-pro-preview": { alias: "" },
            "google/gemini-3.1-flash-lite-preview": {},
          },
        },
      },
    } satisfies VersoConfig;

    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["google/gemini-3.1-pro-preview"]?.alias).toBe("");
    expect(next.agents?.defaults?.models?.["google/gemini-3.1-flash-lite-preview"]?.alias).toBe(
      "gemini-flash",
    );
  });

  it("fills missing model provider defaults", () => {
    const cfg = {
      models: {
        providers: {
          myproxy: {
            baseUrl: "https://proxy.example/v1",
            apiKey: "sk-test",
            api: "openai-completions",
            models: [{ id: "gpt-5.2", name: "GPT-5.2" }],
          },
        },
      },
    } satisfies VersoConfig;

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.myproxy?.models?.[0];

    expect(model?.reasoning).toBe(false);
    expect(model?.input).toEqual(["text"]);
    expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(model?.contextWindow).toBe(DEFAULT_CONTEXT_TOKENS);
    expect(model?.maxTokens).toBe(8192);
  });

  it("clamps maxTokens to contextWindow", () => {
    const cfg = {
      models: {
        providers: {
          myproxy: {
            api: "openai-completions",
            models: [{ id: "gpt-5.2", name: "GPT-5.2", contextWindow: 32768, maxTokens: 40960 }],
          },
        },
      },
    } satisfies VersoConfig;

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.myproxy?.models?.[0];

    expect(model?.contextWindow).toBe(32768);
    expect(model?.maxTokens).toBe(32768);
  });

  it("preserves thinkingLevel through applyModelDefaults", () => {
    const cfg = {
      models: {
        providers: {
          newapi: {
            baseUrl: "https://code.z-daha.cc/",
            api: "anthropic-messages",
            models: [
              {
                id: "claude-opus-4-6-thinking",
                name: "claude-opus-4-6-thinking",
                reasoning: true,
                thinkingLevel: "high",
                input: ["text", "image"],
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } satisfies VersoConfig;

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.newapi?.models?.[0];

    expect(model?.thinkingLevel).toBe("high");
    expect(model?.reasoning).toBe(true);
    expect(model?.input).toEqual(["text", "image"]);
  });
});

describe("ModelDefinitionSchema (zod)", () => {
  it("accepts thinkingLevel field", () => {
    const result = ModelDefinitionSchema.safeParse({
      id: "test",
      name: "test",
      reasoning: true,
      thinkingLevel: "high",
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(result.success).toBe(true);
    expect(result.data?.thinkingLevel).toBe("high");
  });

  it("rejects unknown fields (strict mode still works)", () => {
    const result = ModelDefinitionSchema.safeParse({
      id: "test",
      name: "test",
      unknownField: "should-fail",
    });
    expect(result.success).toBe(false);
  });

  it("allows model without thinkingLevel", () => {
    const result = ModelDefinitionSchema.safeParse({
      id: "test",
      name: "test",
      reasoning: false,
      input: ["text"],
      contextWindow: 200000,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(result.success).toBe(true);
    expect(result.data?.thinkingLevel).toBeUndefined();
  });
});
