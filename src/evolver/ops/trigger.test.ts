import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Create a stable temp dir before module loads (trigger.ts captures WAKE_FILE at module level)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trigger-test-"));

vi.mock("../gep/paths.js", () => ({
  getWorkspaceRoot: () => tmpDir,
}));

const { send, clear, isPending } = await import("./trigger.js");

describe("trigger", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, "memory"), { recursive: true });
  });

  afterEach(() => {
    // Clean up wake file between tests
    const wakeFile = path.join(tmpDir, "memory", "evolver_wake.signal");
    try {
      if (fs.existsSync(wakeFile)) fs.unlinkSync(wakeFile);
    } catch {
      // ignore
    }
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("send", () => {
    it("creates a wake signal file and returns true", () => {
      const result = send();
      expect(result).toBe(true);
      const wakeFile = path.join(tmpDir, "memory", "evolver_wake.signal");
      expect(fs.existsSync(wakeFile)).toBe(true);
      expect(fs.readFileSync(wakeFile, "utf8")).toBe("WAKE");
    });

    it("returns false if the directory does not exist", () => {
      // Remove memory dir so write fails
      fs.rmSync(path.join(tmpDir, "memory"), { recursive: true, force: true });
      const result = send();
      expect(result).toBe(false);
    });
  });

  describe("clear", () => {
    it("removes the wake file if it exists", () => {
      send();
      expect(isPending()).toBe(true);
      clear();
      expect(isPending()).toBe(false);
    });

    it("does nothing if wake file does not exist", () => {
      expect(() => clear()).not.toThrow();
    });
  });

  describe("isPending", () => {
    it("returns false when no wake file", () => {
      expect(isPending()).toBe(false);
    });

    it("returns true after send", () => {
      send();
      expect(isPending()).toBe(true);
    });

    it("returns false after send then clear", () => {
      send();
      clear();
      expect(isPending()).toBe(false);
    });
  });
});
