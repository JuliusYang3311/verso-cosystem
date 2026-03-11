/**
 * sandbox-agent.ts
 * Runs a coding agent prompt inside a sandbox directory using a persistent session.
 *
 * The session is created externally by runner.ts and reused across cycles.
 * This module only drives the prompt + change detection — no session lifecycle.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";

const logger = createSubsystemLogger("evolver-sandbox-agent");

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

export type SandboxAgentResult = {
  ok: boolean;
  filesChanged: string[];
  error?: string;
};

// ---------- Change detection ----------

/**
 * Initialize git in the sandbox to track changes.
 */
function initSandboxGit(sandboxDir: string): void {
  try {
    const hasGit = fs.existsSync(path.join(sandboxDir, ".git"));
    if (!hasGit) {
      execSync("git init && git add -A && git commit -m init --allow-empty", {
        cwd: sandboxDir,
        stdio: "ignore",
        timeout: 30_000,
      });
    }
  } catch {
    // best-effort
  }
}

function getChangedFilesAfter(sandboxDir: string): string[] {
  try {
    const result = execSync(
      "git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null",
      {
        cwd: sandboxDir,
        encoding: "utf-8",
        timeout: 10_000,
      },
    );
    return result
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------- Public API ----------

/**
 * Run a coding agent inside a sandbox directory using a persistent session.
 *
 * The session is NOT created or disposed here — it's owned by runner.ts.
 * Each cycle sends a new prompt to the same session, which accumulates
 * history (compaction handles overflow).
 */
export async function runCodingAgentInSandbox(params: {
  prompt: string;
  sandboxDir: string;
  session: AgentSession;
  timeoutMs?: number;
}): Promise<SandboxAgentResult> {
  const { prompt, sandboxDir, session, timeoutMs = DEFAULT_TIMEOUT_MS } = params;
  const t0 = Date.now();

  try {
    // Snapshot sandbox state before agent runs
    initSandboxGit(sandboxDir);

    // Build the executor prompt — include sandbox path so the persistent
    // session knows where to work this cycle
    const executorPrompt = [
      "You are an evolution executor agent working in a sandboxed copy of the repository.",
      `SANDBOX DIRECTORY: ${sandboxDir}`,
      "Your job: apply the code changes described in the GEP prompt below, then validate them.",
      "",
      "Instructions:",
      "1. Read the GEP prompt carefully to understand what changes are needed.",
      "2. Make the minimal, focused code changes described.",
      "3. After making changes, run validation: npx tsc --noEmit && pnpm lint && pnpm build && pnpm vitest run",
      "4. If validation fails, fix the issues and re-run until all checks pass.",
      "5. When all checks pass, output exactly: EVOLUTION_COMPLETE",
      "",
      "Important:",
      "- Only modify files described in the prompt. Do not make unrelated changes.",
      "- Keep changes minimal and safe.",
      "- If you cannot make the changes work after 3 attempts, output: EVOLUTION_FAILED",
      "",
      "--- GEP PROMPT START ---",
      prompt,
      "--- GEP PROMPT END ---",
    ].join("\n");

    // Run with timeout
    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), timeoutMs),
    );

    const agentPromise = session.prompt(executorPrompt).then(() => "done" as const);
    const result = await Promise.race([agentPromise, timeoutPromise]);

    if (result === "timeout") {
      try {
        await session.abort();
      } catch {
        // ignore abort errors
      }
      return { ok: false, filesChanged: [], error: "Sandbox agent timed out" };
    }

    // Check agent's last message for success/failure signal
    const lastAssistant = session.getLastAssistantText?.() ?? "";
    const succeeded = lastAssistant.includes("EVOLUTION_COMPLETE");
    const failed = lastAssistant.includes("EVOLUTION_FAILED");

    // Detect changed files
    const filesChanged = getChangedFilesAfter(sandboxDir);

    const elapsed = Date.now() - t0;
    logger.info("sandbox-agent: completed", {
      ok: succeeded,
      filesChanged: filesChanged.length,
      elapsed_ms: elapsed,
    });

    if (failed) {
      return { ok: false, filesChanged, error: "Agent reported EVOLUTION_FAILED" };
    }

    if (!succeeded && filesChanged.length === 0) {
      return {
        ok: false,
        filesChanged: [],
        error: "Agent completed without EVOLUTION_COMPLETE and no files changed",
      };
    }

    return { ok: succeeded || filesChanged.length > 0, filesChanged };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const elapsed = Date.now() - t0;
    logger.warn("sandbox-agent: failed", { error: msg, elapsed_ms: elapsed });
    return { ok: false, filesChanged: [], error: msg };
  }
}
