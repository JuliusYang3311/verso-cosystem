import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { clip, writePromptArtifact, renderSessionsSpawnCall } from "./bridge.js";

describe("clip", () => {
  it("returns empty string for null/undefined", () => {
    expect(clip(null, 100)).toBe("");
    expect(clip(undefined, 100)).toBe("");
  });

  it("returns original string when within limit", () => {
    expect(clip("hello", 100)).toBe("hello");
  });

  it("truncates long strings", () => {
    const long = "a".repeat(200);
    const result = clip(long, 100);
    expect(result.length).toBeLessThan(200);
    expect(result).toContain("...[TRUNCATED]...");
  });

  it("returns full string when maxChars is not finite", () => {
    expect(clip("hello", NaN)).toBe("hello");
    expect(clip("hello", Infinity)).toBe("hello");
  });

  it("returns full string when maxChars <= 0", () => {
    expect(clip("hello", 0)).toBe("hello");
    expect(clip("hello", -5)).toBe("hello");
  });

  it("truncates at maxChars - 40 and appends marker", () => {
    const text = "x".repeat(100);
    const result = clip(text, 80);
    // slice(0, max(0, 80-40)) = slice(0, 40) + "\n...[TRUNCATED]...\n"
    expect(result).toBe("x".repeat(40) + "\n...[TRUNCATED]...\n");
  });
});

describe("writePromptArtifact", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws when memoryDir is missing", () => {
    expect(() => writePromptArtifact({ memoryDir: "" })).toThrow("missing memoryDir");
  });

  it("creates prompt and meta files", () => {
    const result = writePromptArtifact({
      memoryDir: tmpDir,
      cycleId: "c1",
      runId: "r1",
      prompt: "test prompt",
      meta: { foo: "bar" },
    });

    expect(fs.existsSync(result.promptPath)).toBe(true);
    expect(fs.existsSync(result.metaPath)).toBe(true);

    const promptContent = fs.readFileSync(result.promptPath, "utf8");
    expect(promptContent).toBe("test prompt");

    const metaContent = JSON.parse(fs.readFileSync(result.metaPath, "utf8"));
    expect(metaContent.type).toBe("GepPromptArtifact");
    expect(metaContent.cycle_id).toBe("c1");
    expect(metaContent.run_id).toBe("r1");
    expect(metaContent.meta).toEqual({ foo: "bar" });
    expect(metaContent.at).toBeTruthy();
  });

  it("sanitizes cycleId and runId in filename", () => {
    const result = writePromptArtifact({
      memoryDir: tmpDir,
      cycleId: "c/1",
      runId: "r 1",
    });
    expect(path.basename(result.promptPath)).toMatch(/^gep_prompt_c_1_r_1\.txt$/);
  });

  it("uses defaults when cycleId/runId not provided", () => {
    const result = writePromptArtifact({ memoryDir: tmpDir });
    expect(path.basename(result.promptPath)).toMatch(/^gep_prompt_cycle_\d+\.txt$/);
  });
});

describe("renderSessionsSpawnCall", () => {
  it("throws when task is missing", () => {
    expect(() => renderSessionsSpawnCall({ task: "" })).toThrow("missing task");
  });

  it("renders correct format with defaults", () => {
    const result = renderSessionsSpawnCall({ task: "do something" });
    expect(result).toMatch(/^sessions_spawn\(/);
    const payload = JSON.parse(result.slice("sessions_spawn(".length, -1));
    expect(payload.task).toBe("do something");
    expect(payload.agentId).toBe("main");
    expect(payload.label).toBe("gep_bridge");
    expect(payload.cleanup).toBe("delete");
  });

  it("uses provided parameters", () => {
    const result = renderSessionsSpawnCall({
      task: "my task",
      agentId: "worker",
      label: "custom",
      cleanup: "keep",
    });
    const payload = JSON.parse(result.slice("sessions_spawn(".length, -1));
    expect(payload.agentId).toBe("worker");
    expect(payload.label).toBe("custom");
    expect(payload.cleanup).toBe("keep");
  });
});
