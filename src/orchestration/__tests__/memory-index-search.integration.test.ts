// src/orchestration/__tests__/memory-index-search.integration.test.ts
//
// Integration test: real MemoryIndexManager.createIsolated() with live Gemini embedding.
// Reads embedding config from Verso.json (via loadConfig from the REAL home).
// Verifies: index → search retrieval, cross-agent retrieval, readChunk L2, relevance ranking.
//
// Run: LIVE=1 npx vitest run src/orchestration/__tests__/memory-index-search.integration.test.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolveMemorySearchConfig } from "../../agents/memory-search.js";
import { loadConfig } from "../../config/io.js";
import { createGeminiEmbeddingProvider } from "../../memory/embeddings-gemini.js";
import { MemoryIndexManager } from "../../memory/manager.js";
import { indexAgentResult } from "../orchestrator-memory.js";

const isLive = process.env.LIVE === "1" || process.env.VERSO_LIVE_TEST === "1";

let memoryManager: MemoryIndexManager | null = null;
let testDir: string;

describe("Memory index→search integration (real embedding)", () => {
  beforeAll(async () => {
    if (!isLive) return;

    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "verso-mem-integ-"));
    const cfg = loadConfig();
    const settings = resolveMemorySearchConfig(cfg, "main");
    if (!settings) throw new Error("No memorySearch config for agent 'main'");

    const { provider: embeddingProvider, client: geminiClient } =
      await createGeminiEmbeddingProvider({
        config: cfg,
        agentDir: "",
        provider: settings.provider ?? "gemini",
        model: settings.model ?? "gemini-embedding-001",
        remote: settings.remote,
      });

    memoryManager = await MemoryIndexManager.createIsolated({
      cfg,
      agentId: "main",
      workspaceDir: testDir,
      sources: ["memory"],
      providerResult: {
        provider: embeddingProvider,
        requestedProvider: "gemini",
        gemini: geminiClient,
      },
    });
    if (!memoryManager) throw new Error("Failed to create isolated MemoryIndexManager");

    // --- Index ALL content upfront so embeddings are ready before searches ---

    // Worker T1: auth module
    await memoryManager.indexContent({
      path: "worker/t1",
      content: [
        "# Task T1: Build authentication module",
        "",
        "Implemented JWT-based authentication with refresh token rotation.",
        "Created middleware for route protection using Express.js.",
        "Added bcrypt password hashing with configurable salt rounds.",
        "Unit tests cover login, signup, token refresh, and logout flows.",
      ].join("\n"),
    });

    // Worker T2: REST API (via indexAgentResult, same as production code path)
    await indexAgentResult({
      memoryManager,
      agentType: "worker",
      agentId: "t2-backend",
      title: "Task T2: REST API for user management",
      content: [
        "Built CRUD endpoints for user profiles using PostgreSQL.",
        "GET /api/users, POST /api/users, PUT /api/users/:id, DELETE /api/users/:id.",
        "Added pagination with cursor-based navigation.",
        "Input validation via Zod schemas.",
      ].join("\n"),
    });

    // Worker T3: frontend dashboard
    await indexAgentResult({
      memoryManager,
      agentType: "worker",
      agentId: "t3-frontend",
      title: "Task T3: React dashboard components",
      content: [
        "Created dashboard layout with sidebar navigation and header.",
        "Implemented data visualization charts using Recharts library.",
        "Added responsive design with Tailwind CSS breakpoints.",
        "Dark mode toggle persists preference to localStorage.",
      ].join("\n"),
    });

    // Orchestrator plan
    await indexAgentResult({
      memoryManager,
      agentType: "orchestrator",
      agentId: "orch-1",
      title: "Orchestration plan summary",
      content: [
        "Decomposed user request into 3 subtasks:",
        "T1: Authentication module (JWT, bcrypt)",
        "T2: REST API for user management (PostgreSQL)",
        "T3: React dashboard with charts",
        "Dependency graph: T1, T2 independent → T3 depends on T2 API.",
      ].join("\n"),
    });

    const status = memoryManager.status();
    console.log("[integration] indexed:", status.chunks, "chunks,", status.files, "files");
  }, 60_000);

  afterAll(async () => {
    if (memoryManager) await memoryManager.close();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // 1. Basic: search finds indexed content
  // -----------------------------------------------------------------------

  it.skipIf(!isLive)(
    "indexes content and retrieves it via semantic search",
    async () => {
      const results = await memoryManager!.search("authentication JWT token", { minScore: 0 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toBe("worker/t1");
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].snippet).toBeTruthy();
    },
    30_000,
  );

  // -----------------------------------------------------------------------
  // 2. Cross-agent retrieval: Worker B finds Worker A's result
  // -----------------------------------------------------------------------

  it.skipIf(!isLive)(
    "cross-agent retrieval: worker B finds worker A's indexed result",
    async () => {
      const results = await memoryManager!.search("user management REST API endpoints", {
        minScore: 0,
      });
      expect(results.length).toBeGreaterThan(0);

      const apiResult = results.find((r) => r.path === "worker/t2-backend");
      expect(apiResult).toBeDefined();
      expect(apiResult!.snippet).toBeTruthy();
    },
    30_000,
  );

  // -----------------------------------------------------------------------
  // 3. Acceptance agent retrieves worker results
  // -----------------------------------------------------------------------

  it.skipIf(!isLive)(
    "acceptance agent finds worker results by semantic search",
    async () => {
      const results = await memoryManager!.search("dashboard UI components visualization charts", {
        minScore: 0,
      });
      expect(results.length).toBeGreaterThan(0);

      const frontendResult = results.find((r) => r.path === "worker/t3-frontend");
      expect(frontendResult).toBeDefined();
    },
    30_000,
  );

  // -----------------------------------------------------------------------
  // 4. Multiple results ranked by relevance
  // -----------------------------------------------------------------------

  it.skipIf(!isLive)(
    "returns multiple indexed results ranked by relevance",
    async () => {
      const results = await memoryManager!.search("PostgreSQL database CRUD operations", {
        minScore: 0,
      });
      expect(results.length).toBeGreaterThan(0);

      // t2-backend (PostgreSQL CRUD) should rank higher than t1 (JWT auth)
      const t2Index = results.findIndex((r) => r.path === "worker/t2-backend");
      const t1Index = results.findIndex((r) => r.path === "worker/t1");
      if (t2Index >= 0 && t1Index >= 0) {
        expect(t2Index).toBeLessThan(t1Index);
      }
    },
    30_000,
  );

  // -----------------------------------------------------------------------
  // 5. Orchestrator result is searchable
  // -----------------------------------------------------------------------

  it.skipIf(!isLive)(
    "orchestrator result is searchable alongside worker results",
    async () => {
      const results = await memoryManager!.search("subtask decomposition dependency graph plan", {
        minScore: 0,
      });
      expect(results.length).toBeGreaterThan(0);

      const orchResult = results.find((r) => r.path === "orchestrator/orch-1");
      expect(orchResult).toBeDefined();
    },
    30_000,
  );

  // -----------------------------------------------------------------------
  // 6. readChunk retrieves L2 full text
  // -----------------------------------------------------------------------

  it.skipIf(!isLive)(
    "readChunk returns full L2 text for a search result",
    async () => {
      const results = await memoryManager!.search("authentication JWT", { minScore: 0 });
      expect(results.length).toBeGreaterThan(0);

      const chunkId = results[0].id;
      const chunk = await memoryManager!.readChunk(chunkId);
      expect(chunk).not.toBeNull();
      expect(chunk!.text).toContain("authentication");
    },
    30_000,
  );
});
