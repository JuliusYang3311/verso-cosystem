import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawnSync = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { applyCodeChanges } = await import("./code-agent.js");

describe("code-agent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-agent-"));
    mockSpawnSync.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("applyCodeChanges", () => {
    it("returns ok with empty filesChanged when no changes provided", async () => {
      const result = await applyCodeChanges({
        prompt: "test",
        workspace: tmpDir,
      });
      expect(result.ok).toBe(true);
      expect(result.filesChanged).toEqual([]);
    });

    it("returns ok with empty filesChanged when changes is empty array", async () => {
      const result = await applyCodeChanges({
        prompt: "test",
        workspace: tmpDir,
        changes: [],
      });
      expect(result.ok).toBe(true);
      expect(result.filesChanged).toEqual([]);
    });

    it("creates a new file", async () => {
      const result = await applyCodeChanges({
        prompt: "test",
        workspace: tmpDir,
        changes: [
          {
            filePath: "src/new-file.ts",
            action: "create",
            content: "export const x = 1;\n",
          },
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.filesChanged).toContain("src/new-file.ts");
      const content = fs.readFileSync(path.join(tmpDir, "src/new-file.ts"), "utf8");
      expect(content).toBe("export const x = 1;\n");
    });

    it("creates nested directories for new files", async () => {
      const result = await applyCodeChanges({
        prompt: "test",
        workspace: tmpDir,
        changes: [
          {
            filePath: "a/b/c/deep.ts",
            action: "create",
            content: "deep",
          },
        ],
      });

      expect(result.ok).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "a/b/c/deep.ts"))).toBe(true);
    });

    it("edits a file using oldContent/newContent replacement", async () => {
      const filePath = path.join(tmpDir, "edit-me.ts");
      fs.writeFileSync(filePath, "const a = 1;\nconst b = 2;\n");

      const result = await applyCodeChanges({
        prompt: "test",
        workspace: tmpDir,
        changes: [
          {
            filePath: "edit-me.ts",
            action: "edit",
            oldContent: "const a = 1;",
            newContent: "const a = 42;",
          },
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.filesChanged).toContain("edit-me.ts");
      const content = fs.readFileSync(filePath, "utf8");
      expect(content).toBe("const a = 42;\nconst b = 2;\n");
    });

    it("edits a file using full content replacement", async () => {
      const filePath = path.join(tmpDir, "full-edit.ts");
      fs.writeFileSync(filePath, "old content");

      const result = await applyCodeChanges({
        prompt: "test",
        workspace: tmpDir,
        changes: [
          {
            filePath: "full-edit.ts",
            action: "edit",
            content: "new content",
          },
        ],
      });

      expect(result.ok).toBe(true);
      const content = fs.readFileSync(filePath, "utf8");
      expect(content).toBe("new content");
    });

    it("skips edit when file does not exist", async () => {
      const result = await applyCodeChanges({
        prompt: "test",
        workspace: tmpDir,
        changes: [
          {
            filePath: "nonexistent.ts",
            action: "edit",
            content: "data",
          },
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.filesChanged).toEqual([]);
    });

    it("skips edit when oldContent not found in file", async () => {
      const filePath = path.join(tmpDir, "no-match.ts");
      fs.writeFileSync(filePath, "const x = 1;");

      const result = await applyCodeChanges({
        prompt: "test",
        workspace: tmpDir,
        changes: [
          {
            filePath: "no-match.ts",
            action: "edit",
            oldContent: "this does not exist",
            newContent: "replacement",
          },
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.filesChanged).toEqual([]);
      // File unchanged
      expect(fs.readFileSync(filePath, "utf8")).toBe("const x = 1;");
    });

    it("deletes an existing file", async () => {
      const filePath = path.join(tmpDir, "delete-me.ts");
      fs.writeFileSync(filePath, "bye");

      const result = await applyCodeChanges({
        prompt: "test",
        workspace: tmpDir,
        changes: [
          {
            filePath: "delete-me.ts",
            action: "delete",
          },
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.filesChanged).toContain("delete-me.ts");
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("does not fail when deleting non-existent file", async () => {
      const result = await applyCodeChanges({
        prompt: "test",
        workspace: tmpDir,
        changes: [
          {
            filePath: "ghost.ts",
            action: "delete",
          },
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.filesChanged).toEqual([]);
    });

    it("applies multiple changes in order", async () => {
      const result = await applyCodeChanges({
        prompt: "test",
        workspace: tmpDir,
        changes: [
          { filePath: "a.ts", action: "create", content: "a" },
          { filePath: "b.ts", action: "create", content: "b" },
          { filePath: "c.ts", action: "create", content: "c" },
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.filesChanged).toEqual(["a.ts", "b.ts", "c.ts"]);
    });

    it("rolls back on sandbox validation failure", async () => {
      // Create file then apply change with sandboxValidate
      fs.writeFileSync(path.join(tmpDir, "rollback.ts"), "original");

      mockSpawnSync.mockImplementation((cmd: string) => {
        if (cmd === "pnpm") {
          return { status: 1, stderr: "build failed", stdout: "" };
        }
        // git restore for rollback
        return { status: 0, stderr: "", stdout: "" };
      });

      const result = await applyCodeChanges({
        prompt: "test",
        workspace: tmpDir,
        sandboxValidate: true,
        changes: [
          {
            filePath: "new-file.ts",
            action: "create",
            content: "bad code",
          },
        ],
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Sandbox validation failed");
      // git restore should have been called for rollback
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "git",
        ["restore", "--", "new-file.ts"],
        expect.objectContaining({ cwd: tmpDir }),
      );
    });

    it("succeeds sandbox validation when build passes", async () => {
      mockSpawnSync.mockReturnValue({ status: 0, stderr: "", stdout: "" });

      const result = await applyCodeChanges({
        prompt: "test",
        workspace: tmpDir,
        sandboxValidate: true,
        changes: [
          {
            filePath: "good.ts",
            action: "create",
            content: "console.log('ok');",
          },
        ],
      });

      expect(result.ok).toBe(true);
    });

    it("tracks changed files correctly across mixed operations", async () => {
      fs.writeFileSync(path.join(tmpDir, "existing.ts"), "old");
      fs.writeFileSync(path.join(tmpDir, "to-delete.ts"), "bye");

      const result = await applyCodeChanges({
        prompt: "test",
        workspace: tmpDir,
        changes: [
          { filePath: "new.ts", action: "create", content: "new" },
          { filePath: "existing.ts", action: "edit", content: "updated" },
          { filePath: "to-delete.ts", action: "delete" },
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.filesChanged).toContain("new.ts");
      expect(result.filesChanged).toContain("existing.ts");
      expect(result.filesChanged).toContain("to-delete.ts");
    });
  });
});
