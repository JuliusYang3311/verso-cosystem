/**
 * runner.ts
 * Integrated evolver runner. Replaces skills/evolver-1.10.0/index.js and scripts/evolver-daemon.ts.
 * Runs the evolution cycle directly from src/ without spawning external skill processes.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { createSubsystemLogger } from "../logging/subsystem.js";

const logger = createSubsystemLogger("evolver-runner");

// ---------- Types ----------

export type EvolverRunMode = "single" | "loop";

export type EvolverRunOptions = {
  mode: EvolverRunMode;
  review?: boolean;
  dryRun?: boolean;
  workspace?: string;
  /** If true, src/ changes require user approval before deploy. */
  requireReview?: boolean;
  /** Model string from main session (e.g. "anthropic/claude-opus-4-6"). */
  model?: string;
  /** Agent dir path for auth store access (resolves auth on demand, not snapshotted). */
  agentDir?: string;
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
  /** The GEP prompt that was used, for LLM acceptance evaluation. */
  gepPrompt?: string;
  /** Sandbox directory containing the changes (caller must clean up). */
  sandboxDir?: string;
  /** Cleanup function for the sandbox (call after acceptance/deploy). */
  cleanupSandbox?: () => void;
};

// ---------- Helpers ----------

function getEvolverRoot(): string {
  return path.resolve(__dirname);
}

function getWorkspaceRoot(override?: string): string {
  if (override) {
    return override;
  }
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
  const t = Math.max(0, ms);
  return new Promise((resolve) => setTimeout(resolve, t));
}

