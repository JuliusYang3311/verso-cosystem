// resolve-memory-for-context.test.ts — Tests for memory manager resolution with warning on failure

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveMemoryForContext } from "./resolve-memory-for-context.js";

// Mock getMemorySearchManager
vi.mock("./search-manager.js", () => ({
  getMemorySearchManager: vi.fn(),
}));

const mockGetManager = async () => {
  const mod = await import("./search-manager.js");
  return vi.mocked(mod.getMemorySearchManager);
};

describe("resolveMemoryForContext", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null manager when dynamicContext is disabled", async () => {
    const result = await resolveMemoryForContext({
      dynamicContextEnabled: false,
      agentId: "test-agent",
    });
    expect(result.manager).toBeNull();
    expect(result.warning).toBeUndefined();
  });

  it("returns explicit manager when provided", async () => {
    const fakeManager = { search: vi.fn() } as any;
    const result = await resolveMemoryForContext({
      explicitManager: fakeManager,
      dynamicContextEnabled: true,
      agentId: "test-agent",
    });
    expect(result.manager).toBe(fakeManager);
    expect(result.warning).toBeUndefined();
  });

  it("falls back to getMemorySearchManager when no explicit manager", async () => {
    const fakeManager = { search: vi.fn() } as any;
    const getMgr = await mockGetManager();
    getMgr.mockResolvedValue({ manager: fakeManager });

    const result = await resolveMemoryForContext({
      dynamicContextEnabled: true,
      cfg: {},
      agentId: "test-agent",
    });
    expect(result.manager).toBe(fakeManager);
    expect(result.warning).toBeUndefined();
    expect(getMgr).toHaveBeenCalledWith({ cfg: {}, agentId: "test-agent" });
  });

  it("returns warning when getMemorySearchManager returns null manager with error", async () => {
    const getMgr = await mockGetManager();
    getMgr.mockResolvedValue({ manager: null, error: "DB file not found" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await resolveMemoryForContext({
      dynamicContextEnabled: true,
      cfg: {},
      agentId: "cron-agent",
    });

    expect(result.manager).toBeNull();
    expect(result.warning).toContain("DB file not found");
    expect(warnSpy).toHaveBeenCalledWith(
      "[memory-resolve]",
      expect.stringContaining("Memory manager initialization failed"),
      expect.objectContaining({ agentId: "cron-agent" }),
    );
  });

  it("returns warning when getMemorySearchManager throws", async () => {
    const getMgr = await mockGetManager();
    getMgr.mockRejectedValue(new Error("import failed"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await resolveMemoryForContext({
      dynamicContextEnabled: true,
      cfg: {},
      agentId: "cron-agent",
    });

    expect(result.manager).toBeNull();
    expect(result.warning).toContain("import failed");
    expect(warnSpy).toHaveBeenCalledWith(
      "[memory-resolve]",
      expect.stringContaining("Memory manager initialization threw"),
      expect.objectContaining({ agentId: "cron-agent" }),
    );
  });

  it("returns null manager (no warning) when getMemorySearchManager returns null without error", async () => {
    const getMgr = await mockGetManager();
    getMgr.mockResolvedValue({ manager: null });

    const result = await resolveMemoryForContext({
      dynamicContextEnabled: true,
      cfg: {},
      agentId: "test-agent",
    });

    expect(result.manager).toBeNull();
    expect(result.warning).toBeUndefined();
  });

  it("uses empty config object when cfg not provided", async () => {
    const fakeManager = { search: vi.fn() } as any;
    const getMgr = await mockGetManager();
    getMgr.mockResolvedValue({ manager: fakeManager });

    await resolveMemoryForContext({
      dynamicContextEnabled: true,
      agentId: "test-agent",
      // no cfg
    });

    expect(getMgr).toHaveBeenCalledWith({ cfg: {}, agentId: "test-agent" });
  });

  it("never throws — always returns a result", async () => {
    const getMgr = await mockGetManager();
    getMgr.mockRejectedValue("non-Error thrown value");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await resolveMemoryForContext({
      dynamicContextEnabled: true,
      cfg: {},
      agentId: "test-agent",
    });

    expect(result.manager).toBeNull();
    expect(result.warning).toBeDefined();
  });
});
