import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let tmpDir: string;

vi.mock("./paths.js", () => ({
  getGepAssetsDir: () => tmpDir,
  getEvolverAssetsDir: () => tmpDir,
  getWorkspaceRoot: () => tmpDir,
  getRepoRoot: () => process.cwd(),
}));

import {
  loadGenes,
  loadCapsules,
  getLastEventId,
  readAllEvents,
  appendEventJsonl,
  appendCandidateJsonl,
  upsertGene,
  appendCapsule,
  upsertCapsule,
  readRecentCandidates,
  genesPath,
  capsulesPath,
} from "./assetStore.js";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "assetstore-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadGenes", () => {
  it("returns default genes when file does not exist", () => {
    const genes = loadGenes();
    expect(Array.isArray(genes)).toBe(true);
    expect(genes.length).toBeGreaterThan(0);
    // Default genes have type "Gene"
    expect(genes[0].type).toBe("Gene");
  });

  it("returns genes from file when present", () => {
    const data = {
      version: 1,
      genes: [
        {
          type: "Gene",
          id: "test_gene",
          category: "test",
          signals_match: [],
          preconditions: [],
          strategy: [],
          constraints: {},
          validation: [],
        },
      ],
    };
    fs.writeFileSync(genesPath(), JSON.stringify(data), "utf8");
    const genes = loadGenes();
    expect(genes).toHaveLength(1);
    expect(genes[0].id).toBe("test_gene");
  });
});

describe("loadCapsules", () => {
  it("returns empty array when file does not exist", () => {
    const capsules = loadCapsules();
    expect(capsules).toEqual([]);
  });

  it("returns capsules from file", () => {
    const data = { version: 1, capsules: [{ type: "Capsule", id: "c1" }] };
    fs.writeFileSync(capsulesPath(), JSON.stringify(data), "utf8");
    const capsules = loadCapsules();
    expect(capsules).toHaveLength(1);
    expect(capsules[0].id).toBe("c1");
  });
});

describe("appendEventJsonl / readAllEvents / getLastEventId", () => {
  it("appends and reads events", () => {
    appendEventJsonl({ type: "EvolutionEvent", id: "e1" });
    appendEventJsonl({ type: "EvolutionEvent", id: "e2" });
    const events = readAllEvents();
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe("e1");
    expect(events[1].id).toBe("e2");
  });

  it("getLastEventId returns last event id", () => {
    appendEventJsonl({ type: "EvolutionEvent", id: "e1" });
    appendEventJsonl({ type: "EvolutionEvent", id: "e2" });
    expect(getLastEventId()).toBe("e2");
  });

  it("getLastEventId returns null when no events", () => {
    expect(getLastEventId()).toBeNull();
  });

  it("readAllEvents returns empty for missing file", () => {
    expect(readAllEvents()).toEqual([]);
  });
});

describe("appendCandidateJsonl / readRecentCandidates", () => {
  it("appends and reads candidates", () => {
    appendCandidateJsonl({ id: "cand1" });
    appendCandidateJsonl({ id: "cand2" });
    appendCandidateJsonl({ id: "cand3" });

    const recent = readRecentCandidates(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].id).toBe("cand2");
    expect(recent[1].id).toBe("cand3");
  });

  it("readRecentCandidates returns empty for missing file", () => {
    expect(readRecentCandidates()).toEqual([]);
  });
});

describe("upsertGene", () => {
  it("inserts a new gene", () => {
    const gene = {
      type: "Gene",
      id: "new_gene",
      category: "test",
      signals_match: [],
      preconditions: [],
      strategy: [],
      constraints: {},
      validation: [],
    };
    upsertGene(gene);
    const genes = loadGenes();
    const found = genes.find((g) => g.id === "new_gene");
    expect(found).toBeTruthy();
  });

  it("updates existing gene by id", () => {
    const gene1 = {
      type: "Gene",
      id: "g1",
      category: "old",
      signals_match: [],
      preconditions: [],
      strategy: [],
      constraints: {},
      validation: [],
    };
    upsertGene(gene1);

    const gene2 = { ...gene1, category: "new" };
    upsertGene(gene2);

    const genes = loadGenes();
    const matches = genes.filter((g) => g.id === "g1");
    expect(matches).toHaveLength(1);
    expect(matches[0].category).toBe("new");
  });
});

describe("appendCapsule", () => {
  it("appends capsule to capsules file", () => {
    appendCapsule({ type: "Capsule", id: "c1" });
    appendCapsule({ type: "Capsule", id: "c2" });
    const capsules = loadCapsules();
    expect(capsules).toHaveLength(2);
  });
});

describe("upsertCapsule", () => {
  it("does nothing for invalid capsule", () => {
    upsertCapsule({ type: "Other", id: "x" });
    upsertCapsule({ type: "Capsule", id: "" });
    const capsules = loadCapsules();
    expect(capsules).toEqual([]);
  });

  it("inserts new capsule", () => {
    upsertCapsule({ type: "Capsule", id: "c1" });
    const capsules = loadCapsules();
    expect(capsules).toHaveLength(1);
    expect(capsules[0].id).toBe("c1");
  });

  it("updates existing capsule by id", () => {
    upsertCapsule({ type: "Capsule", id: "c1", score: 0.5 } as any);
    upsertCapsule({ type: "Capsule", id: "c1", score: 0.9 } as any);
    const capsules = loadCapsules();
    const matches = capsules.filter((c) => c.id === "c1");
    expect(matches).toHaveLength(1);
    expect((matches[0] as any).score).toBe(0.9);
  });
});

describe("atomic writes", () => {
  it("genes file is written atomically (no .tmp leftover)", () => {
    upsertGene({
      type: "Gene",
      id: "g1",
      category: "test",
      signals_match: [],
      preconditions: [],
      strategy: [],
      constraints: {},
      validation: [],
    });
    const files = fs.readdirSync(tmpDir);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});