function readJsonSafe(p: string): unknown {
  try {
    if (!fs.existsSync(p)) {
      return null;
    }
    const raw = fs.readFileSync(p, "utf8");
    if (!raw.trim()) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isPendingSolidify(state: unknown): boolean {
  const s = state as { last_run?: { run_id?: string }; last_solidify?: { run_id?: string } } | null;
  const lastRun = s?.last_run ?? null;
  const lastSolid = s?.last_solidify ?? null;
  if (!lastRun?.run_id) {
    return false;
  }
  if (!lastSolid?.run_id) {
    return true;
  }
  return String(lastSolid.run_id) !== String(lastRun.run_id);
}

/**
 * Sync last_solidify.run_id to match last_run.run_id so the daemon
 * doesn't get stuck in the pending-solidify sleep loop after a failed cycle.
 */
function clearPendingSolidify(solidifyStatePath: string): void {
  try {
    const state = readJsonSafe(solidifyStatePath) as {
      last_run?: { run_id?: string };
      last_solidify?: { run_id?: string };
    } | null;
    if (!state?.last_run?.run_id) {
      return;
    }
    if (!state.last_solidify) {
      state.last_solidify = {};
    }
    state.last_solidify.run_id = state.last_run.run_id;
    fs.writeFileSync(solidifyStatePath, JSON.stringify(state, null, 2) + "\n");
  } catch {
    // best-effort
  }
}

function parseMs(v: string | number | undefined | null, fallback: number): number {
  const n = parseInt(String(v == null ? "" : v), 10);
  if (Number.isFinite(n)) {
    return Math.max(0, n);
  }
  return fallback;
}

// ---------- Core Evolution Cycle ----------

/**
 * Run a single evolution cycle using the integrated evolve.js module.
 * Generates a GEP prompt, then runs a coding agent in a sandbox to execute it.
 */
export async function runEvolutionCycle(options: EvolverRunOptions): Promise<RunCycleResult> {
  const workspace = getWorkspaceRoot(options.workspace);
  const t0 = Date.now();

  try {
    // Set environment for the evolve module
    process.env.OPENCLAW_WORKSPACE = workspace;
    process.env.VERSO_WORKSPACE = workspace;
    if (!process.env.MEMORY_DIR) {
      process.env.MEMORY_DIR = path.join(workspace, "memory");
    }
    // Propagate model/auth references so evolve module can use them
    if (options.model) {
      process.env.EVOLVER_MODEL = options.model;
    }
    if (options.agentDir) {
      process.env.EVOLVER_AGENT_DIR = options.agentDir;
    }

    // 1. Generate GEP prompt
    const evolve = (await import("./evolve.js")) as {
      run: () => Promise<{ prompt: string; meta: Record<string, unknown> } | null>;
    };
    const evolveResult = await evolve.run();

    if (!evolveResult) {
      const elapsed = Date.now() - t0;
      logger.info("evolver-runner: cycle skipped (no prompt generated)", { elapsed_ms: elapsed });
      return { ok: true, elapsed };
    }

    // 2. Create sandbox and run coding agent
    const { createTmpdirSandbox, cleanupTmpdir } = await import("./gep/sandbox-runner.js");
    const { runCodingAgentInSandbox } = await import("./sandbox-agent.js");

    const sandbox = createTmpdirSandbox(workspace);
    if (!sandbox.ok || !sandbox.sandboxDir) {
      const elapsed = Date.now() - t0;
      logger.warn("evolver-runner: sandbox creation failed", { error: sandbox.error });
      return { ok: false, error: `Sandbox creation failed: ${sandbox.error}`, elapsed };
    }

    const agentResult = await runCodingAgentInSandbox({
      prompt: evolveResult.prompt,
      sandboxDir: sandbox.sandboxDir,
    });

    const elapsed = Date.now() - t0;

    if (!agentResult.ok) {
      cleanupTmpdir(sandbox.sandboxDir);
      logger.warn("evolver-runner: sandbox agent failed", {
        error: agentResult.error,
        elapsed_ms: elapsed,
      });
      return { ok: false, error: agentResult.error, elapsed };
    }

    // Don't copy to workspace yet — return sandbox for acceptance testing.
    // Caller is responsible for deploying accepted changes and cleaning up.
    logger.info("evolver-runner: cycle completed, pending acceptance", { elapsed_ms: elapsed });
    return {
      ok: true,
      elapsed,
      filesChanged: agentResult.filesChanged,
      gepPrompt: evolveResult.prompt,
      sandboxDir: sandbox.sandboxDir,
      cleanupSandbox: () => cleanupTmpdir(sandbox.sandboxDir),
    };
  } catch (error) {
    const elapsed = Date.now() - t0;
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn("evolver-runner: cycle failed", { error: msg, elapsed_ms: elapsed });
    return { ok: false, error: msg, elapsed };
  }
}

// ---------- Deploy from Sandbox ----------

function deploySandboxToWorkspace(
  sandboxDir: string,
  workspace: string,
  filesChanged: string[],
): void {
  // Skip memory/ files — managed by runtime, not evolver
  const DEPLOY_SKIP_PREFIXES = ["memory/", "memory\\"];
  for (const file of filesChanged) {
    if (DEPLOY_SKIP_PREFIXES.some((p) => file.startsWith(p))) continue;
    const src = path.join(sandboxDir, file);
    const dst = path.join(workspace, file);
    if (fs.existsSync(src) && fs.statSync(src).isFile()) {
      const dir = path.dirname(dst);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.copyFileSync(src, dst);
    }
  }
  logger.info("evolver-runner: deployed sandbox changes to workspace", {
    fileCount: filesChanged.length,
  });
}

// ---------- Chat Notification ----------

async function notifyUser(message: string): Promise<void> {
  try {
    const { callGateway } = await import("../gateway/call.js");
    await callGateway({
      method: "chat.inject",
      params: {
        sessionKey: "agent:main:main",
        message,
      },
      timeoutMs: 10_000,
    });
  } catch {
    // Best-effort — gateway may not be running
    logger.warn("evolver-runner: failed to notify user via chat.inject");
  }
}

function appendErrorRecord(workspace: string, errorType: string, details: unknown): void {
  const errorsPath = path.join(getEvolverRoot(), "assets", "gep", "errors.jsonl");
  const dir = path.dirname(errorsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const record = {
    type: "ErrorRecord",
    timestamp: nowIso(),
    error_type: errorType,
    details,
  };
  fs.appendFileSync(errorsPath, JSON.stringify(record) + "\n");
}

// ---------- Auto-Deploy (Local Git Commit) ----------

function autoCommitChanges(workspace: string): void {
  // Check if there are changes to commit
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: workspace,
    encoding: "utf-8",
  });
  const changes = (status.stdout ?? "").trim();
  if (!changes) {
    logger.info("evolver-runner: no changes to commit");
    return;
  }

  // Build a summary from changed files
  const files = changes
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^.{3}/, "").trim());
  const fileCount = files.length;
  const summary =
    fileCount <= 5 ? files.join(", ") : `${files.slice(0, 3).join(", ")} and ${fileCount - 3} more`;

  // Stage all changes
  const addResult = spawnSync("git", ["add", "-A"], {
    cwd: workspace,
    encoding: "utf-8",
  });
  if (addResult.status !== 0) {
    logger.warn("evolver-runner: git add failed", { stderr: addResult.stderr });
    return;
  }

  // Commit with evolver prefix
  const message = `evolve: auto-deploy ${fileCount} file(s) — ${summary}`;
  const commitResult = spawnSync("git", ["commit", "-m", message], {
    cwd: workspace,
    encoding: "utf-8",
  });
  if (commitResult.status !== 0) {
    logger.warn("evolver-runner: git commit failed", { stderr: commitResult.stderr });
    return;
  }

  logger.info("evolver-runner: auto-deployed", { files: fileCount, message });
}

