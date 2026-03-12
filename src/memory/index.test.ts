import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

let embedBatchCalls = 0;
let failEmbeddings = false;

vi.mock("./embeddings.js", () => {
  const embedText = (text: string) => {
    const lower = text.toLowerCase();
    const alpha = lower.split("alpha").length - 1;
    const beta = lower.split("beta").length - 1;
    return [alpha, beta];
  };
  return {
    createEmbeddingProvider: async (options: { model?: string }) => ({
      requestedProvider: "openai",
      provider: {
        id: "mock",
        model: options.model ?? "mock-embed",
        embedQuery: async (text: string) => embedText(text),
        embedBatch: async (texts: string[]) => {
          embedBatchCalls += 1;
          if (failEmbeddings) {
            throw new Error("mock embeddings failed");
          }
          return texts.map(embedText);
        },
      },
    }),
  };
});

describe("memory index", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    embedBatchCalls = 0;
    failEmbeddings = false;
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "verso-mem-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-01-12.md"),
      "# Log\nAlpha memory line.\nZebra memory line.\nAnother line.",
    );
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Beta knowledge base entry.");
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("indexes memory files and searches by vector", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: { minScore: 0 },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    await result.manager.sync({ force: true });
    const results = await result.manager.search("alpha");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toContain("memory/2026-01-12.md");
    const status = result.manager.status();
    expect(status.sourceCounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "memory",
          files: status.files,
          chunks: status.chunks,
        }),
      ]),
    );
  });

  it("reindexes when the embedding model changes", async () => {
    const base = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: { minScore: 0 },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };

    const first = await getMemorySearchManager({
      cfg: {
        ...base,
        agents: {
          ...base.agents,
          defaults: {
            ...base.agents.defaults,
            memorySearch: {
              ...base.agents.defaults.memorySearch,
              model: "mock-embed-v1",
            },
          },
        },
      },
      agentId: "main",
    });
    expect(first.manager).not.toBeNull();
    if (!first.manager) {
      throw new Error("manager missing");
    }
    await first.manager.sync({ force: true });
    await first.manager.close();

    const second = await getMemorySearchManager({
      cfg: {
        ...base,
        agents: {
          ...base.agents,
          defaults: {
            ...base.agents.defaults,
            memorySearch: {
              ...base.agents.defaults.memorySearch,
              model: "mock-embed-v2",
            },
          },
        },
      },
      agentId: "main",
    });
    expect(second.manager).not.toBeNull();
    if (!second.manager) {
      throw new Error("manager missing");
    }
    manager = second.manager;
    await second.manager.sync({ reason: "test" });
    const results = await second.manager.search("alpha");
    expect(results.length).toBeGreaterThan(0);
  });

  it("reuses cached embeddings on forced reindex", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0 },
            cache: { enabled: true },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    await manager.sync({ force: true });
    const afterFirst = embedBatchCalls;
    expect(afterFirst).toBeGreaterThan(0);

    await manager.sync({ force: true });
    expect(embedBatchCalls).toBe(afterFirst);
  });

  it("preserves existing index when forced reindex fails", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0 },
            cache: { enabled: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;

    await manager.sync({ force: true });
    const before = manager.status();
    expect(before.files).toBeGreaterThan(0);

    failEmbeddings = true;
    await expect(manager.sync({ force: true })).rejects.toThrow(/mock embeddings failed/i);

    const after = manager.status();
    expect(after.files).toBe(before.files);
    expect(after.chunks).toBe(before.chunks);

    const files = await fs.readdir(workspaceDir);
    expect(files.some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("finds keyword matches via hybrid search when query embedding is zero", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: {
              minScore: 0,
              hybrid: { enabled: true, vectorWeight: 0, textWeight: 1 },
            },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;

    const status = manager.status();
    if (!status.fts?.available) {
      return;
    }

    await manager.sync({ force: true });
    const results = await manager.search("zebra");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toContain("memory/2026-01-12.md");
  });

  it("hybrid weights can favor vector-only matches over keyword-only matches", async () => {
    const manyAlpha = Array.from({ length: 200 }, () => "Alpha").join(" ");
    await fs.writeFile(
      path.join(workspaceDir, "memory", "vector-only.md"),
      "Alpha beta. Alpha beta. Alpha beta. Alpha beta.",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", "keyword-only.md"),
      `${manyAlpha} beta id123.`,
    );

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: {
              minScore: 0,

              hybrid: {
                enabled: true,
                vectorWeight: 0.99,
                textWeight: 0.01,
                candidateMultiplier: 10,
              },
            },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;

    const status = manager.status();
    if (!status.fts?.available) {
      return;
    }

    await manager.sync({ force: true });
    const results = await manager.search("alpha beta id123");
    expect(results.length).toBeGreaterThan(0);
    const paths = results.map((r) => r.path);
    expect(paths).toContain("memory/vector-only.md");
    expect(paths).toContain("memory/keyword-only.md");
    const vectorOnly = results.find((r) => r.path === "memory/vector-only.md");
    const keywordOnly = results.find((r) => r.path === "memory/keyword-only.md");
    expect((vectorOnly?.score ?? 0) > (keywordOnly?.score ?? 0)).toBe(true);
  });

  it("hybrid weights can favor keyword matches when text weight dominates", async () => {
    const manyAlpha = Array.from({ length: 200 }, () => "Alpha").join(" ");
    await fs.writeFile(
      path.join(workspaceDir, "memory", "vector-only.md"),
      "Alpha beta. Alpha beta. Alpha beta. Alpha beta.",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", "keyword-only.md"),
      `${manyAlpha} beta id123.`,
    );

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: {
              minScore: 0,

              hybrid: {
                enabled: true,
                vectorWeight: 0.01,
                textWeight: 0.99,
                candidateMultiplier: 10,
              },
            },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;

    const status = manager.status();
    if (!status.fts?.available) {
      return;
    }

    await manager.sync({ force: true });
    const results = await manager.search("alpha beta id123");
    expect(results.length).toBeGreaterThan(0);
    const paths = results.map((r) => r.path);
    expect(paths).toContain("memory/vector-only.md");
    expect(paths).toContain("memory/keyword-only.md");
    const vectorOnly = results.find((r) => r.path === "memory/vector-only.md");
    const keywordOnly = results.find((r) => r.path === "memory/keyword-only.md");
    expect((keywordOnly?.score ?? 0) > (vectorOnly?.score ?? 0)).toBe(true);
  });

  it("reports vector availability after probe", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    const available = await result.manager.probeVectorAvailability();
    const status = result.manager.status();
    expect(status.vector?.enabled).toBe(true);
    expect(typeof status.vector?.available).toBe("boolean");
    expect(status.vector?.available).toBe(available);
  });

  it("rejects reading non-memory paths", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: true },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    await expect(result.manager.readFile({ relPath: "NOTES.md" })).rejects.toThrow("path required");
  });

  it("allows reading from additional memory paths and blocks symlinks", async () => {
    const extraDir = path.join(workspaceDir, "extra");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "extra.md"), "Extra content.");

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            extraPaths: [extraDir],
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    await expect(result.manager.readFile({ relPath: "extra/extra.md" })).resolves.toEqual({
      path: "extra/extra.md",
      text: "Extra content.",
    });

    const linkPath = path.join(extraDir, "linked.md");
    let symlinkOk = true;
    try {
      await fs.symlink(path.join(extraDir, "extra.md"), linkPath, "file");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        symlinkOk = false;
      } else {
        throw err;
      }
    }
    if (symlinkOk) {
      await expect(result.manager.readFile({ relPath: "extra/linked.md" })).rejects.toThrow(
        "path required",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// L1 indexing + search threading + L2 readChunk integration
// ---------------------------------------------------------------------------

describe("memory index — L1/L2 layer integration", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  const cfg = () => ({
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "mock-embed",
          store: { path: indexPath },
          sync: { watch: false, onSessionStart: false, onSearch: true },
          query: { minScore: 0 },
        },
      },
      list: [{ id: "main", default: true }],
    },
  });

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "verso-l1l2-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    // Multi-sentence content so L1 extraction has material to work with
    await fs.writeFile(
      path.join(workspaceDir, "memory", "notes.md"),
      [
        "# Project Notes",
        "",
        "Alpha is the first Greek letter.",
        "Beta is the second Greek letter.",
        "Gamma is the third Greek letter.",
        "Delta is the fourth Greek letter.",
        "These letters are used in mathematics and science.",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("L1: l1_sentences column is written (non-empty JSON array) after indexing", async () => {
    const result = await getMemorySearchManager({ cfg: cfg(), agentId: "main" });
    manager = result.manager!;
    await manager.sync({ force: true });

    // Direct DB inspection via internal field
    const db = (manager as any).db as import("node:sqlite").DatabaseSync;
    const rows = db
      .prepare(`SELECT l1_sentences FROM chunks WHERE source = 'memory'`)
      .all() as Array<{ l1_sentences: string }>;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(() => JSON.parse(row.l1_sentences)).not.toThrow();
      const sentences = JSON.parse(row.l1_sentences) as unknown[];
      expect(Array.isArray(sentences)).toBe(true);
      expect(sentences.length).toBeGreaterThan(0);
      for (const s of sentences as Array<{ text: string; startChar: number; endChar: number }>) {
        expect(typeof s.text).toBe("string");
        expect(s.text.length).toBeGreaterThan(0);
        expect(typeof s.startChar).toBe("number");
        expect(typeof s.endChar).toBe("number");
        expect(s.endChar).toBeGreaterThanOrEqual(s.startChar);
      }
    }
  });

  it("L1: search results include l1Sentences populated from indexed chunks", async () => {
    const result = await getMemorySearchManager({ cfg: cfg(), agentId: "main" });
    manager = result.manager!;
    await manager.sync({ force: true });

    const results = await manager.search("alpha");
    expect(results.length).toBeGreaterThan(0);

    // At least one result should have l1Sentences
    const withL1 = results.filter((r) => r.l1Sentences && r.l1Sentences.length > 0);
    expect(withL1.length).toBeGreaterThan(0);

    for (const r of withL1) {
      expect(Array.isArray(r.l1Sentences)).toBe(true);
      for (const s of r.l1Sentences!) {
        expect(typeof s.text).toBe("string");
        expect(typeof s.startChar).toBe("number");
        expect(typeof s.endChar).toBe("number");
      }
    }
  });

  it("L1: search result snippet is built from l1Sentences text (not raw L2 chunk)", async () => {
    const result = await getMemorySearchManager({ cfg: cfg(), agentId: "main" });
    manager = result.manager!;
    await manager.sync({ force: true });

    const results = await manager.search("alpha");
    const withL1 = results.find((r) => r.l1Sentences && r.l1Sentences.length > 0);
    if (!withL1) return; // skip if no L1 sentences (e.g. very short content)

    // Snippet should be composed of L1 sentence text joined together
    const expectedSnippet = withL1.l1Sentences!.map((s) => s.text).join(" ");
    expect(withL1.snippet).toBe(expectedSnippet);
  });

  it("L2: readChunk() returns full chunk text by ID from search results", async () => {
    const result = await getMemorySearchManager({ cfg: cfg(), agentId: "main" });
    manager = result.manager!;
    await manager.sync({ force: true });

    const results = await manager.search("alpha");
    expect(results.length).toBeGreaterThan(0);

    const first = results[0]!;
    expect(first.id).toBeTruthy();

    // memory_get equivalent: readChunk by ID
    const chunk = await manager.readChunk(first.id);
    expect(chunk).not.toBeNull();
    expect(typeof chunk!.text).toBe("string");
    expect(chunk!.text.length).toBeGreaterThan(0);
    expect(chunk!.path).toContain("notes.md");
    expect(typeof chunk!.startLine).toBe("number");
    expect(typeof chunk!.endLine).toBe("number");

    // L2 text must contain the L1 sentences (L1 is extracted from L2)
    if (first.l1Sentences && first.l1Sentences.length > 0) {
      for (const s of first.l1Sentences) {
        expect(chunk!.text).toContain(s.text.slice(0, 15));
      }
    }
  });

  it("L2: readChunk() with 'chunk:' prefix is equivalent to bare ID", async () => {
    const result = await getMemorySearchManager({ cfg: cfg(), agentId: "main" });
    manager = result.manager!;
    await manager.sync({ force: true });

    const results = await manager.search("alpha");
    const first = results[0]!;

    const byBareId = await manager.readChunk(first.id);
    const byPrefixId = await manager.readChunk(`chunk:${first.id}`);

    expect(byPrefixId).toEqual(byBareId);
  });

  it("L2: readChunk() returns null for unknown chunk ID", async () => {
    const result = await getMemorySearchManager({ cfg: cfg(), agentId: "main" });
    manager = result.manager!;
    await manager.sync({ force: true });

    const chunk = await manager.readChunk("nonexistent-chunk-id-xyz");
    expect(chunk).toBeNull();
  });
});
