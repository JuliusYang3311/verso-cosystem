// src/orchestration/__tests__/types.test.ts — Unit tests for orchestration types

import { describe, it, expect } from "vitest";
import { isOrchestrationTerminal, isTaskTerminal } from "../types.js";

describe("Orchestration Types", () => {
  describe("isOrchestrationTerminal", () => {
    it("should return true for completed status", () => {
      expect(isOrchestrationTerminal("completed")).toBe(true);
    });

    it("should return true for failed status", () => {
      expect(isOrchestrationTerminal("failed")).toBe(true);
    });

    it("should return false for non-terminal statuses", () => {
      expect(isOrchestrationTerminal("planning")).toBe(false);
      expect(isOrchestrationTerminal("dispatching")).toBe(false);
      expect(isOrchestrationTerminal("running")).toBe(false);
      expect(isOrchestrationTerminal("acceptance")).toBe(false);
      expect(isOrchestrationTerminal("fixing")).toBe(false);
    });
  });

  describe("isTaskTerminal", () => {
    it("should return true for completed status", () => {
      expect(isTaskTerminal("completed")).toBe(true);
    });

    it("should return true for failed status", () => {
      expect(isTaskTerminal("failed")).toBe(true);
    });

    it("should return true for cancelled status", () => {
      expect(isTaskTerminal("cancelled")).toBe(true);
    });

    it("should return false for non-terminal statuses", () => {
      expect(isTaskTerminal("pending")).toBe(false);
      expect(isTaskTerminal("running")).toBe(false);
    });
  });
});
