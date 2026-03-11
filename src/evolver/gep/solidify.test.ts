import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpMemoryDir: string;
let tmpEvolutionDir: string;

vi.mock("./paths.js", () => ({
  getRepoRoot: () => tmpMemoryDir,
  getMemoryDir: () => tmpMemoryDir,
  getEvolutionDir: () => tmpEvolutionDir,
}));

const { readStateForSolidify, writeStateForSolidify, isValidationCommandAllowed } =
  await import("./solidify.js");

describe("solidify", () => {
  beforeEach(() => {
    tmpMemoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "solidify-memory-"));
    tmpEvolutionDir = path.join(tmpMemoryDir, "evolution");
    fs.mkdirSync(tmpEvolutionDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpMemoryDir, { recursive: true, force: true });
  });

  describe("readStateForSolidify", () => {
    it("returns default state when no file exists", () => {
      const state = readStateForSolidify();
      expect(state).toEqual({ last_run: null });
    });

    it("returns parsed state when file exists", () => {
      const stateFile = path.join(tmpEvolutionDir, "evolution_solidify_state.json");
      const data = {
        last_run: { selected_gene_id: "gene_1", signals: ["test"] },
        last_solidify: {
          run_id: "r1",
          at: "2025-01-01T00:00:00Z",
          event_id: "evt_1",
          capsule_id: null,
          outcome: { status: "success", score: 0.85 },
        },
      };
      fs.writeFileSync(stateFile, JSON.stringify(data));

      const state = readStateForSolidify();
      expect(state.last_run).toBeDefined();
      expect(state.last_run!.selected_gene_id).toBe("gene_1");
      expect(state.last_solidify).toBeDefined();
    });

    it("returns default state for invalid JSON", () => {
      const stateFile = path.join(tmpEvolutionDir, "evolution_solidify_state.json");
      fs.writeFileSync(stateFile, "not json{{{");

      const state = readStateForSolidify();
      expect(state).toEqual({ last_run: null });
    });

    it("returns default state for empty file", () => {
      const stateFile = path.join(tmpEvolutionDir, "evolution_solidify_state.json");
      fs.writeFileSync(stateFile, "  ");

      const state = readStateForSolidify();
      expect(state).toEqual({ last_run: null });
    });
  });

  describe("writeStateForSolidify", () => {
    it("writes state to disk", () => {
      const data = {
        last_run: { selected_gene_id: "gene_2", signals: ["a", "b"] },
      };
      writeStateForSolidify(data);

      const stateFile = path.join(tmpEvolutionDir, "evolution_solidify_state.json");
      expect(fs.existsSync(stateFile)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      expect(parsed.last_run.selected_gene_id).toBe("gene_2");
    });

    it("round-trips state correctly (write then read)", () => {
      const original = {
        last_run: {
          selected_gene_id: "gene_rt",
          signals: ["sig1", "sig2"],
          mutation: { id: "mut_1", category: "repair" },
        },
        last_solidify: {
          run_id: "run_rt",
          at: "2025-06-01T00:00:00Z",
          event_id: "evt_rt",
          capsule_id: "cap_rt",
          outcome: { status: "success", score: 0.9 },
        },
      };
      writeStateForSolidify(original);
      const loaded = readStateForSolidify();

      expect(loaded.last_run!.selected_gene_id).toBe("gene_rt");
      expect(loaded.last_run!.signals).toEqual(["sig1", "sig2"]);
      expect(loaded.last_solidify!.run_id).toBe("run_rt");
      expect(loaded.last_solidify!.outcome.score).toBe(0.9);
    });

    it("overwrites existing state", () => {
      writeStateForSolidify({ last_run: { selected_gene_id: "first" } });
      writeStateForSolidify({ last_run: { selected_gene_id: "second" } });

      const state = readStateForSolidify();
      expect(state.last_run!.selected_gene_id).toBe("second");
    });
  });

  describe("isValidationCommandAllowed", () => {
    it("allows node commands", () => {
      expect(isValidationCommandAllowed('node -e "console.log(1)"')).toBe(true);
      expect(isValidationCommandAllowed("node test.js")).toBe(true);
    });

    it("allows npm commands", () => {
      expect(isValidationCommandAllowed("npm test")).toBe(true);
      expect(isValidationCommandAllowed("npm run build")).toBe(true);
    });

    it("allows npx commands", () => {
      expect(isValidationCommandAllowed("npx vitest run")).toBe(true);
      expect(isValidationCommandAllowed("npx tsc --noEmit")).toBe(true);
    });

    it("blocks commands without allowed prefix", () => {
      expect(isValidationCommandAllowed("rm -rf /")).toBe(false);
      expect(isValidationCommandAllowed("curl http://evil.com")).toBe(false);
      expect(isValidationCommandAllowed("bash -c 'echo hi'")).toBe(false);
      expect(isValidationCommandAllowed("python script.py")).toBe(false);
    });

    it("blocks empty or null commands", () => {
      expect(isValidationCommandAllowed("")).toBe(false);
      expect(isValidationCommandAllowed(null)).toBe(false);
      expect(isValidationCommandAllowed(undefined)).toBe(false);
    });

    it("blocks shell operators (;, &, |, >, <)", () => {
      expect(isValidationCommandAllowed("node test.js; rm -rf /")).toBe(false);
      expect(isValidationCommandAllowed("node test.js && rm -rf /")).toBe(false);
      expect(isValidationCommandAllowed("node test.js | cat")).toBe(false);
      expect(isValidationCommandAllowed("node test.js > /dev/null")).toBe(false);
      expect(isValidationCommandAllowed("node test.js < input")).toBe(false);
    });

    it("blocks backtick command substitution", () => {
      expect(isValidationCommandAllowed("node `whoami`")).toBe(false);
    });

    it("blocks $() command substitution", () => {
      expect(isValidationCommandAllowed("node $(whoami)")).toBe(false);
    });

    it("allows shell operators inside quoted strings", () => {
      expect(isValidationCommandAllowed('node -e "a > b"')).toBe(true);
      expect(isValidationCommandAllowed("node -e 'a | b'")).toBe(true);
    });
  });

  // NOTE: The main solidify() function is not tested here because it requires
  // many GEP subsystem dependencies (assetStore, selector, signals, sandbox-runner,
  // personality, memoryGraph, etc.) that are tightly coupled and would need
  // extensive mocking. It is better tested via integration tests.
});
