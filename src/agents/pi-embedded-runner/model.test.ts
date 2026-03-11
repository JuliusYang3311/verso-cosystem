import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverModels } from "../pi-model-discovery.js";

vi.mock("../pi-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

import type { VersoConfig } from "../../config/config.js";
import { buildInlineProviderModels, resolveModel } from "./model.js";

const makeModel = (id: string) => ({
  id,
  name: id,
  reasoning: false,
  input: ["text"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1,
  maxTokens: 1,
});

beforeEach(() => {
  vi.mocked(discoverModels).mockReturnValue({
    find: vi.fn(() => null),
  } as unknown as ReturnType<typeof discoverModels>);
});

describe("buildInlineProviderModels — resolveDefaultApi", () => {
  it("uses anthropic-messages for 'anthropic' provider", () => {
    const result = buildInlineProviderModels({
      anthropic: { models: [makeModel("claude")] },
    } as unknown as Record<string, unknown>);
    expect(result[0].api).toBe("anthropic-messages");
  });

  it("uses google-generative-ai for 'google' provider", () => {
    const result = buildInlineProviderModels({
      google: { models: [makeModel("gemini")] },
    } as unknown as Record<string, unknown>);
    expect(result[0].api).toBe("google-generative-ai");
  });

  it("uses bedrock-converse-stream for 'bedrock' provider", () => {
    const result = buildInlineProviderModels({
      bedrock: { models: [makeModel("titan")] },
    } as unknown as Record<string, unknown>);
    expect(result[0].api).toBe("bedrock-converse-stream");
  });

  it("uses github-copilot for 'copilot' provider", () => {
    const result = buildInlineProviderModels({
      copilot: { models: [makeModel("gpt-4")] },
    } as unknown as Record<string, unknown>);
    expect(result[0].api).toBe("github-copilot");
  });

  it("defaults to openai-responses for unknown provider names", () => {
    const result = buildInlineProviderModels({
      newapi: { models: [makeModel("some-model")] },
    } as unknown as Record<string, unknown>);
    expect(result[0].api).toBe("openai-responses");
  });
});

describe("buildInlineProviderModels", () => {
  it("attaches provider ids to inline models", () => {
    const providers = {
      " alpha ": { baseUrl: "http://alpha.local", models: [makeModel("alpha-model")] },
      beta: { baseUrl: "http://beta.local", models: [makeModel("beta-model")] },
    };

    const result = buildInlineProviderModels(providers as unknown as Record<string, unknown>);

    expect(result).toEqual([
      {
        ...makeModel("alpha-model"),
        provider: "alpha",
        baseUrl: "http://alpha.local",
        api: "openai-responses",
      },
      {
        ...makeModel("beta-model"),
        provider: "beta",
        baseUrl: "http://beta.local",
        api: "openai-responses",
      },
    ]);
  });

  it("inherits baseUrl from provider when model does not specify it", () => {
    const providers = {
      custom: {
        baseUrl: "http://localhost:8000",
        models: [makeModel("custom-model")],
      },
    };

    const result = buildInlineProviderModels(providers as unknown as Record<string, unknown>);

    expect(result).toHaveLength(1);
    expect(result[0].baseUrl).toBe("http://localhost:8000");
  });

  it("inherits api from provider when model does not specify it", () => {
    const providers = {
      custom: {
        baseUrl: "http://localhost:8000",
        api: "anthropic-messages",
        models: [makeModel("custom-model")],
      },
    };

    const result = buildInlineProviderModels(providers as unknown as Record<string, unknown>);

    expect(result).toHaveLength(1);
    expect(result[0].api).toBe("anthropic-messages");
  });

  it("model-level api takes precedence over provider-level api", () => {
    const providers = {
      custom: {
        baseUrl: "http://localhost:8000",
        api: "openai-responses",
        models: [{ ...makeModel("custom-model"), api: "anthropic-messages" as const }],
      },
    };

    const result = buildInlineProviderModels(providers as unknown as Record<string, unknown>);

    expect(result).toHaveLength(1);
    expect(result[0].api).toBe("anthropic-messages");
  });

  it("inherits both baseUrl and api from provider config", () => {
    const providers = {
      custom: {
        baseUrl: "http://localhost:10000",
        api: "anthropic-messages",
        models: [makeModel("claude-opus-4.5")],
      },
    };

    const result = buildInlineProviderModels(providers as unknown as Record<string, unknown>);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      provider: "custom",
      baseUrl: "http://localhost:10000",
      api: "anthropic-messages",
      name: "claude-opus-4.5",
    });
  });
});

