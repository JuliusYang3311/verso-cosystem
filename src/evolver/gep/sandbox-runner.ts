/**
 * sandbox-runner.ts
 * Runs validation tests in an isolated sandbox environment for Evolver code changes.
 * Supports multiple isolation modes: Docker / tmpdir copy / subprocess isolation.
 * Strictly single-threaded, no thread spawning. Auto-resets on errors.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getWorkspaceRoot } from "./paths.js";

// ---------- Constants ----------

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
export const SANDBOX_MODES = ["docker", "tmpdir", "subprocess"] as const;

export type SandboxMode = (typeof SANDBOX_MODES)[number];

// ---------- Types ----------

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

interface ExecOpts {
  cwd?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

interface DockerSandboxResult {
  ok: boolean;
  containerName: string | null;
  error: string | null;
}

interface TmpdirSandboxResult {
  ok: boolean;
  sandboxDir: string | null;
  error: string | null;
}

interface CommandResult {
  command: string;
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  elapsed_ms: number;
}

interface SandboxRunResult {
  ok: boolean;
  mode: string;
  results: CommandResult[];
  elapsed_ms: number;
  error: string | null;
}

interface RunInSandboxParams {
  workspaceRoot?: string;
  commands?: string[];
  mode?: SandboxMode;
  timeoutMs?: number;
}

interface VerifySrcChangesParams {
  workspaceRoot?: string;
}

// ---------- Utility functions ----------

function _nowIso(): string {
  return new Date().toISOString();
}

function tryExec(cmd: string, opts: ExecOpts = {}): ExecResult {
  try {
    const out = execSync(cmd, {
      cwd: opts.cwd || process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeout || DEFAULT_TIMEOUT_MS,
      env: opts.env || process.env,
    });
    return { ok: true, stdout: out, stderr: "", code: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string; status?: number };
    return {
      ok: false,
      stdout: err.stdout ? String(err.stdout) : "",
      stderr: err.stderr ? String(err.stderr) : String(err.message),
      code: err.status ?? 1,
    };
  }
}

/** Detect available sandbox mode (ordered by priority). */
export function detectSandboxMode(): SandboxMode {
  // 1. Check if Docker is available
  const docker = tryExec("docker info", { timeout: 10_000 });
  if (docker.ok) {
    return "docker";
  }

  // 2. tmpdir is always available
  return "tmpdir";
}

// ---------- Docker sandbox ----------

function createDockerSandbox(workspaceRoot: string): DockerSandboxResult {
  const containerName = `evolver-sandbox-${Date.now()}`;

  // Create container: mount workspace as read-only + writable overlay
  const createResult = tryExec(
    `docker create --name ${containerName} ` +
      `--workdir /workspace ` +
      `-v "${workspaceRoot}:/workspace:ro" ` +
      `node:22-slim sh -c "cp -a /workspace /sandbox && cd /sandbox && npm install -g pnpm@10.23.0"`,
    { timeout: 60_000 },
  );

  if (!createResult.ok) {
    return { ok: false, containerName: null, error: createResult.stderr };
  }

  // Start container for initialization
  const startResult = tryExec(`docker start -a ${containerName}`, { timeout: 120_000 });
  if (!startResult.ok) {
    tryExec(`docker rm -f ${containerName}`, { timeout: 10_000 });
    return { ok: false, containerName: null, error: startResult.stderr };
  }

  return { ok: true, containerName, error: null };
}

function runInDocker(containerName: string, cmd: string, timeout?: number): ExecResult {
  return tryExec(`docker exec ${containerName} sh -c "cd /sandbox && ${cmd}"`, {
    timeout: timeout || DEFAULT_TIMEOUT_MS,
  });
}

function cleanupDocker(containerName: string | null): void {
  if (!containerName) {
    return;
  }
  tryExec(`docker rm -f ${containerName}`, { timeout: 10_000 });
}

// ---------- tmpdir sandbox ----------

