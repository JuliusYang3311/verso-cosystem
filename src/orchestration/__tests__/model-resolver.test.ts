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
    it("should throw error for invalid model format", async () => {
      process.env.ORCHESTRATOR_MODEL = "invalid/provider/format/too/many/slashes";

      await expect(resolveAgentModel()).rejects.toThrow();
    });

    // Note: Other tests require API keys and are tested in integration tests
    // These would include:
    // - Resolving model from ORCHESTRATOR_MODEL env var
    // - Falling back to config defaults
    // - Resolving embedding provider
    // - Handling custom providers with auth injection
  });
});
