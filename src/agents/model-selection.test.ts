import { describe, it, expect, vi } from "vitest";
import type { VersoConfig } from "../config/config.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import {
  parseModelRef,
  resolveModelRefFromString,
  resolveConfiguredModelRef,
  resolveThinkingDefault,
  buildModelAliasIndex,
  normalizeProviderId,
  modelKey,
} from "./model-selection.js";

describe("model-selection", () => {
  describe("normalizeProviderId", () => {
    it("should normalize provider names", () => {
      expect(normalizeProviderId("Anthropic")).toBe("anthropic");
      expect(normalizeProviderId("Z.ai")).toBe("zai");
      expect(normalizeProviderId("z-ai")).toBe("zai");
      expect(normalizeProviderId("OpenCode-Zen")).toBe("opencode");
      expect(normalizeProviderId("qwen")).toBe("qwen-portal");
      expect(normalizeProviderId("kimi-code")).toBe("kimi-coding");
    });
  });

  describe("parseModelRef", () => {
    it("should parse full model refs", () => {
      expect(parseModelRef("anthropic/claude-3-5-sonnet", "openai")).toEqual({
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      });
    });

    it("normalizes anthropic alias refs to canonical model ids", () => {
      expect(parseModelRef("anthropic/opus-4.6", "openai")).toEqual({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      expect(parseModelRef("opus-4.6", "anthropic")).toEqual({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
    });

    it("should use default provider if none specified", () => {
      expect(parseModelRef("claude-3-5-sonnet", "anthropic")).toEqual({
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      });
    });

    it("should return null for empty strings", () => {
      expect(parseModelRef("", "anthropic")).toBeNull();
      expect(parseModelRef("  ", "anthropic")).toBeNull();
    });

    it("should handle invalid slash usage", () => {
      expect(parseModelRef("/", "anthropic")).toBeNull();
      expect(parseModelRef("anthropic/", "anthropic")).toBeNull();
      expect(parseModelRef("/model", "anthropic")).toBeNull();
    });
  });

  describe("buildModelAliasIndex", () => {
    it("should build alias index from config", () => {
      const cfg: Partial<VersoConfig> = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-3-5-sonnet": { alias: "fast" },
              "openai/gpt-4o": { alias: "smart" },
            },
          },
        },
      };

      const index = buildModelAliasIndex({
        cfg: cfg as VersoConfig,
        defaultProvider: "anthropic",
      });

      expect(index.byAlias.get("fast")?.ref).toEqual({
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      });
      expect(index.byAlias.get("smart")?.ref).toEqual({ provider: "openai", model: "gpt-4o" });
      expect(index.byKey.get(modelKey("anthropic", "claude-3-5-sonnet"))).toEqual(["fast"]);
    });
  });

  describe("resolveModelRefFromString", () => {
    it("should resolve from string with alias", () => {
      const index = {
        byAlias: new Map([
          ["fast", { alias: "fast", ref: { provider: "anthropic", model: "sonnet" } }],
        ]),
        byKey: new Map(),
      };

      const resolved = resolveModelRefFromString({
        raw: "fast",
        defaultProvider: "openai",
        aliasIndex: index,
      });

      expect(resolved?.ref).toEqual({ provider: "anthropic", model: "sonnet" });
      expect(resolved?.alias).toBe("fast");
    });

    it("should resolve direct ref if no alias match", () => {
      const resolved = resolveModelRefFromString({
        raw: "openai/gpt-4",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({ provider: "openai", model: "gpt-4" });
    });
  });

  describe("resolveConfiguredModelRef", () => {
    it("should fall back to anthropic and warn if provider is missing for non-alias", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const cfg: Partial<VersoConfig> = {
        agents: {
          defaults: {
            model: "claude-3-5-sonnet",
          },
        },
      };

      const result = resolveConfiguredModelRef({
        cfg: cfg as VersoConfig,
        defaultProvider: "google",
        defaultModel: "gemini-pro",
      });

      expect(result).toEqual({ provider: "anthropic", model: "claude-3-5-sonnet" });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Falling back to "anthropic/claude-3-5-sonnet"'),
      );
      warnSpy.mockRestore();
    });

    it("should use default provider/model if config is empty", () => {
      const cfg: Partial<VersoConfig> = {};
      const result = resolveConfiguredModelRef({
        cfg: cfg as VersoConfig,
        defaultProvider: "openai",
        defaultModel: "gpt-4",
      });
      expect(result).toEqual({ provider: "openai", model: "gpt-4" });
    });
  });

  describe("resolveThinkingDefault", () => {
    const emptyCfg = {} as VersoConfig;

    it("returns 'off' when model has no reasoning", () => {
      const catalog: ModelCatalogEntry[] = [{ id: "gpt-4o", name: "GPT-4o", provider: "openai" }];
      expect(
        resolveThinkingDefault({ cfg: emptyCfg, provider: "openai", model: "gpt-4o", catalog }),
      ).toBe("off");
    });

    it("returns 'low' when model has reasoning=true but no thinkingLevel", () => {
      const catalog: ModelCatalogEntry[] = [
        { id: "claude-sonnet-4-6", name: "Sonnet", provider: "newapi", reasoning: true },
      ];
      expect(
        resolveThinkingDefault({
          cfg: emptyCfg,
          provider: "newapi",
          model: "claude-sonnet-4-6",
          catalog,
        }),
      ).toBe("low");
    });

    it("returns per-model thinkingLevel when set", () => {
      const catalog: ModelCatalogEntry[] = [
        {
          id: "claude-opus-4-6-thinking",
          name: "Opus Thinking",
          provider: "newapi",
          reasoning: true,
          thinkingLevel: "high",
        },
      ];
      expect(
        resolveThinkingDefault({
          cfg: emptyCfg,
          provider: "newapi",
          model: "claude-opus-4-6-thinking",
          catalog,
        }),
      ).toBe("high");
    });

    it("per-model thinkingLevel overrides generic reasoning=true default", () => {
      const catalog: ModelCatalogEntry[] = [
        { id: "m", name: "M", provider: "p", reasoning: true, thinkingLevel: "medium" },
      ];
      expect(resolveThinkingDefault({ cfg: emptyCfg, provider: "p", model: "m", catalog })).toBe(
        "medium",
      );
    });

    it("global thinkingDefault overrides per-model thinkingLevel", () => {
      const cfg = { agents: { defaults: { thinkingDefault: "minimal" } } } as VersoConfig;
      const catalog: ModelCatalogEntry[] = [
        { id: "m", name: "M", provider: "p", reasoning: true, thinkingLevel: "high" },
      ];
      expect(resolveThinkingDefault({ cfg, provider: "p", model: "m", catalog })).toBe("minimal");
    });

    it("returns 'off' when model not found in catalog", () => {
      expect(
        resolveThinkingDefault({ cfg: emptyCfg, provider: "p", model: "unknown", catalog: [] }),
      ).toBe("off");
    });
  });
});
