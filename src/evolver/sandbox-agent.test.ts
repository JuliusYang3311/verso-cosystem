import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------- Mocks ----------

const mockExecSync = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { runCodingAgentInSandbox } = await import("./sandbox-agent.js");

// ---------- Helpers ----------

function makeMockSession(lastText: string) {
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    getLastAssistantText: vi.fn().mockReturnValue(lastText),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
}

// ---------- Tests ----------

describe("sandbox-agent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-agent-"));
    mockExecSync.mockReset();
    // Default: git init succeeds, getChangedFilesAfter returns empty
    mockExecSync.mockReturnValue("");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("EVOLUTION_COMPLETE marker", () => {
    it("returns ok: true when agent outputs EVOLUTION_COMPLETE", async () => {
      const session = makeMockSession("Changes applied successfully. EVOLUTION_COMPLETE");

      const result = await runCodingAgentInSandbox({
        prompt: "add feature X",
        sandboxDir: tmpDir,
        session: session as any,
      });

      expect(result.ok).toBe(true);
      // Session is NOT disposed (owned by runner)
      expect(session.dispose).not.toHaveBeenCalled();
    });
  });

  describe("EVOLUTION_FAILED marker", () => {
    it("returns ok: false when agent outputs EVOLUTION_FAILED", async () => {
      const session = makeMockSession("Cannot apply changes. EVOLUTION_FAILED");

      const result = await runCodingAgentInSandbox({
        prompt: "add feature X",
        sandboxDir: tmpDir,
        session: session as any,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("EVOLUTION_FAILED");
    });
  });

  describe("no marker, files changed", () => {
    it("returns ok: true when no marker but files changed (permissive)", async () => {
      const session = makeMockSession("I made some changes to the code.");

      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("git diff --name-only")) {
          return "src/modified.ts\nsrc/new.ts\n";
        }
        return "";
      });

      const result = await runCodingAgentInSandbox({
        prompt: "add feature X",
        sandboxDir: tmpDir,
        session: session as any,
      });

      expect(result.ok).toBe(true);
      expect(result.filesChanged).toContain("src/modified.ts");
      expect(result.filesChanged).toContain("src/new.ts");
    });
  });

  describe("no marker and no files changed", () => {
    it("returns ok: false when no marker and no files changed", async () => {
      const session = makeMockSession("I looked at the code but everything seems fine already.");
      mockExecSync.mockReturnValue("");

      const result = await runCodingAgentInSandbox({
        prompt: "add feature X",
        sandboxDir: tmpDir,
        session: session as any,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("no files changed");
    });
  });

  describe("timeout scenario", () => {
    it("returns ok: false with timeout error when agent hangs", async () => {
      const session = makeMockSession("");
      session.prompt.mockImplementation(() => new Promise(() => {})); // never resolves

      const result = await runCodingAgentInSandbox({
        prompt: "add feature X",
        sandboxDir: tmpDir,
        session: session as any,
        timeoutMs: 100, // very short timeout
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("timed out");
      expect(session.abort).toHaveBeenCalled();
    });
  });

  describe("executor prompt includes sandbox path", () => {
    it("includes SANDBOX DIRECTORY in the prompt sent to session", async () => {
      const session = makeMockSession("EVOLUTION_COMPLETE");

      await runCodingAgentInSandbox({
        prompt: "test mutation",
        sandboxDir: tmpDir,
        session: session as any,
      });

      const promptArg = session.prompt.mock.calls[0]![0] as string;
      expect(promptArg).toContain(`SANDBOX DIRECTORY: ${tmpDir}`);
      expect(promptArg).toContain("test mutation");
    });
  });

  describe("git change detection", () => {
    it("detects changed files from git diff output", async () => {
      const session = makeMockSession("EVOLUTION_COMPLETE");

      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("git diff --name-only")) {
          return "src/a.ts\nsrc/b.ts\n";
        }
        return "";
      });

      const result = await runCodingAgentInSandbox({
        prompt: "modify files",
        sandboxDir: tmpDir,
        session: session as any,
      });

      expect(result.ok).toBe(true);
      expect(result.filesChanged).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("returns empty filesChanged when git diff throws", async () => {
      const session = makeMockSession("EVOLUTION_COMPLETE");

      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("git diff --name-only")) {
          throw new Error("git not available");
        }
        return "";
      });

      const result = await runCodingAgentInSandbox({
        prompt: "modify files",
        sandboxDir: tmpDir,
        session: session as any,
      });

      expect(result.ok).toBe(true);
      expect(result.filesChanged).toEqual([]);
    });
  });

  describe("error handling", () => {
    it("returns error when session.prompt throws", async () => {
      const session = makeMockSession("");
      session.prompt.mockRejectedValue(new Error("API error"));

      const result = await runCodingAgentInSandbox({
        prompt: "test",
        sandboxDir: tmpDir,
        session: session as any,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("API error");
    });
  });
});
