import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------- Mocks ----------

const mockLoadConfig = vi.fn(() => ({}));
vi.mock("../config/config.js", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

const mockResolveConfiguredModelRef = vi.fn();
vi.mock("../agents/model-selection.js", () => ({
  resolveConfiguredModelRef: (...args: unknown[]) => mockResolveConfiguredModelRef(...args),
}));

const mockResolveModel = vi.fn();
vi.mock("../agents/pi-embedded-runner/model.js", () => ({
  resolveModel: (...args: unknown[]) => mockResolveModel(...args),
}));

const mockResolveApiKeyForProvider = vi.fn();
vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: (...args: unknown[]) => mockResolveApiKeyForProvider(...args),
}));

const mockResolveOpenClawAgentDir = vi.fn(() => "/mock/agent-dir");
vi.mock("../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: (...args: unknown[]) => mockResolveOpenClawAgentDir(...args),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { resolveAgentModel } = await import("./acceptance-model.js");

// ---------- Tests ----------

describe("acceptance-model", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.EVOLVER_MODEL = process.env.EVOLVER_MODEL;
    savedEnv.EVOLVER_AGENT_DIR = process.env.EVOLVER_AGENT_DIR;
    delete process.env.EVOLVER_MODEL;
    delete process.env.EVOLVER_AGENT_DIR;

    mockLoadConfig.mockReturnValue({});
    mockResolveConfiguredModelRef.mockReturnValue({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });
    const fakeAuthStorage = { setRuntimeApiKey: vi.fn() };
    mockResolveModel.mockReturnValue({
      model: { id: "fake-model" },
      error: undefined,
      authStorage: fakeAuthStorage,
      modelRegistry: { id: "fake-registry" },
    });
    mockResolveApiKeyForProvider.mockResolvedValue({ apiKey: "sk-test-key" });
  });

  afterEach(() => {
    process.env.EVOLVER_MODEL = savedEnv.EVOLVER_MODEL;
    process.env.EVOLVER_AGENT_DIR = savedEnv.EVOLVER_AGENT_DIR;
    vi.restoreAllMocks();
  });

  describe("EVOLVER_MODEL env var parsing", () => {
    it("uses provider/modelId from EVOLVER_MODEL when set", async () => {
      process.env.EVOLVER_MODEL = "openai/gpt-4o";

      await resolveAgentModel();

      expect(mockResolveModel).toHaveBeenCalledWith(
        "openai",
        "gpt-4o",
        expect.any(String),
        expect.anything(),
      );
      expect(mockResolveConfiguredModelRef).not.toHaveBeenCalled();
    });

    it("splits on first / only (JS split limit gives 2 parts)", async () => {
      process.env.EVOLVER_MODEL = "custom/my-model";

      await resolveAgentModel();

      expect(mockResolveModel).toHaveBeenCalledWith(
        "custom",
        "my-model",
        expect.any(String),
        expect.anything(),
      );
    });
  });

  describe("default model fallback", () => {
    it("falls back to resolveConfiguredModelRef when EVOLVER_MODEL is unset", async () => {
      mockResolveConfiguredModelRef.mockReturnValue({
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
      });

      await resolveAgentModel();

      expect(mockResolveConfiguredModelRef).toHaveBeenCalledWith({
        cfg: {},
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-20250514",
      });
      expect(mockResolveModel).toHaveBeenCalledWith(
        "anthropic",
        "claude-sonnet-4-20250514",
        expect.any(String),
        expect.anything(),
      );
    });

    it("falls back when EVOLVER_MODEL has no slash", async () => {
      process.env.EVOLVER_MODEL = "no-slash-model";

      await resolveAgentModel();

      expect(mockResolveConfiguredModelRef).toHaveBeenCalled();
    });
  });

  describe("auth injection", () => {
    it("calls setRuntimeApiKey when auth resolves with apiKey", async () => {
      const fakeAuthStorage = { setRuntimeApiKey: vi.fn() };
      mockResolveModel.mockReturnValue({
        model: { id: "m" },
        error: undefined,
        authStorage: fakeAuthStorage,
        modelRegistry: {},
      });
      mockResolveApiKeyForProvider.mockResolvedValue({ apiKey: "sk-injected" });

      await resolveAgentModel();

      expect(fakeAuthStorage.setRuntimeApiKey).toHaveBeenCalledWith("anthropic", "sk-injected");
    });

    it("does not call setRuntimeApiKey when apiKey is missing", async () => {
      const fakeAuthStorage = { setRuntimeApiKey: vi.fn() };
      mockResolveModel.mockReturnValue({
        model: { id: "m" },
        error: undefined,
        authStorage: fakeAuthStorage,
        modelRegistry: {},
      });
      mockResolveApiKeyForProvider.mockResolvedValue({});

      await resolveAgentModel();

      expect(fakeAuthStorage.setRuntimeApiKey).not.toHaveBeenCalled();
    });

    it("silently ignores auth resolution failure", async () => {
      const fakeAuthStorage = { setRuntimeApiKey: vi.fn() };
      mockResolveModel.mockReturnValue({
        model: { id: "m" },
        error: undefined,
        authStorage: fakeAuthStorage,
        modelRegistry: {},
      });
      mockResolveApiKeyForProvider.mockRejectedValue(new Error("no key found"));

      const result = await resolveAgentModel();

      expect(result.model).toEqual({ id: "m" });
      expect(fakeAuthStorage.setRuntimeApiKey).not.toHaveBeenCalled();
    });
  });

  describe("model resolution failure", () => {
    it("throws when resolveModel returns error", async () => {
      mockResolveModel.mockReturnValue({
        model: undefined,
        error: "Provider not found",
        authStorage: {},
        modelRegistry: {},
      });

      await expect(resolveAgentModel()).rejects.toThrow("Failed to resolve acceptance model");
    });

    it("throws when resolveModel returns no model", async () => {
      mockResolveModel.mockReturnValue({
        model: null,
        error: undefined,
        authStorage: {},
        modelRegistry: {},
      });

      await expect(resolveAgentModel()).rejects.toThrow("Failed to resolve acceptance model");
    });
  });

  describe("agentDir resolution", () => {
    it("uses EVOLVER_AGENT_DIR env when set", async () => {
      process.env.EVOLVER_AGENT_DIR = "/custom/agent/dir";

      await resolveAgentModel();

      expect(mockResolveModel).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        "/custom/agent/dir",
        expect.anything(),
      );
    });

    it("falls back to resolveOpenClawAgentDir when EVOLVER_AGENT_DIR is unset", async () => {
      mockResolveOpenClawAgentDir.mockReturnValue("/fallback/dir");

      await resolveAgentModel();

      expect(mockResolveOpenClawAgentDir).toHaveBeenCalled();
      expect(mockResolveModel).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        "/fallback/dir",
        expect.anything(),
      );
    });

    it("returns agentDir in result", async () => {
      process.env.EVOLVER_AGENT_DIR = "/my/dir";

      const result = await resolveAgentModel();

      expect(result.agentDir).toBe("/my/dir");
    });
  });
});