// ---------- Daemon Loop ----------

/**
 * Run the evolver in continuous daemon loop mode.
 * This replaces both index.js --loop and scripts/evolver-daemon.ts.
 */
export async function runDaemonLoop(options: EvolverRunOptions): Promise<never> {
  const workspace = getWorkspaceRoot(options.workspace);

  // Read review mode dynamically each cycle so config changes take effect
  // without restarting the daemon.
  function isReviewMode(): boolean {
    // 1. Check live config file
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
    // 2. Fallback to startup option
    return options.review ?? false;
  }

  const minSleepMs = parseMs(process.env.EVOLVER_MIN_SLEEP_MS, 2000);
  const maxSleepMs = parseMs(process.env.EVOLVER_MAX_SLEEP_MS, 300000);
  const idleThresholdMs = parseMs(process.env.EVOLVER_IDLE_THRESHOLD_MS, 500);
  const pendingSleepMs = parseMs(process.env.EVOLVE_PENDING_SLEEP_MS, 120000);
  const maxCyclesPerProcess = parseMs(process.env.EVOLVER_MAX_CYCLES_PER_PROCESS, 100) || 100;
  const maxRssMb = parseMs(process.env.EVOLVER_MAX_RSS_MB, 500) || 500;

  const solidifyStatePath = path.join(
    process.env.MEMORY_DIR || path.join(workspace, "memory"),
    "evolution",
    "evolution_solidify_state.json",
  );

  let currentSleepMs = minSleepMs;
  let cycleCount = 0;

  logger.info("evolver-runner: daemon loop started", {
    workspace,
    model: options.model || "(default)",
    agentDir: options.agentDir || "(none)",
  });

  while (true) {
    cycleCount += 1;

    // Gate: do not run a new cycle while previous run is pending solidify
    const state = readJsonSafe(solidifyStatePath);
    if (isPendingSolidify(state)) {
      await sleepMs(Math.max(pendingSleepMs, minSleepMs));
      continue;
    }

    const result = await runEvolutionCycle(options);

    if (result.ok && (result.filesChanged ?? []).length > 0 && result.sandboxDir) {
      // Run acceptance on the SANDBOX (not workspace) — changes haven't been deployed yet
      const { runEvolverAcceptance } = await import("./acceptance.js");
      const acceptance = await runEvolverAcceptance({
        workspaceDir: result.sandboxDir,
        filesChanged: result.filesChanged ?? [],
        gepPrompt: result.gepPrompt,
      });

      logger.info("evolver-runner: acceptance result", {
        passed: acceptance.passed,
        confidence: acceptance.confidence,
        verifyCmd: acceptance.verifyCmd,
        verifyPassed: acceptance.verifyPassed,
        reasoning: acceptance.reasoning?.slice(0, 200),
      });

      const filesList = (result.filesChanged ?? []).slice(0, 5).join(", ");
      const filesNote =
        (result.filesChanged ?? []).length > 5
          ? ` (and ${(result.filesChanged ?? []).length - 5} more)`
          : "";

      if (acceptance.passed) {
        if (!isReviewMode()) {
          // Deploy and commit immediately
          deploySandboxToWorkspace(result.sandboxDir, workspace, result.filesChanged ?? []);
          result.cleanupSandbox?.();
          autoCommitChanges(workspace);
          await notifyUser(
            `🧬 **Evolver cycle ${cycleCount} deployed** — ${(result.filesChanged ?? []).length} file(s) changed: ${filesList}${filesNote}\n` +
              `Confidence: ${acceptance.confidence}% | ${acceptance.reasoning?.slice(0, 150) ?? ""}`,
          );
        } else {
          // Write pending review — keep sandbox alive until user decides
          const { writePendingReview, readPendingReview, clearPendingReview } =
            await import("./evolver-review.js");
          writePendingReview({
            createdAt: new Date().toISOString(),
            cycleId: `cycle_${cycleCount}`,
            filesChanged: result.filesChanged ?? [],
            summary: `Evolution cycle ${cycleCount} completed. ${(result.filesChanged ?? []).length} file(s) changed. Acceptance: ${acceptance.reasoning?.slice(0, 200) ?? "passed"}`,
          });

          // Notify user and prompt for decision
          await notifyUser(
            `🧬 **Evolver cycle ${cycleCount} ready for review** — ${(result.filesChanged ?? []).length} file(s) changed: ${filesList}${filesNote}\n` +
              `Confidence: ${acceptance.confidence}% | ${acceptance.reasoning?.slice(0, 150) ?? ""}\n\n` +
              `To accept: \`/evolve approve\`\n` +
              `To reject: \`/evolve reject\``,
          );

          // Poll until user decides
          let deployed = false;
          while (true) {
            await sleepMs(5000);
            const review = readPendingReview();
            if (!review || review.decision) {
              if (review?.decision === "approve") {
                deploySandboxToWorkspace(result.sandboxDir, workspace, result.filesChanged ?? []);
                autoCommitChanges(workspace);
                deployed = true;
                logger.info("evolver-runner: review approved, changes deployed");
              } else {
                logger.info("evolver-runner: review rejected, sandbox discarded");
              }
              clearPendingReview();
              break;
            }
          }
          result.cleanupSandbox?.();
          if (!deployed) {
            // Nothing was deployed — no action needed
          }
        }
      } else {
        // Acceptance failed — discard sandbox, log error. Workspace is untouched.
        result.cleanupSandbox?.();
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
      }
    } else {
      // Cycle failed or no changes — clean up sandbox if present
      result.cleanupSandbox?.();
      if (!result.ok) {
        clearPendingSolidify(solidifyStatePath);
        if (result.error) {
          appendErrorRecord(workspace, "run_failed", { error: result.error });
        }
      }
    }

    // Adaptive sleep
    const elapsed = result.elapsed ?? 0;
    if (!result.ok || elapsed < idleThresholdMs) {
      currentSleepMs = Math.min(maxSleepMs, Math.max(minSleepMs, currentSleepMs * 2));
    } else {
      currentSleepMs = minSleepMs;
    }

    // Memory leak protection: restart process if limits exceeded
    const memMb = process.memoryUsage().rss / 1024 / 1024;
    if (cycleCount >= maxCyclesPerProcess || memMb > maxRssMb) {
      logger.info("evolver-runner: restarting (memory/cycle limit)", {
        cycles: cycleCount,
        rssMb: Math.round(memMb),
      });
      process.exit(0); // Parent supervisor will restart
    }

    // Jitter to avoid lockstep
    const jitter = Math.floor(Math.random() * 250);
    await sleepMs(currentSleepMs + jitter);
  }
}
