// src/orchestration/store.ts — Orchestration state persistence + mission workspace management

import fs from "node:fs";
import path from "node:path";
import type { Orchestration } from "./types.js";
import { resolveStateDir } from "../config/paths.js";

// --- Paths ---

function orchestrationsDir(): string {
  // Allow test override via VERSO_ORCHESTRATION_STORE_DIR
  const override = process.env.VERSO_ORCHESTRATION_STORE_DIR;
  if (override) {
    return path.join(override, "orchestrations");
  }
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
 * Create an empty mission workspace for orchestration.
 * Workers build the project from scratch in this isolated directory.
 */
export function createMissionWorkspace(sourceWorkspaceDir: string, orchId: string): string {
  const missionDir = resolveMissionWorkspace(sourceWorkspaceDir, orchId);
  if (!fs.existsSync(missionDir)) {
    fs.mkdirSync(missionDir, { recursive: true });
  }
  return missionDir;
}

/**
 * Initialize mission workspace (async version for compatibility).
 */
export async function initMissionWorkspace(
  sourceWorkspaceDir: string,
  orchId: string,
): Promise<string> {
  return createMissionWorkspace(sourceWorkspaceDir, orchId);
}

/**
 * Clean up a mission workspace by removing the directory.
 */
export async function cleanupMissionWorkspace(
  sourceWorkspaceDir: string,
  orchId: string,
): Promise<void> {
  const missionDir = resolveMissionWorkspace(sourceWorkspaceDir, orchId);
  if (!fs.existsSync(missionDir)) {
    return;
  }

  try {
    fs.rmSync(missionDir, { recursive: true, force: true });
  } catch (err) {
    throw new Error(`Failed to cleanup mission workspace ${orchId}: ${String(err)}`, {
      cause: err,
    });
  }
}

/**
 * Copy mission workspace to output directory in source workspace.
 * Output directory is always relative to source workspace.
 * This is the primary way to extract results from orchestration.
 */
export async function copyMissionToOutput(
  sourceWorkspaceDir: string,
  orchId: string,
  outputDir: string,
): Promise<{ copied: boolean; resolvedPath?: string; error?: string }> {
  const missionDir = resolveMissionWorkspace(sourceWorkspaceDir, orchId);
  if (!fs.existsSync(missionDir)) {
    return { copied: false, error: "Mission workspace not found" };
  }

  // Copy from sandbox directory (where all agents work)
  const sandboxDir = path.join(missionDir, "sandbox");
  if (!fs.existsSync(sandboxDir)) {
    return { copied: false, error: "Sandbox directory not found" };
  }

  // Resolve relative paths from source workspace
  const resolvedOutputDir = path.isAbsolute(outputDir)
    ? outputDir
    : path.resolve(sourceWorkspaceDir, outputDir);

  try {
    // Create output directory if it doesn't exist
    if (!fs.existsSync(resolvedOutputDir)) {
      fs.mkdirSync(resolvedOutputDir, { recursive: true });
    }

    // Copy sandbox contents to output directory
    await copyWorkspace(sandboxDir, resolvedOutputDir);

    return { copied: true, resolvedPath: resolvedOutputDir };
  } catch (err) {
    return { copied: false, error: `Copy failed: ${String(err)}` };
  }
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
  const filePath = orchestrationPath(orch.id);
  const tempPath = `${filePath}.tmp`;

  try {
    fs.writeFileSync(tempPath, data, "utf-8");
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    // Clean up temp file if it exists
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    throw new Error(`Failed to save orchestration ${orch.id}: ${String(err)}`, { cause: err });
  }
}

export async function loadOrchestration(id: string): Promise<Orchestration | null> {
  const filePath = orchestrationPath(id);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw.trim()) {
      return null;
    }
    const parsed = JSON.parse(raw);
    // Basic validation
    if (!parsed.id || !parsed.status || !parsed.agentId) {
      throw new Error("Invalid orchestration data");
    }
    return parsed as Orchestration;
  } catch (err) {
    throw new Error(`Failed to load orchestration ${id}: ${String(err)}`, { cause: err });
  }
}

export async function listOrchestrations(): Promise<Orchestration[]> {
  const dir = orchestrationsDir();
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const results: Orchestration[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      if (!raw.trim()) {
        continue;
      }
      const parsed = JSON.parse(raw);
      if (parsed.id && parsed.status && parsed.agentId) {
        results.push(parsed as Orchestration);
      }
    } catch (err) {
      // Skip corrupt files, log warning
      console.warn(`Skipping corrupt orchestration file: ${file}`, err);
    }
  }
  return results.toSorted((a, b) => b.updatedAtMs - a.updatedAtMs);
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

export async function copyWorkspace(src: string, dest: string): Promise<void> {
  const { execSync } = await import("node:child_process");

  // Validate paths
  if (!fs.existsSync(src)) {
    throw new Error(`Source directory does not exist: ${src}`);
  }

  // Use rsync for efficient copy
  try {
    execSync(`rsync -a "${src}/" "${dest}/"`, { stdio: "pipe" });
  } catch {
    // rsync not available, fall back to cp
    execSync(`cp -R "${src}/." "${dest}/"`, { stdio: "pipe", shell: "/bin/bash" });
  }
}