export function createTmpdirSandbox(workspaceRoot: string): TmpdirSandboxResult {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "evolver-sandbox-"));

  // Copy project using rsync or cp (excluding node_modules, .git, dist)
  const rsyncCheck = tryExec("which rsync", { timeout: 5_000 });

  let copyResult: ExecResult;
  if (rsyncCheck.ok) {
    copyResult = tryExec(
      `rsync -a --exclude=node_modules --exclude=.git --exclude=dist --exclude=build --exclude=memory "${workspaceRoot}/" "${sandboxDir}/"`,
      { timeout: 120_000 },
    );
  } else {
    // Fallback to cp
    copyResult = tryExec(
      `cp -R "${workspaceRoot}" "${sandboxDir}/workspace" 2>/dev/null; ` +
        `rm -rf "${sandboxDir}/workspace/node_modules" "${sandboxDir}/workspace/.git" "${sandboxDir}/workspace/dist" "${sandboxDir}/workspace/memory"`,
      { timeout: 120_000 },
    );
    if (copyResult.ok) {
      // Adjust path - move copied contents to sandboxDir root
      const innerDir = path.join(sandboxDir, "workspace");
      if (fs.existsSync(innerDir)) {
        tryExec(`mv "${innerDir}"/* "${sandboxDir}/" 2>/dev/null; rm -rf "${innerDir}"`, {
          timeout: 30_000,
        });
      }
    }
  }

  if (!copyResult.ok) {
    cleanupTmpdir(sandboxDir);
    return { ok: false, sandboxDir: null, error: copyResult.stderr };
  }

  // Apply current changes (git diff)
  const diffResult = tryExec("git diff HEAD", { cwd: workspaceRoot, timeout: 30_000 });
  if (diffResult.ok && diffResult.stdout.trim()) {
    const patchFile = path.join(sandboxDir, ".evolver-patch.diff");
    fs.writeFileSync(patchFile, diffResult.stdout, "utf8");
    tryExec(`git apply --stat "${patchFile}" 2>/dev/null; git apply "${patchFile}" 2>/dev/null`, {
      cwd: sandboxDir,
      timeout: 30_000,
    });
    try {
      fs.unlinkSync(patchFile);
    } catch {
      // ignore
    }
  }

  // Also copy untracked new files
  const untrackedResult = tryExec("git ls-files --others --exclude-standard", {
    cwd: workspaceRoot,
    timeout: 30_000,
  });
  if (untrackedResult.ok) {
    const entries = untrackedResult.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    // Collect all files, recursively expanding directories
    const filesToCopy: string[] = [];
    const collectFiles = (relPath: string) => {
      const absPath = path.join(workspaceRoot, relPath);
      try {
        const stat = fs.statSync(absPath);
        if (stat.isFile()) {
          filesToCopy.push(relPath);
        } else if (stat.isDirectory()) {
          for (const child of fs.readdirSync(absPath)) {
            collectFiles(path.join(relPath, child));
          }
        }
      } catch {
        // skip entries that can't be stat'd
      }
    };
    for (const entry of entries) {
      collectFiles(entry.replace(/\/$/, ""));
    }

    for (const file of filesToCopy) {
      const srcFile = path.join(workspaceRoot, file);
      const dstFile = path.join(sandboxDir, file);
      const dstDir = path.dirname(dstFile);
      if (!fs.existsSync(dstDir)) {
        fs.mkdirSync(dstDir, { recursive: true });
      }
      try {
        fs.copyFileSync(srcFile, dstFile);
      } catch {
        // skip files that can't be copied
      }
    }
  }

  // Install dependencies (only if package.json exists)
  if (fs.existsSync(path.join(sandboxDir, "package.json"))) {
    const installResult = tryExec("pnpm install --frozen-lockfile 2>/dev/null || pnpm install", {
      cwd: sandboxDir,
      timeout: 180_000,
    });

    if (!installResult.ok) {
      cleanupTmpdir(sandboxDir);
      return { ok: false, sandboxDir: null, error: `pnpm install failed: ${installResult.stderr}` };
    }
  }

  return { ok: true, sandboxDir, error: null };
}

