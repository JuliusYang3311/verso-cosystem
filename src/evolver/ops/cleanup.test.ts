import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

vi.mock("../gep/paths.js", () => ({
  getEvolutionDir: () => tmpDir,
}));

const { run } = await import("./cleanup.js");

describe("cleanup", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("run", () => {
    it("returns 0 when evolution dir does not exist", () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      expect(run()).toBe(0);
    });

    it("returns 0 when no matching files exist", () => {
      fs.writeFileSync(path.join(tmpDir, "random.txt"), "data");
      expect(run()).toBe(0);
    });

    it("keeps at least MIN_KEEP (10) files regardless of age", () => {
      // Create 15 old gep_prompt files (all older than 24h)
      const oldTime = Date.now() - 48 * 60 * 60 * 1000; // 48h ago
      for (let i = 0; i < 15; i++) {
        const name = `gep_prompt_${String(i).padStart(3, "0")}.json`;
        const fp = path.join(tmpDir, name);
        fs.writeFileSync(fp, "{}");
        // Set mtime to old, slightly different so sort is stable
        const t = new Date(oldTime + i * 1000);
        fs.utimesSync(fp, t, t);
      }

      const deleted = run();
      // Should delete 5 (15 - 10 MIN_KEEP), all older than 24h
      expect(deleted).toBe(5);

      const remaining = fs.readdirSync(tmpDir).filter((f) => f.startsWith("gep_prompt_"));
      expect(remaining.length).toBe(10);
    });

    it("does not delete files younger than MAX_AGE_MS even beyond MIN_KEEP", () => {
      // Create 15 recent files
      for (let i = 0; i < 15; i++) {
        const name = `gep_prompt_${String(i).padStart(3, "0")}.json`;
        const fp = path.join(tmpDir, name);
        fs.writeFileSync(fp, "{}");
        // Recent timestamps
        const t = new Date(Date.now() - i * 1000);
        fs.utimesSync(fp, t, t);
      }

      const deleted = run();
      expect(deleted).toBe(0);
    });

    it("matches both .json and .txt extensions", () => {
      const oldTime = Date.now() - 48 * 60 * 60 * 1000;
      // Create 12 files: mix of json and txt
      for (let i = 0; i < 6; i++) {
        const jsonName = `gep_prompt_${i}.json`;
        const txtName = `gep_prompt_${i}.txt`;
        for (const name of [jsonName, txtName]) {
          const fp = path.join(tmpDir, name);
          fs.writeFileSync(fp, "data");
          const t = new Date(oldTime + i * 1000);
          fs.utimesSync(fp, t, t);
        }
      }

      const deleted = run();
      // 12 total, keep 10 newest, delete 2 oldest (all old)
      expect(deleted).toBe(2);
    });

    it("ignores files that do not match the gep_prompt_ pattern", () => {
      const oldTime = Date.now() - 48 * 60 * 60 * 1000;
      // 12 matching + 5 non-matching
      for (let i = 0; i < 12; i++) {
        const fp = path.join(tmpDir, `gep_prompt_${i}.json`);
        fs.writeFileSync(fp, "{}");
        const t = new Date(oldTime + i * 1000);
        fs.utimesSync(fp, t, t);
      }
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(tmpDir, `other_${i}.json`), "{}");
      }

      const deleted = run();
      // 12 matching, keep 10, delete 2
      expect(deleted).toBe(2);
      // Non-matching files untouched
      const others = fs.readdirSync(tmpDir).filter((f) => f.startsWith("other_"));
      expect(others.length).toBe(5);
    });
  });
});