describe("resolveModel", () => {
  it("includes provider baseUrl in fallback model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [],
          },
        },
      },
    } as VersoConfig;

    const result = resolveModel("custom", "missing-model", "/tmp/agent", cfg);

    expect(result.model?.baseUrl).toBe("http://localhost:9000");
    expect(result.model?.provider).toBe("custom");
    expect(result.model?.id).toBe("missing-model");
  });

  it("builds an openai-codex fallback for gpt-5.3-codex", () => {
    const templateModel = {
      id: "gpt-5.2-codex",
      name: "GPT-5.2 Codex",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"] as const,
      cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
      contextWindow: 272000,
      maxTokens: 128000,
    };

    vi.mocked(discoverModels).mockReturnValue({
      find: vi.fn((provider: string, modelId: string) => {
        if (provider === "openai-codex" && modelId === "gpt-5.2-codex") {
          return templateModel;
        }
        return null;
      }),
    } as unknown as ReturnType<typeof discoverModels>);

    const result = resolveModel("openai-codex", "gpt-5.3-codex", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.3-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      contextWindow: 272000,
      maxTokens: 128000,
    });
  });

  it("builds an anthropic forward-compat fallback for claude-opus-4-6", () => {
    const templateModel = {
      id: "claude-opus-4-5",
      name: "Claude Opus 4.5",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"] as const,
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 200000,
      maxTokens: 64000,
    };

    vi.mocked(discoverModels).mockReturnValue({
      find: vi.fn((provider: string, modelId: string) => {
        if (provider === "anthropic" && modelId === "claude-opus-4-5") {
          return templateModel;
        }
        return null;
      }),
    } as unknown as ReturnType<typeof discoverModels>);

    const result = resolveModel("anthropic", "claude-opus-4-6", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "anthropic",
      id: "claude-opus-4-6",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
    });
  });

  it("keeps unknown-model errors for non-gpt-5 openai-codex ids", () => {
    const result = resolveModel("openai-codex", "gpt-4.1-mini", "/tmp/agent");
    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: openai-codex/gpt-4.1-mini");
  });

  it("resolves custom provider with anthropic api correctly", () => {
    const cfg = {
      models: {
        providers: {
          newapi: {
            baseUrl: "http://47.253.7.24:3000/",
            api: "anthropic-messages",
            models: [makeModel("my-claude")],
          },
        },
      },
    } as VersoConfig;

    const result = resolveModel("newapi", "my-claude", "/tmp/agent", cfg);

    expect(result.model).toBeDefined();
    expect(result.model?.api).toBe("anthropic-messages");
    expect(result.model?.baseUrl).toBe("http://47.253.7.24:3000/");
    expect(result.model?.provider).toBe("newapi");
  });

  it("custom provider fallback uses provider-level api, not openai default", () => {
    const cfg = {
      models: {
        providers: {
          newapi: {
            baseUrl: "http://47.253.7.24:3000/",
            api: "anthropic-messages",
            models: [],
          },
        },
      },
    } as VersoConfig;

    // Model not in models list → falls through to fallback path
    const result = resolveModel("newapi", "unknown-model", "/tmp/agent", cfg);

    expect(result.model).toBeDefined();
    expect(result.model?.api).toBe("anthropic-messages");
    expect(result.model?.id).toBe("unknown-model");
  });

  it("custom provider without api field falls back to openai-responses", () => {
    const cfg = {
      models: {
        providers: {
          newapi: {
            baseUrl: "http://example.com",
            models: [makeModel("test-model")],
          },
        },
      },
    } as VersoConfig;

    const result = resolveModel("newapi", "test-model", "/tmp/agent", cfg);

    expect(result.model?.api).toBe("openai-responses");
  });

  it("uses codex fallback even when openai-codex provider is configured", () => {
    const cfg: VersoConfig = {
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://custom.example.com",
          },
        },
      },
    } as VersoConfig;

    vi.mocked(discoverModels).mockReturnValue({
      find: vi.fn(() => null),
    } as unknown as ReturnType<typeof discoverModels>);

    const result = resolveModel("openai-codex", "gpt-5.3-codex", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.api).toBe("openai-codex-responses");
    expect(result.model?.id).toBe("gpt-5.3-codex");
    expect(result.model?.provider).toBe("openai-codex");
  });
});