function runInTmpdir(sandboxDir: string, cmd: string, timeout?: number): ExecResult {
  return tryExec(cmd, { cwd: sandboxDir, timeout: timeout || DEFAULT_TIMEOUT_MS });
}

export function cleanupTmpdir(sandboxDir: string | null): void {
  if (!sandboxDir) {
    return;
  }
  try {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ---------- Main entry ----------

/** Run validation tests in a sandbox. */
export function runInSandbox(params?: RunInSandboxParams): SandboxRunResult {
  const {
    workspaceRoot = getWorkspaceRoot(),
    commands = ["npx tsc --noEmit", "pnpm build", "pnpm lint", "pnpm test"],
    mode: requestedMode,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = params || {};

  const startTime = Date.now();
  const mode = requestedMode || detectSandboxMode();
  const results: CommandResult[] = [];
  let sandboxRef: { type: "docker" | "tmpdir"; id: string } | null = null;

  try {
    // 1. Create sandbox
    let sandbox: DockerSandboxResult | TmpdirSandboxResult;
    if (mode === "docker") {
      sandbox = createDockerSandbox(workspaceRoot);
      if (sandbox.ok && sandbox.containerName) {
        sandboxRef = { type: "docker", id: sandbox.containerName };
      }
    } else {
      // Both tmpdir and subprocess modes use tmpdir isolation
      sandbox = createTmpdirSandbox(workspaceRoot);
      if (sandbox.ok && sandbox.sandboxDir) {
        sandboxRef = { type: "tmpdir", id: sandbox.sandboxDir };
      }
    }

    if (!sandbox.ok) {
      return {
        ok: false,
        mode,
        results: [],
        elapsed_ms: Date.now() - startTime,
        error: `sandbox_creation_failed: ${sandbox.error}`,
      };
    }

    // 2. Execute test commands sequentially (strictly single-threaded)
    let allPassed = true;
    for (const cmd of commands) {
      const cmdStart = Date.now();
      let result: ExecResult;

      if (mode === "docker") {
        result = runInDocker(sandboxRef!.id, cmd, timeoutMs);
      } else {
        result = runInTmpdir(sandboxRef!.id, cmd, timeoutMs);
      }

      const cmdResult: CommandResult = {
        command: cmd,
        ok: result.ok,
        code: result.code,
        stdout: truncateOutput(result.stdout, 5000),
        stderr: truncateOutput(result.stderr, 3000),
        elapsed_ms: Date.now() - cmdStart,
      };
      results.push(cmdResult);

      if (!result.ok) {
        allPassed = false;
        break; // Stop on first failure
      }
    }

    return {
      ok: allPassed,
      mode,
      results,
      elapsed_ms: Date.now() - startTime,
      error: allPassed ? null : `command_failed: ${results[results.length - 1]?.command}`,
    };
  } catch (e: unknown) {
    // Auto-reset on error, do not throw
    const err = e as { message?: string };
    return {
      ok: false,
      mode,
      results,
      elapsed_ms: Date.now() - startTime,
      error: `sandbox_error: ${String(err.message || e)}`,
    };
  } finally {
    // 3. Cleanup sandbox
    if (sandboxRef) {
      if (sandboxRef.type === "docker") {
        cleanupDocker(sandboxRef.id);
      } else {
        cleanupTmpdir(sandboxRef.id);
      }
    }
  }
}

function truncateOutput(text: string | undefined | null, maxLen: number): string {
  const s = String(text || "");
  if (s.length <= maxLen) {
    return s;
  }
  return s.slice(0, maxLen) + `\n...[truncated, ${s.length - maxLen} chars omitted]`;
}

/** Convenience method: verify src/ changes by running tsc, build, lint, and test. */
export function verifySrcChanges(params?: VerifySrcChangesParams): SandboxRunResult {
  const { workspaceRoot } = params || {};
  return runInSandbox({
    workspaceRoot,
    commands: ["npx tsc --noEmit", "pnpm build", "pnpm lint", "pnpm test"],
  });
}
