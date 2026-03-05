import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VersoConfig } from "../../config/config.js";
import { resolveModel } from "./model.js";

// Mock dependencies
vi.mock("../pi-model-discovery.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    discoverAuthStorage: vi.fn(() => ({
      getRuntimeApiKey: vi.fn(),
      getStoredApiKey: vi.fn(),
    })),
    discoverModels: vi.fn(() => ({
      find: vi.fn(),
      getAll: vi.fn(() => []),
    })),
  };
});

vi.mock("../agent-paths.js", () => ({
  resolveVersoAgentDir: vi.fn(() => "/tmp/test-agent-dir"),
}));

describe("resolveModel for google-antigravity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should resolve google-antigravity/gemini-3.1-flash-lite-preview correctly", () => {
    const result = resolveModel(
      "google-antigravity",
      "google-antigravity/gemini-3.1-flash-lite-preview",
      "/tmp/test-agent-dir",
      { agents: { defaults: { contextTokens: 2000000 } } } as Partial<VersoConfig> as VersoConfig,
    );

    expect(result.model).toBeDefined();
    if (result.model) {
      expect(result.model.id).toBe("gemini-3.1-flash-lite-preview");
      expect(result.model.provider).toBe("google-antigravity");
      // This is the CRITICAL check for the 404 fix:
      expect(result.model.api).toBe("google-antigravity");
      expect(result.model.baseUrl).toBe("https://cloudcode-pa.googleapis.com");
    }
  });

  it("should resolve shorthand gemini-3.1-flash-lite-preview correctly", () => {
    const result = resolveModel(
      "google-antigravity",
      "gemini-3.1-flash-lite-preview",
      "/tmp/test-agent-dir",
      {} as Partial<VersoConfig> as VersoConfig,
    );

    expect(result.model).toBeDefined();
    if (result.model) {
      expect(result.model.id).toBe("gemini-3.1-flash-lite-preview");
      expect(result.model.provider).toBe("google-antigravity");
      expect(result.model.api).toBe("google-antigravity");
    }
  });
});
