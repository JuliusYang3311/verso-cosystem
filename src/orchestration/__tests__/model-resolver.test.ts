// src/orchestration/__tests__/model-resolver.test.ts — Unit tests for model resolution

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveAgentModel } from "../model-resolver.js";

describe("Model Resolver", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("resolveAgentModel", () => {
    it("should resolve model from ORCHESTRATOR_MODEL env var", async () => {
      process.env.ORCHESTRATOR_MODEL = "anthropic/claude-opus-4-20250514";

      const result = await resolveAgentModel();

      expect(result.model).toBeDefined();
      expect(result.authStorage).toBeDefined();
      expect(result.modelRegistry).toBeDefined();
      expect(result.embeddingProvider).toBeDefined();
    });

    it("should fall back to config defaults when env var not set", async () => {
      delete process.env.ORCHESTRATOR_MODEL;

      const result = await resolveAgentModel();

      expect(result.model).toBeDefined();
      expect(result.authStorage).toBeDefined();
      expect(result.modelRegistry).toBeDefined();
      expect(result.embeddingProvider).toBeDefined();
    });

    it("should resolve embedding provider", async () => {
      const result = await resolveAgentModel();

      expect(result.embeddingProvider).toBeDefined();
      expect(result.embeddingProvider.provider).toBeDefined();
    });

    it("should handle custom provider with auth injection", async () => {
      process.env.ORCHESTRATOR_MODEL = "newapi/custom-model";

      const result = await resolveAgentModel();

      expect(result.model).toBeDefined();
      expect(result.authStorage).toBeDefined();
    });

    it("should throw error for invalid model format", async () => {
      process.env.ORCHESTRATOR_MODEL = "invalid/provider/format/too/many/slashes";

      await expect(resolveAgentModel()).rejects.toThrow();
    });
  });
});
