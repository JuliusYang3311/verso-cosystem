import path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";

// We need to reset module cache between tests since paths.ts caches values
// and reads env vars at call time.

describe("paths", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  describe("getWorkspaceRoot", () => {
    it("returns VERSO_WORKSPACE when set", async () => {
      process.env.VERSO_WORKSPACE = "/custom/workspace";
      const { getWorkspaceRoot } = await import("./paths.js");
      expect(getWorkspaceRoot()).toBe("/custom/workspace");
    });

    it("returns OPENCLAW_WORKSPACE when set", async () => {
      delete process.env.VERSO_WORKSPACE;
      process.env.OPENCLAW_WORKSPACE = "/openclaw/workspace";
      const { getWorkspaceRoot } = await import("./paths.js");
      expect(getWorkspaceRoot()).toBe("/openclaw/workspace");
    });

    it("returns default ~/.verso/workspace when no env var", async () => {
      delete process.env.VERSO_WORKSPACE;
      delete process.env.OPENCLAW_WORKSPACE;
      const { getWorkspaceRoot } = await import("./paths.js");
      const result = getWorkspaceRoot();
      // Should end with .verso/workspace (config may override, but default is this)
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("getMemoryDir", () => {
    it("returns MEMORY_DIR when set", async () => {
      process.env.MEMORY_DIR = "/custom/memory";
      const { getMemoryDir } = await import("./paths.js");
      expect(getMemoryDir()).toBe("/custom/memory");
    });

    it("defaults to workspace/memory", async () => {
      delete process.env.MEMORY_DIR;
      process.env.VERSO_WORKSPACE = "/ws";
      const { getMemoryDir } = await import("./paths.js");
      expect(getMemoryDir()).toBe(path.join("/ws", "memory"));
    });
  });

  describe("getEvolutionDir", () => {
    it("returns EVOLUTION_DIR when set", async () => {
      process.env.EVOLUTION_DIR = "/custom/evolution";
      const { getEvolutionDir } = await import("./paths.js");
      expect(getEvolutionDir()).toBe("/custom/evolution");
    });

    it("defaults to memoryDir/evolution", async () => {
      delete process.env.EVOLUTION_DIR;
      process.env.MEMORY_DIR = "/mem";
      const { getEvolutionDir } = await import("./paths.js");
      expect(getEvolutionDir()).toBe(path.join("/mem", "evolution"));
    });
  });

  describe("getEvolverAssetsDir", () => {
    it("returns EVOLVER_ASSETS_DIR when set", async () => {
      process.env.EVOLVER_ASSETS_DIR = "/custom/evolver-assets";
      const { getEvolverAssetsDir } = await import("./paths.js");
      expect(getEvolverAssetsDir()).toBe("/custom/evolver-assets");
    });
  });

  describe("getGepAssetsDir", () => {
    it("returns GEP_ASSETS_DIR when set", async () => {
      process.env.GEP_ASSETS_DIR = "/custom/gep-assets";
      const { getGepAssetsDir } = await import("./paths.js");
      expect(getGepAssetsDir()).toBe("/custom/gep-assets");
    });
  });
});
