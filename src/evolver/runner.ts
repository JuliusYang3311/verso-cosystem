/**
 * runner.ts
 * Evolver daemon runner with persistent architecture.
 *
 * Lifecycle:
 *   Init (once):  resolveAgentModel → initEvolverMemory → createVersoSession ×2
 *   Loop (cycles): evolve.run → sandbox.prompt → acceptance.prompt → index → deploy/review
 *   Exit:          closeEvolverMemory → process.exit(0)
 *
 * Sessions are in-memory (SessionManager.inMemory()), shared between cycles.
 * Memory is pure SQL at {workspace}/memory/evolver_memory.sql, persistent across restarts.
 */

import { SessionManager } from "@mariozechner/pi-coding-agent";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VersoConfig } from "../config/types.js";
import type { EvolverMemoryContext } from "./evolver-memory.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = createSubsystemLogger("evolver-runner");

// ---------- Types ----------

export type EvolverRunMode = "single" | "loop";

export type EvolverRunOptions = {
  mode: EvolverRunMode;
  review?: boolean;
  dryRun?: boolean;
  workspace?: string;
  requireReview?: boolean;
  /** Model string from main session (e.g. "anthropic/claude-opus-4-6"). */
  model?: string;
  /** Agent dir path for auth store access. */
  agentDir?: string;
  /** Verso config for passing to sub-agents. */
  config?: VersoConfig;
};

export type CodeAgentResult = {
  ok: boolean;
  filesChanged?: string[];
  error?: string;
};

export type RunCycleResult = {
  ok: boolean;
  error?: string;
  elapsed?: number;
  filesChanged?: string[];
  gepPrompt?: string;
  sandboxDir?: string;
  cleanupSandbox?: () => void;
};

// ---------- Helpers ----------

function getEvolverRoot(): string {
  return path.resolve(__dirname);
}

