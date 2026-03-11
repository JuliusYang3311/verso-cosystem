import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpStateDir: string;

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => tmpStateDir,
}));

const { writePendingReview, readPendingReview, decidePendingReview, clearPendingReview } =
  await import("./evolver-review.js");

describe("evolver-review", () => {
  beforeEach(() => {
    tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "evolver-review-"));
  });

  afterEach(() => {
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  });

  describe("writePendingReview", () => {
    it("writes a review file with decision: null", () => {
      writePendingReview({
        createdAt: "2025-01-01T00:00:00Z",
        cycleId: "cycle-1",
        filesChanged: ["src/foo.ts"],
        summary: "Test change",
      });

      const review = readPendingReview();
      expect(review).not.toBeNull();
      expect(review!.decision).toBeNull();
      expect(review!.cycleId).toBe("cycle-1");
      expect(review!.filesChanged).toEqual(["src/foo.ts"]);
      expect(review!.summary).toBe("Test change");
    });
  });

  describe("readPendingReview", () => {
    it("returns null when no review file exists", () => {
      expect(readPendingReview()).toBeNull();
    });

    it("returns the review data when file exists", () => {
      writePendingReview({
        createdAt: "2025-01-01T00:00:00Z",
        cycleId: "cycle-2",
        filesChanged: [],
        summary: "Empty change",
      });

      const review = readPendingReview();
      expect(review).not.toBeNull();
      expect(review!.cycleId).toBe("cycle-2");
    });
  });

  describe("decidePendingReview", () => {
    it("returns null when no review exists", () => {
      expect(decidePendingReview("approve")).toBeNull();
    });

    it("writes an approve decision", () => {
      writePendingReview({
        createdAt: "2025-01-01T00:00:00Z",
        cycleId: "cycle-3",
        filesChanged: ["a.ts"],
        summary: "Approve test",
      });

      const result = decidePendingReview("approve");
      expect(result).not.toBeNull();
      expect(result!.decision).toBe("approve");
      expect(result!.decidedAt).toBeDefined();

      // Verify persisted
      const review = readPendingReview();
      expect(review!.decision).toBe("approve");
    });

    it("writes a reject decision", () => {
      writePendingReview({
        createdAt: "2025-01-01T00:00:00Z",
        cycleId: "cycle-4",
        filesChanged: [],
        summary: "Reject test",
      });

      const result = decidePendingReview("reject");
      expect(result).not.toBeNull();
      expect(result!.decision).toBe("reject");
    });
  });

  describe("clearPendingReview", () => {
    it("removes the review file", () => {
      writePendingReview({
        createdAt: "2025-01-01T00:00:00Z",
        cycleId: "cycle-5",
        filesChanged: [],
        summary: "Clear test",
      });

      expect(readPendingReview()).not.toBeNull();
      clearPendingReview();
      expect(readPendingReview()).toBeNull();
    });

    it("does not throw when no review file exists", () => {
      expect(() => clearPendingReview()).not.toThrow();
    });
  });

  describe("full review cycle", () => {
    it("write -> read -> decide -> clear", () => {
      // Write
      writePendingReview({
        createdAt: "2025-06-01T12:00:00Z",
        cycleId: "full-cycle",
        filesChanged: ["src/main.ts", "src/util.ts"],
        summary: "Full cycle test",
      });

      // Read
      const pending = readPendingReview();
      expect(pending).not.toBeNull();
      expect(pending!.decision).toBeNull();
      expect(pending!.cycleId).toBe("full-cycle");

      // Decide
      const decided = decidePendingReview("approve");
      expect(decided!.decision).toBe("approve");

      // Read after decision
      const afterDecision = readPendingReview();
      expect(afterDecision!.decision).toBe("approve");
      expect(afterDecision!.decidedAt).toBeDefined();

      // Clear
      clearPendingReview();
      expect(readPendingReview()).toBeNull();
    });
  });
});
