import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Create stable temp dirs before module loads (lifecycle.ts captures consts at module level)
const tmpWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-ws-"));
const tmpLogsDir = path.join(tmpWorkspaceDir, "logs");
const tmpRepoRoot = path.join(tmpWorkspaceDir, "repo");
fs.mkdirSync(tmpLogsDir, { recursive: true });
fs.mkdirSync(path.join(tmpWorkspaceDir, "memory"), { recursive: true });
fs.mkdirSync(tmpRepoRoot, { recursive: true });

const mockExecSync = vi.fn();
const mockSpawn = vi.fn();

vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock("../gep/paths.js", () => ({
  getWorkspaceRoot: () => tmpWorkspaceDir,
  getRepoRoot: () => tmpRepoRoot,
  getLogsDir: () => tmpLogsDir,
}));

const { getRunningPids, status, tailLog, checkHealth } = await import("./lifecycle.js");

describe("lifecycle", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockSpawn.mockReset();
  });

  afterEach(() => {
    // Clean up log file between tests
    const logFile = path.join(tmpLogsDir, "evolver_loop.log");
    try {
      if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
    } catch {
      // ignore
    }
  });

  afterAll(() => {
    fs.rmSync(tmpWorkspaceDir, { recursive: true, force: true });
  });

  describe("getRunningPids", () => {
    it("returns empty array when ps returns no matching processes", () => {
      mockExecSync.mockReturnValue("  PID ARGS\n  123 /usr/bin/node app.js\n  456 /usr/bin/bash\n");
      const pids = getRunningPids();
      expect(pids).toEqual([]);
    });

    it("returns empty array when ps command fails", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("ps failed");
      });
      const pids = getRunningPids();
      expect(pids).toEqual([]);
    });

    it("detects evolver/daemon-entry processes (filtered by isPidRunning)", () => {
      const currentPid = process.pid;
      mockExecSync.mockReturnValue(
        `  PID ARGS\n  ${currentPid} node evolver/daemon-entry\n  99999 node evolver/daemon-entry --loop\n`,
      );
      // currentPid is excluded, 99999 is not actually running so isPidRunning returns false
      const pids = getRunningPids();
      expect(pids).toEqual([]);
    });

    it("detects evolver/runner processes", () => {
      mockExecSync.mockReturnValue("  PID ARGS\n  99998 node evolver/runner --loop\n");
      // 99998 not actually running
      const pids = getRunningPids();
      expect(pids).toEqual([]);
    });
  });

  describe("status", () => {
    it("returns running: false when no processes found", () => {
      mockExecSync.mockReturnValue("  PID ARGS\n");

      const result = status();
      expect(result.running).toBe(false);
      expect(result.pids).toBeUndefined();
    });
  });

  describe("tailLog", () => {
    it("returns error when no log file exists", () => {
      const result = tailLog();
      expect(result.error).toBe("No log file");
    });

    it("returns log content when log file exists", () => {
      const logFile = path.join(tmpLogsDir, "evolver_loop.log");
      fs.writeFileSync(logFile, "line1\nline2\nline3\n");

      mockExecSync.mockReturnValue("line1\nline2\nline3\n");

      const result = tailLog(10);
      expect(result.content).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    it("uses default 20 lines when no argument provided", () => {
      const logFile = path.join(tmpLogsDir, "evolver_loop.log");
      fs.writeFileSync(logFile, "data");

      mockExecSync.mockReturnValue("data");

      const result = tailLog();
      expect(result.content).toBe("data");
      // Verify the tail command used 20 as default
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("tail -n 20"),
        expect.anything(),
      );
    });

    it("returns error when tail command fails", () => {
      const logFile = path.join(tmpLogsDir, "evolver_loop.log");
      fs.writeFileSync(logFile, "data");

      mockExecSync.mockImplementation(() => {
        throw new Error("tail failed");
      });

      const result = tailLog();
      expect(result.error).toBeDefined();
      expect(result.error).toContain("tail failed");
    });
  });

  describe("checkHealth", () => {
    it("returns not_running when no processes found", () => {
      mockExecSync.mockReturnValue("  PID ARGS\n");

      const result = checkHealth();
      expect(result.healthy).toBe(false);
      expect(result.reason).toBe("not_running");
    });
  });
});