function getWorkspaceRoot(override?: string): string {
  if (override) return override;
  return (
    process.env.VERSO_WORKSPACE ||
    process.env.OPENCLAW_WORKSPACE ||
    path.join(os.homedir(), ".verso", "workspace")
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function readJsonSafe(p: string): unknown {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isPendingSolidify(state: unknown): boolean {
  const s = state as { last_run?: { run_id?: string }; last_solidify?: { run_id?: string } } | null;
  const lastRun = s?.last_run ?? null;
  const lastSolid = s?.last_solidify ?? null;
  if (!lastRun?.run_id) return false;
  if (!lastSolid?.run_id) return true;
  return String(lastSolid.run_id) !== String(lastRun.run_id);
}

function clearPendingSolidify(solidifyStatePath: string): void {
  try {
    const state = readJsonSafe(solidifyStatePath) as {
      last_run?: { run_id?: string };
      last_solidify?: { run_id?: string };
    } | null;
    if (!state?.last_run?.run_id) return;
    if (!state.last_solidify) state.last_solidify = {};
    state.last_solidify.run_id = state.last_run.run_id;
    fs.writeFileSync(solidifyStatePath, JSON.stringify(state, null, 2) + "\n");
  } catch {
    // best-effort
  }
}

function parseMs(v: string | number | undefined | null, fallback: number): number {
  const n = parseInt(String(v == null ? "" : v), 10);
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

// ---------- Model Resolution (shared by both sessions) ----------

async function resolveAgentModel(): Promise<{
  model: import("@mariozechner/pi-ai").Model<import("@mariozechner/pi-ai").Api>;
  authStorage: import("@mariozechner/pi-coding-agent").AuthStorage;
  modelRegistry: import("@mariozechner/pi-coding-agent").ModelRegistry;
  provider: string;
  modelId: string;
  agentDir: string;
}> {
  const { loadConfig } = await import("../config/config.js");
  const { resolveConfiguredModelRef } = await import("../agents/model-selection.js");
  const { resolveModel } = await import("../agents/pi-embedded-runner/model.js");
  const { resolveOpenClawAgentDir } = await import("../agents/agent-paths.js");

  const cfg = loadConfig();

  const envModel = process.env.EVOLVER_MODEL;
  let provider: string;
  let modelId: string;

  if (envModel && envModel.includes("/")) {
    [provider, modelId] = envModel.split("/", 2);
  } else {
    const ref = resolveConfiguredModelRef({
      cfg,
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-20250514",
    });
    provider = ref.provider;
    modelId = ref.model;
  }

  const agentDir = process.env.EVOLVER_AGENT_DIR || resolveOpenClawAgentDir();
  const { model, error, authStorage, modelRegistry } = resolveModel(
    provider,
    modelId,
    agentDir,
    cfg,
  );
  if (!model || error) {
    throw new Error(`Failed to resolve model ${provider}/${modelId}: ${error ?? "unknown"}`);
  }

  // Bridge verso auth into pi-coding-agent's AuthStorage
  const { resolveApiKeyForProvider } = await import("../agents/model-auth.js");
  try {
    const auth = await resolveApiKeyForProvider({ provider, cfg, agentDir });
    if (auth.apiKey) {
      authStorage.setRuntimeApiKey(provider, auth.apiKey);
    }
  } catch {
    // best-effort
  }

  return { model, authStorage, modelRegistry, provider, modelId, agentDir };
}

// ---------- Tool Construction ----------

async function buildSharedTools(params: {
  config: VersoConfig;
  memoryManager: import("../memory/types.js").MemorySearchManager | null;
}): Promise<unknown[]> {
  const { config, memoryManager } = params;
  const tools: unknown[] = [];

  // Web search + fetch
  const { createWebSearchTool } = await import("../agents/tools/web-search.js");
  const { createWebFetchTool } = await import("../agents/tools/web-fetch.js");
  const webSearchTool = createWebSearchTool({ config, sandboxed: false });
  const webFetchTool = createWebFetchTool({ config, sandboxed: false });
  if (webSearchTool) tools.push(webSearchTool);
  if (webFetchTool) tools.push(webFetchTool);

  // Memory search + get
  if (memoryManager) {
    const { createMemorySearchTool, createMemoryGetTool } =
      await import("../agents/tools/memory-tool.js");
    const searchTool = createMemorySearchTool({ config, memoryManager });
    const getTool = createMemoryGetTool({ config, memoryManager });
    if (searchTool) tools.push(searchTool);
    if (getTool) tools.push(getTool);
  }

  return tools;
}

// ---------- Deploy ----------

function deploySandboxToWorkspace(
  sandboxDir: string,
  workspace: string,
  filesChanged: string[],
): void {
  const DEPLOY_SKIP_PREFIXES = ["memory/", "memory\\"];
  for (const file of filesChanged) {
    if (DEPLOY_SKIP_PREFIXES.some((p) => file.startsWith(p))) continue;
    const src = path.join(sandboxDir, file);
    const dst = path.join(workspace, file);
    if (fs.existsSync(src) && fs.statSync(src).isFile()) {
      const dir = path.dirname(dst);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }
  logger.info("Deployed sandbox changes to workspace", { fileCount: filesChanged.length });
}

function autoCommitChanges(workspace: string): void {
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: workspace,
    encoding: "utf-8",
  });
  const changes = (status.stdout ?? "").trim();
  if (!changes) {
    logger.info("No changes to commit");
    return;
  }

  const files = changes
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^.{3}/, "").trim());
  const fileCount = files.length;
  const summary =
    fileCount <= 5 ? files.join(", ") : `${files.slice(0, 3).join(", ")} and ${fileCount - 3} more`;

  const addResult = spawnSync("git", ["add", "-A"], { cwd: workspace, encoding: "utf-8" });
  if (addResult.status !== 0) {
    logger.warn("git add failed", { stderr: addResult.stderr });
    return;
  }

  const message = `evolve: auto-deploy ${fileCount} file(s) — ${summary}`;
  const commitResult = spawnSync("git", ["commit", "-m", message], {
    cwd: workspace,
    encoding: "utf-8",
  });
  if (commitResult.status !== 0) {
    logger.warn("git commit failed", { stderr: commitResult.stderr });
    return;
  }

  logger.info("Auto-deployed", { files: fileCount, message });
}

// ---------- Chat Notification ----------

async function notifyUser(message: string): Promise<void> {
  try {
    const { callGateway } = await import("../gateway/call.js");
    await callGateway({
      method: "chat.inject",
      params: { sessionKey: "agent:main:main", message },
      timeoutMs: 10_000,
    });
  } catch {
    logger.warn("Failed to notify user via chat.inject");
  }
}

function appendErrorRecord(workspace: string, errorType: string, details: unknown): void {
  const errorsPath = path.join(getEvolverRoot(), "assets", "gep", "errors.jsonl");
  const dir = path.dirname(errorsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const record = { type: "ErrorRecord", timestamp: nowIso(), error_type: errorType, details };
  fs.appendFileSync(errorsPath, JSON.stringify(record) + "\n");
}

// ---------- Single Cycle ----------

async function runEvolutionCycle(params: {
  workspace: string;
  options: EvolverRunOptions;
}): Promise<RunCycleResult> {
  const { workspace, options } = params;
  const t0 = Date.now();

  try {
    process.env.OPENCLAW_WORKSPACE = workspace;
    process.env.VERSO_WORKSPACE = workspace;
    if (!process.env.MEMORY_DIR) {
      process.env.MEMORY_DIR = path.join(workspace, "memory");
    }
    if (options.model) process.env.EVOLVER_MODEL = options.model;
    if (options.agentDir) process.env.EVOLVER_AGENT_DIR = options.agentDir;

    // Generate GEP prompt (pure logic, no LLM)
    const evolve = (await import("./evolve.js")) as {
      run: () => Promise<{ prompt: string; meta: Record<string, unknown> } | null>;
    };
    const evolveResult = await evolve.run();

    if (!evolveResult) {
      const elapsed = Date.now() - t0;
      logger.info("Cycle skipped (no prompt generated)", { elapsed_ms: elapsed });
      return { ok: true, elapsed };
    }

    // Create sandbox tmpdir
    const { createTmpdirSandbox, cleanupTmpdir } = await import("./gep/sandbox-runner.js");
    const sandbox = createTmpdirSandbox(workspace);
    if (!sandbox.ok || !sandbox.sandboxDir) {
      const elapsed = Date.now() - t0;
      return { ok: false, error: `Sandbox creation failed: ${sandbox.error}`, elapsed };
    }

    return {
      ok: true,
      elapsed: Date.now() - t0,
      gepPrompt: evolveResult.prompt,
      sandboxDir: sandbox.sandboxDir,
      cleanupSandbox: () => cleanupTmpdir(sandbox.sandboxDir),
    };
  } catch (error) {
    const elapsed = Date.now() - t0;
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn("Cycle prep failed", { error: msg, elapsed_ms: elapsed });
    return { ok: false, error: msg, elapsed };
  }
}

// ---------- Daemon Loop ----------

/**
 * Run the evolver in continuous daemon loop mode with persistent architecture.
 *
 * Init phase (once):
 *   1. resolveAgentModel() → shared model + auth
 *   2. initEvolverMemory() → pure SQL at {workspace}/memory/evolver_memory.sql
 *   3. createVersoSession() × 2 → sandbox + acceptance sessions (in-memory)
 *
 * Loop phase (per cycle):
 *   1. evolve.run() → GEP prompt
 *   2. sandbox tmpdir → sandboxSession.prompt() → detect changes
 *   3. acceptanceSession.prompt() → verdict
 *   4. index results → evolver_memory.sql
 *   5. deploy/review
 *
 * Exit phase:
 *   closeEvolverMemory() → process.exit(0)
 */
export async function runDaemonLoop(options: EvolverRunOptions): Promise<never> {
  const workspace = getWorkspaceRoot(options.workspace);

  // Dynamic review mode — reads config each cycle
  function isReviewMode(): boolean {
    try {
      const stateDir =
        process.env.VERSO_STATE_DIR ||
        process.env.OPENCLAW_STATE_DIR ||
        path.join(os.homedir(), ".verso");
      const cfgPath = path.join(stateDir, "verso.json");
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        if (cfg?.evolver?.review != null) return !!cfg.evolver.review;
      }
    } catch {
      // fallback
    }
    return options.review ?? false;
  }

  const minSleepMs = parseMs(process.env.EVOLVER_MIN_SLEEP_MS, 2000);
  const maxSleepMs = parseMs(process.env.EVOLVER_MAX_SLEEP_MS, 300000);
  const _idleThresholdMs = parseMs(process.env.EVOLVER_IDLE_THRESHOLD_MS, 500);
  const pendingSleepMs = parseMs(process.env.EVOLVE_PENDING_SLEEP_MS, 120000);
  const maxCyclesPerProcess = parseMs(process.env.EVOLVER_MAX_CYCLES_PER_PROCESS, 100) || 100;
  const maxRssMb = parseMs(process.env.EVOLVER_MAX_RSS_MB, 500) || 500;

  const solidifyStatePath = path.join(
    process.env.MEMORY_DIR || path.join(workspace, "memory"),
    "evolution",
    "evolution_solidify_state.json",
  );

  // ═══════════════════════════════════════════════════════════════════════
  // INIT PHASE (once)
  // ═══════════════════════════════════════════════════════════════════════

  // ① Resolve model + auth (shared by both sessions)
  const { model, authStorage, modelRegistry, provider, modelId, agentDir } =
    await resolveAgentModel();

  // Load config
  const { loadConfig } = await import("../config/config.js");
  const config = options.config ?? loadConfig();

  // ② Initialize evolver memory (pure SQL)
  let evolverMemory: EvolverMemoryContext | null = null;
  try {
    const { initEvolverMemory } = await import("./evolver-memory.js");
    evolverMemory = await initEvolverMemory({ workspaceDir: workspace, config });
  } catch (err) {
    logger.warn("Failed to initialize evolver memory (non-fatal)", { error: String(err) });
  }

  // ③ Build shared tools (same as orchestration workers, minus Google Workspace)
  const sharedTools = await buildSharedTools({
    config,
    memoryManager: evolverMemory?.memoryManager ?? null,
  });

  // ④ Create persistent sandbox session (in-memory)
  const { createVersoSession } = await import("../agents/session-factory.js");

  const sandboxCreated = await createVersoSession({
    cwd: workspace,
    agentDir,
    authStorage,
    modelRegistry,
    model,
    customTools: sharedTools as Parameters<typeof createVersoSession>[0]["customTools"],
    memoryManager: evolverMemory?.memoryManager ?? null,
    config,
    provider,
    modelId,
    sessionManager: SessionManager.inMemory(),
  });
  const sandboxSession = sandboxCreated.session;

  // ⑤ Create persistent acceptance session (in-memory)
  const acceptanceCreated = await createVersoSession({
    cwd: workspace,
    agentDir,
    authStorage,
    modelRegistry,
    model,
    customTools: sharedTools as Parameters<typeof createVersoSession>[0]["customTools"],
    memoryManager: evolverMemory?.memoryManager ?? null,
    config,
    provider,
    modelId,
    sessionManager: SessionManager.inMemory(),
  });
  const acceptanceSession = acceptanceCreated.session;

  logger.info("Daemon initialized", {
    workspace,
    model: `${provider}/${modelId}`,
    hasMemory: !!evolverMemory?.memoryManager,
    dbPath: evolverMemory?.dbPath,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // LOOP PHASE
  // ═══════════════════════════════════════════════════════════════════════

  let currentSleepMs = minSleepMs;
  let cycleCount = 0;

  while (true) {
    cycleCount += 1;

    // ═══ Memory leak protection (checked at top so early-continue paths also exit) ═══
    const memMb = process.memoryUsage().rss / 1024 / 1024;
    if (cycleCount > maxCyclesPerProcess || memMb > maxRssMb) {
      logger.info("Restarting (memory/cycle limit)", {
        cycles: cycleCount - 1,
        rssMb: Math.round(memMb),
      });
      if (evolverMemory) {
        const { closeEvolverMemory } = await import("./evolver-memory.js");
        await closeEvolverMemory(evolverMemory).catch(() => {});
      }
      sandboxSession.dispose();
      acceptanceSession.dispose();
      process.exit(0);
    }

    // Gate: do not run while previous run is pending solidify
    const state = readJsonSafe(solidifyStatePath);
    if (isPendingSolidify(state)) {
      await sleepMs(Math.max(pendingSleepMs, minSleepMs));
      continue;
    }

    // Prepare cycle (GEP prompt + sandbox tmpdir)
    const cycle = await runEvolutionCycle({ workspace, options });

    if (!cycle.ok || !cycle.gepPrompt || !cycle.sandboxDir) {
      cycle.cleanupSandbox?.();
      if (!cycle.ok) {
        clearPendingSolidify(solidifyStatePath);
        if (cycle.error) appendErrorRecord(workspace, "run_failed", { error: cycle.error });
      }
      // Adaptive backoff
      currentSleepMs = Math.min(maxSleepMs, Math.max(minSleepMs, currentSleepMs * 2));
      await sleepMs(currentSleepMs + Math.floor(Math.random() * 250));
      continue;
    }

    // Run coding agent (reuse persistent sandbox session)
    const { runCodingAgentInSandbox } = await import("./sandbox-agent.js");
    const agentResult = await runCodingAgentInSandbox({
      prompt: cycle.gepPrompt,
      sandboxDir: cycle.sandboxDir,
      session: sandboxSession,
    });

    if (!agentResult.ok || agentResult.filesChanged.length === 0) {
      cycle.cleanupSandbox?.();
      if (!agentResult.ok) {
        clearPendingSolidify(solidifyStatePath);
        appendErrorRecord(workspace, "sandbox_failed", { error: agentResult.error });
      }
      currentSleepMs = Math.min(maxSleepMs, Math.max(minSleepMs, currentSleepMs * 2));
      await sleepMs(currentSleepMs + Math.floor(Math.random() * 250));
      continue;
    }

    // Run acceptance (reuse persistent acceptance session)
    const { runEvolverAcceptance } = await import("./acceptance.js");
    const acceptance = await runEvolverAcceptance({
      workspaceDir: cycle.sandboxDir,
      filesChanged: agentResult.filesChanged,
      session: acceptanceSession,
      gepPrompt: cycle.gepPrompt,
    });

    logger.info("Acceptance result", {
      passed: acceptance.passed,
      confidence: acceptance.confidence,
      verifyCmd: acceptance.verifyCmd,
      verifyPassed: acceptance.verifyPassed,
      reasoning: acceptance.reasoning?.slice(0, 200),
    });

    // Index results into evolver memory
    if (evolverMemory?.memoryManager) {
      const { indexCycleResult, indexAcceptanceResult } = await import("./evolver-memory.js");
      await indexCycleResult({
        memoryManager: evolverMemory.memoryManager,
        cycleId: String(cycleCount),
        gepPrompt: cycle.gepPrompt,
        filesChanged: agentResult.filesChanged,
        agentOutput: acceptance.reasoning ?? "",
        ok: acceptance.passed,
      }).catch(() => {});
      await indexAcceptanceResult({
        memoryManager: evolverMemory.memoryManager,
        cycleId: String(cycleCount),
        passed: acceptance.passed,
        confidence: acceptance.confidence ?? 0,
        reasoning: acceptance.reasoning ?? "",
        verifyCmd: acceptance.verifyCmd,
        issues: acceptance.issues?.map((i) => `[${i.severity}] ${i.description}`),
      }).catch(() => {});
    }

    const filesList = agentResult.filesChanged.slice(0, 5).join(", ");
    const filesNote =
      agentResult.filesChanged.length > 5
        ? ` (and ${agentResult.filesChanged.length - 5} more)`
        : "";

    if (acceptance.passed) {
      if (!isReviewMode()) {
        // Deploy immediately
        deploySandboxToWorkspace(cycle.sandboxDir, workspace, agentResult.filesChanged);
        cycle.cleanupSandbox?.();
        autoCommitChanges(workspace);
        await notifyUser(
          `🧬 **Evolver cycle ${cycleCount} deployed** — ${agentResult.filesChanged.length} file(s) changed: ${filesList}${filesNote}\n` +
            `Confidence: ${acceptance.confidence}% | ${acceptance.reasoning?.slice(0, 150) ?? ""}`,
        );
      } else {
        // Review mode: block and wait for user decision
        const { writePendingReview, readPendingReview, clearPendingReview } =
          await import("./evolver-review.js");
        writePendingReview({
          createdAt: new Date().toISOString(),
          cycleId: `cycle_${cycleCount}`,
          filesChanged: agentResult.filesChanged,
          summary: `Evolution cycle ${cycleCount} completed. ${agentResult.filesChanged.length} file(s) changed. Acceptance: ${acceptance.reasoning?.slice(0, 200) ?? "passed"}`,
        });

        await notifyUser(
          `🧬 **Evolver cycle ${cycleCount} ready for review** — ${agentResult.filesChanged.length} file(s) changed: ${filesList}${filesNote}\n` +
            `Confidence: ${acceptance.confidence}% | ${acceptance.reasoning?.slice(0, 150) ?? ""}\n\n` +
            `To accept: \`/evolve approve\`\nTo reject: \`/evolve reject\``,
        );

        // Poll until user decides (5s interval)
        let deployed = false;
        while (true) {
          await sleepMs(5000);
          const review = readPendingReview();
          if (!review || review.decision) {
            if (review?.decision === "approve") {
              deploySandboxToWorkspace(cycle.sandboxDir, workspace, agentResult.filesChanged);
              autoCommitChanges(workspace);
              deployed = true;
              logger.info("Review approved, changes deployed");
            } else {
              logger.info("Review rejected, sandbox discarded");
            }
            clearPendingReview();
            break;
          }
        }
        cycle.cleanupSandbox?.();
        if (deployed) {
          await notifyUser(`🧬 Cycle ${cycleCount} deployed after review approval.`);
        }
      }
      // Reset backoff on success
      currentSleepMs = minSleepMs;
    } else {
      // Acceptance failed — discard sandbox
      cycle.cleanupSandbox?.();
      clearPendingSolidify(solidifyStatePath);
      appendErrorRecord(workspace, "acceptance_failed", {
        confidence: acceptance.confidence,
        reasoning: acceptance.reasoning?.slice(0, 2000),
        verifyCmd: acceptance.verifyCmd,
        verifyPassed: acceptance.verifyPassed,
        issues: acceptance.issues?.slice(0, 10),
      });
      await notifyUser(
        `🧬 **Evolver cycle ${cycleCount} rejected** — acceptance failed (confidence: ${acceptance.confidence}%)\n` +
          `${acceptance.reasoning?.slice(0, 300) ?? "No details"}` +
          (acceptance.issues?.length
            ? `\nIssues: ${acceptance.issues.map((i) => `[${i.severity}] ${i.description}`).join("; ")}`
            : ""),
      );
      currentSleepMs = Math.min(maxSleepMs, Math.max(minSleepMs, currentSleepMs * 2));
    }

    // Jitter to avoid lockstep
    await sleepMs(currentSleepMs + Math.floor(Math.random() * 250));
  }
}
