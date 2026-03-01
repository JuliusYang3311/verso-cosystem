// src/orchestration/store.ts — Orchestration state persistence + mission workspace management

import fs from "node:fs";
import path from "node:path";
import type { Orchestration } from "./types.js";
import { resolveStateDir } from "../config/paths.js";

// --- Paths ---

function orchestrationsDir(): string {
  return path.join(resolveStateDir(), "orchestrations");
}

function orchestrationPath(id: string): string {
  return path.join(orchestrationsDir(), `${id}.json`);
}

/**
 * Resolve the mission workspace directory for an orchestration.
 * Each orchestration gets its own isolated workspace under the source workspace.
 * Layout: <sourceWorkspace>/.verso-missions/<orchId>/
 */
export function resolveMissionWorkspace(sourceWorkspaceDir: string, orchId: string): string {
  return path.join(sourceWorkspaceDir, ".verso-missions", orchId);
}

// --- Mission Workspace ---

/**
 * Create the mission workspace by copying/linking essential files from the source workspace.
 * Uses a shallow approach: creates the directory and initializes a git worktree if in a git repo,
 * otherwise copies the workspace.
 */
export async function initMissionWorkspace(
  sourceWorkspaceDir: string,
  orchId: string,
): Promise<string> {
  const missionDir = resolveMissionWorkspace(sourceWorkspaceDir, orchId);

  if (fs.existsSync(missionDir)) {
    return missionDir;
  }

  fs.mkdirSync(missionDir, { recursive: true });

  // Check if source is a git repo
  const gitDir = path.join(sourceWorkspaceDir, ".git");
  if (fs.existsSync(gitDir)) {
    // Use git worktree for efficient isolation
    const { execSync } = await import("node:child_process");
    const branchName = `verso-mission-${orchId}`;
    try {
      execSync(`git worktree add "${missionDir}" -b "${branchName}" HEAD`, {
        cwd: sourceWorkspaceDir,
        stdio: "pipe",
      });
    } catch {
      // Worktree failed (maybe branch exists), fall back to direct copy
      await copyWorkspace(sourceWorkspaceDir, missionDir);
    }
  } else {
    await copyWorkspace(sourceWorkspaceDir, missionDir);
  }

  return missionDir;
}

/**
 * Clean up a mission workspace. Removes the git worktree if applicable, then the directory.
 */
export async function cleanupMissionWorkspace(
  sourceWorkspaceDir: string,
  orchId: string,
): Promise<void> {
  const missionDir = resolveMissionWorkspace(sourceWorkspaceDir, orchId);
  if (!fs.existsSync(missionDir)) {
    return;
  }

  const gitDir = path.join(sourceWorkspaceDir, ".git");
  if (fs.existsSync(gitDir)) {
    const { execSync } = await import("node:child_process");
    try {
      execSync(`git worktree remove "${missionDir}" --force`, {
        cwd: sourceWorkspaceDir,
        stdio: "pipe",
      });
      // Also delete the branch
      const branchName = `verso-mission-${orchId}`;
      try {
        execSync(`git branch -D "${branchName}"`, { cwd: sourceWorkspaceDir, stdio: "pipe" });
      } catch {
        // branch may not exist
      }
      return;
    } catch {
      // worktree removal failed, fall through to rm
    }
  }

  fs.rmSync(missionDir, { recursive: true, force: true });
}

/**
 * Merge changes from mission workspace back to source workspace.
 * For git worktrees, this merges the mission branch into the current branch.
 * For plain copies, this copies changed files back.
 */
export async function mergeMissionWorkspace(
  sourceWorkspaceDir: string,
  orchId: string,
): Promise<{ merged: boolean; error?: string }> {
  const missionDir = resolveMissionWorkspace(sourceWorkspaceDir, orchId);
  if (!fs.existsSync(missionDir)) {
    return { merged: false, error: "Mission workspace not found" };
  }

  const gitDir = path.join(sourceWorkspaceDir, ".git");
  if (fs.existsSync(gitDir)) {
    const { execSync } = await import("node:child_process");
    const branchName = `verso-mission-${orchId}`;
    try {
      // Commit any uncommitted changes in the mission workspace
      try {
        execSync(
          `git add -A && git diff --cached --quiet || git commit -m "verso-mission: ${orchId} completed"`,
          {
            cwd: missionDir,
            stdio: "pipe",
            shell: "/bin/bash",
          },
        );
      } catch {
        // nothing to commit
      }
      // Merge mission branch into current branch
      execSync(`git merge "${branchName}" --no-edit`, {
        cwd: sourceWorkspaceDir,
        stdio: "pipe",
      });
      return { merged: true };
    } catch (err) {
      return { merged: false, error: `Merge failed: ${String(err)}` };
    }
  }

  // Non-git: copy changed files back
  await copyWorkspace(missionDir, sourceWorkspaceDir);
  return { merged: true };
}

// --- Orchestration CRUD ---

function ensureDir(): void {
  const dir = orchestrationsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export async function saveOrchestration(orch: Orchestration): Promise<void> {
  ensureDir();
  orch.updatedAtMs = Date.now();
  const data = JSON.stringify(orch, null, 2);
  fs.writeFileSync(orchestrationPath(orch.id), data, "utf-8");
}

export async function loadOrchestration(id: string): Promise<Orchestration | null> {
  const filePath = orchestrationPath(id);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as Orchestration;
}

export async function listOrchestrations(): Promise<Orchestration[]> {
  const dir = orchestrationsDir();
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const results: Orchestration[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), "utf-8");
    try {
      results.push(JSON.parse(raw) as Orchestration);
    } catch {
      // skip corrupt files
    }
  }
  return results.toSorted((a, b) => b.createdAtMs - a.createdAtMs);
}

export async function updateOrchestration(
  id: string,
  updater: (orch: Orchestration) => void,
): Promise<Orchestration | null> {
  const orch = await loadOrchestration(id);
  if (!orch) {
    return null;
  }
  updater(orch);
  await saveOrchestration(orch);
  return orch;
}

export async function deleteOrchestration(id: string): Promise<boolean> {
  const filePath = orchestrationPath(id);
  if (!fs.existsSync(filePath)) {
    return false;
  }
  fs.unlinkSync(filePath);
  return true;
}

// --- Helpers ---

async function copyWorkspace(src: string, dest: string): Promise<void> {
  const { execSync } = await import("node:child_process");
  // Use rsync for efficient copy, excluding heavy directories
  try {
    execSync(
      `rsync -a --exclude=node_modules --exclude=.git --exclude=dist --exclude=.verso-missions "${src}/" "${dest}/"`,
      { stdio: "pipe" },
    );
  } catch {
    // rsync not available, fall back to cp
    execSync(
      `cp -R "${src}/." "${dest}/" 2>/dev/null; rm -rf "${dest}/node_modules" "${dest}/.git" "${dest}/dist" "${dest}/.verso-missions"`,
      { stdio: "pipe", shell: "/bin/bash" },
    );
  }
}
