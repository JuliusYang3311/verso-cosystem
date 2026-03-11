import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

const mockExecSync = vi.fn();

vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

vi.mock("../gep/paths.js", () => ({
  getWorkspaceRoot: () => tmpDir,
}));

const { repair } = await import("./self_repair.js");

describe("self_repair", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "selfrepair-test-"));
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    mockExecSync.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("repair", () => {
    it("reports rebase_aborted when rebase abort succeeds", () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "git rebase --abort") return "";
        throw new Error("fail");
      });

      const result = repair(tmpDir);
      expect(result).toContain("rebase_aborted");
    });

    it("reports merge_aborted when merge abort succeeds", () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "git merge --abort") return "";
        throw new Error("fail");
      });

      const result = repair(tmpDir);
      expect(result).toContain("merge_aborted");
    });

    it("reports stale_lock_removed when index.lock is old", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("fail");
      });

      const lockFile = path.join(tmpDir, ".git", "index.lock");
      fs.writeFileSync(lockFile, "lock");
      // Make the lock file old (>10 min)
      const oldTime = new Date(Date.now() - 15 * 60 * 1000);
      fs.utimesSync(lockFile, oldTime, oldTime);

      const result = repair(tmpDir);
      expect(result).toContain("stale_lock_removed");
      expect(fs.existsSync(lockFile)).toBe(false);
    });

    it("does not remove fresh lock file", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("fail");
      });

      const lockFile = path.join(tmpDir, ".git", "index.lock");
      fs.writeFileSync(lockFile, "lock");
      // Lock is fresh (just created)

      const result = repair(tmpDir);
      expect(result).not.toContain("stale_lock_removed");
      expect(fs.existsSync(lockFile)).toBe(true);
    });

    it("reports fetch_ok when git fetch succeeds", () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "git fetch origin") return "";
        throw new Error("fail");
      });

      const result = repair(tmpDir);
      expect(result).toContain("fetch_ok");
    });

    it("returns all actions when everything succeeds", () => {
      mockExecSync.mockImplementation(() => "");

      const lockFile = path.join(tmpDir, ".git", "index.lock");
      fs.writeFileSync(lockFile, "lock");
      const oldTime = new Date(Date.now() - 15 * 60 * 1000);
      fs.utimesSync(lockFile, oldTime, oldTime);

      const result = repair(tmpDir);
      expect(result).toContain("rebase_aborted");
      expect(result).toContain("merge_aborted");
      expect(result).toContain("stale_lock_removed");
      expect(result).toContain("fetch_ok");
    });

    it("returns empty array when no repairs needed", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("nothing to do");
      });

      const result = repair(tmpDir);
      expect(result).toEqual([]);
    });
  });
});
