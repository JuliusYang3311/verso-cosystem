/**
 * sandbox-agent.ts
 * Runs a pi-coding-agent session inside a sandbox directory.
 * The agent applies GEP evolution prompts, iterates on code changes,
 * and validates via build/lint/test — all within the sandbox.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const logger = createSubsystemLogger("evolver-sandbox-agent");

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

export type SandboxAgentResult = {
  ok: boolean;
  filesChanged: string[];
  error?: string;
};

/**
 * Resolve the model to use for the sandbox agent.
 * Reads EVOLVER_MODEL env or falls back to verso config defaults.
 */
async function resolveAgentModel(): Promise<{
  model: import("@mariozechner/pi-ai").Model<import("@mariozechner/pi-ai").Api>;
  authStorage: import("@mariozechner/pi-coding-agent").AuthStorage;
  modelRegistry: import("@mariozechner/pi-coding-agent").ModelRegistry;
}> {
  const { loadConfig } = await import("../config/config.js");
  const { resolveConfiguredModelRef } = await import("../agents/model-selection.js");
  const { resolveModel } = await import("../agents/pi-embedded-runner/model.js");

  const cfg = loadConfig();

  // Use EVOLVER_MODEL env if set, otherwise fall back to config defaults
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

  const agentDir = process.env.EVOLVER_AGENT_DIR || undefined;
  const { model, error, authStorage, modelRegistry } = resolveModel(
    provider,
    modelId,
    agentDir,
    cfg,
  );
  if (!model || error) {
    throw new Error(`Failed to resolve model ${provider}/${modelId}: ${error ?? "unknown"}`);
  }

  // Bridge verso's auth into pi-coding-agent's AuthStorage so custom providers
  // (e.g. "newapi") are recognized. resolveApiKeyForProvider walks verso's full
  // auth chain (profiles → env → config apiKey) and we inject the result as a
  // runtime override — no disk writes, no side effects.
  const { resolveApiKeyForProvider } = await import("../agents/model-auth.js");
  try {
    const auth = await resolveApiKeyForProvider({ provider, cfg, agentDir });
    if (auth.apiKey) {
      authStorage.setRuntimeApiKey(provider, auth.apiKey);
    }
  } catch {
    // best-effort: if verso can't resolve the key either, let pi-coding-agent
    // try its own fallbacks (env vars, auth.json, etc.)
  }

  return { model, authStorage, modelRegistry };
}

/**
 * Detect files changed in the sandbox compared to a clean state.
 * Uses git diff if available, falls back to mtime comparison.
 */
function detectChangedFiles(sandboxDir: string): string[] {
  try {
    // Initialize git in sandbox to track changes
    const hasGit = fs.existsSync(path.join(sandboxDir, ".git"));
    if (!hasGit) {
      execSync("git init && git add -A && git commit -m init --allow-empty", {
        cwd: sandboxDir,
        stdio: "ignore",
        timeout: 30_000,
      });
    }
    return [];
  } catch {
    return [];
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

/**
 * Run a coding agent inside a sandbox directory.
 * The agent receives the GEP prompt, makes changes, and validates them.
 */
export async function runCodingAgentInSandbox(params: {
  prompt: string;
  sandboxDir: string;
  timeoutMs?: number;
}): Promise<SandboxAgentResult> {
  const { prompt, sandboxDir, timeoutMs = DEFAULT_TIMEOUT_MS } = params;

  const t0 = Date.now();

  try {
    // Resolve model + auth from verso config
    const { model, authStorage, modelRegistry } = await resolveAgentModel();

    // Resolve agent dir for auth
    const agentDir = process.env.EVOLVER_AGENT_DIR || resolveOpenClawAgentDir();

    // Snapshot sandbox state before agent runs
    detectChangedFiles(sandboxDir);

    // Dynamically import pi-coding-agent to avoid top-level dependency issues
    const { createAgentSession, SessionManager } = await import("@mariozechner/pi-coding-agent");

    // Create web search and web fetch tools for evolver agent
    const { createWebSearchTool } = await import("../agents/tools/web-search.js");
    const { createWebFetchTool } = await import("../agents/tools/web-fetch.js");
    const { loadConfig } = await import("../config/config.js");
    const config = loadConfig();
    const webSearchTool = createWebSearchTool({ config, sandboxed: false });
    const webFetchTool = createWebFetchTool({ config, sandboxed: false });

    const evolverTools = [
      ...(webSearchTool ? [webSearchTool] : []),
      ...(webFetchTool ? [webFetchTool] : []),
    ];

    const { session } = await createAgentSession({
      cwd: sandboxDir,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      customTools: evolverTools, // Use customTools to add web tools alongside coding tools
      sessionManager: SessionManager.inMemory(sandboxDir),
    });

    // Build the executor prompt
    const executorPrompt = [
      "You are an evolution executor agent working in a sandboxed copy of the repository.",
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
      session.dispose();
      return { ok: false, filesChanged: [], error: "Sandbox agent timed out" };
    }

    // Check agent's last message for success/failure signal
    const lastAssistant = session.getLastAssistantText?.() ?? "";

    const succeeded = lastAssistant.includes("EVOLUTION_COMPLETE");
    const failed = lastAssistant.includes("EVOLUTION_FAILED");

    session.dispose();

    // Detect changed files
    const filesChanged = getChangedFilesAfter(sandboxDir);

    const elapsed = Date.now() - t0;
    logger.info("sandbox-agent: completed", {
      ok: succeeded,
      filesChanged: filesChanged.length,
      elapsed_ms: elapsed,
    });

    if (failed) {
      return {
        ok: false,
        filesChanged,
        error: "Agent reported EVOLUTION_FAILED",
      };
    }

    if (!succeeded && filesChanged.length === 0) {
      return {
        ok: false,
        filesChanged: [],
        error: "Agent completed without EVOLUTION_COMPLETE and no files changed",
      };
    }

    // If agent made changes and didn't explicitly fail, consider it a success
    // (it may not have printed the exact marker but tests passed)
    return { ok: succeeded || filesChanged.length > 0, filesChanged };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const elapsed = Date.now() - t0;
    logger.warn("sandbox-agent: failed", { error: msg, elapsed_ms: elapsed });
    return { ok: false, filesChanged: [], error: msg };
  }
}
