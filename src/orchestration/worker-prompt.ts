// src/orchestration/worker-prompt.ts — Prompt builders for persistent worker sessions
//
// Workers are long-lived sessions that execute multiple tasks in sequence.
// The first task gets a full identity + guidelines prompt. Subsequent tasks
// get a compact briefing — the session already carries accumulated context.

import type { WorkerSpecialization } from "./specializations/types.js";
import type { Subtask } from "./types.js";
import { getSpecializationPrompt, getSpecializationDescription } from "./specializations/index.js";

// ---------------------------------------------------------------------------
// First task — full identity establishment
// ---------------------------------------------------------------------------

/**
 * Build the prompt for the FIRST task assigned to a persistent worker session.
 * Includes full role identity, specialization guidance, workspace rules, and task details.
 */
export function buildWorkerFirstTaskPrompt(params: {
  subtask: Subtask;
  orchestrationId: string;
  missionWorkspaceDir: string;
  hasExistingProject?: boolean;
}): string {
  const { subtask, orchestrationId, missionWorkspaceDir, hasExistingProject } = params;

  const specializationDesc = getSpecializationDescription(subtask.specialization);
  const specializationPrompt = getSpecializationPrompt(subtask.specialization);

  const workspaceContext = hasExistingProject
    ? "The workspace contains an **existing project**. Review code structure and patterns before making changes."
    : "The workspace is **empty**. Create all files, directories, and configurations from scratch.";

  const parts: string[] = [
    `## Worker Agent — ${specializationDesc}`,
    "",
    `You are a persistent worker in an orchestrated multi-agent system. You will receive multiple tasks in sequence within this session. Each task contributes to orchestration **${orchestrationId}**.`,
    "",
    `**Workspace:** \`${missionWorkspaceDir}\``,
    workspaceContext,
    "",
    "### Session Rules",
    "",
    "- All changes must be inside the mission workspace. Do NOT modify files outside it.",
    "- Execute tasks fully — write code, create files, run commands. Do not just describe.",
    "- Verify acceptance criteria before finishing.",
    "- Stay within your assigned scope to avoid conflicts with parallel workers.",
    "- When done: summarize changes, confirm each criterion, then output **TASK_COMPLETE**.",
    "- If blocked: explain clearly, then output **TASK_FAILED**.",
    "- Your session persists — knowledge from prior tasks carries forward automatically.",
  ];

  // Specialization guidance (only on first task)
  if (specializationPrompt) {
    parts.push("", specializationPrompt);
  }

  // Task details
  parts.push("", "---", "", formatTaskBlock(subtask));

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Subsequent task — compact briefing
// ---------------------------------------------------------------------------

/**
 * Build the prompt for a SUBSEQUENT task on an already-initialized worker session.
 * Compact — the session already knows its role, workspace, and rules.
 */
export function buildWorkerSubsequentTaskPrompt(params: {
  subtask: Subtask;
  orchestrationId: string;
  /** When the task specialization differs from the worker's native specialization,
   *  include a brief role hint so the worker adapts its approach. */
  workerSpecialization?: WorkerSpecialization;
}): string {
  const { subtask, workerSpecialization } = params;

  const parts: string[] = ["## New Task Assignment"];

  // If the worker is a generic handling a specialized task (or vice versa), add a brief role hint
  if (
    workerSpecialization &&
    workerSpecialization !== subtask.specialization &&
    subtask.specialization !== "generic"
  ) {
    const roleDesc = getSpecializationDescription(subtask.specialization);
    parts.push("", `**Approach this as:** ${roleDesc}`);
  }

  parts.push("", formatTaskBlock(subtask));

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function formatTaskBlock(subtask: Subtask): string {
  const criteriaList = subtask.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");

  return [
    `**Task:** ${subtask.title}`,
    `**ID:** ${subtask.id} | **Specialization:** ${subtask.specialization}`,
    "",
    subtask.description,
    "",
    "**Acceptance Criteria:**",
    criteriaList,
    "",
    "Begin. Output TASK_COMPLETE or TASK_FAILED when done.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Legacy compat (used by existing runWorkerTask — delegates to first-task builder)
// ---------------------------------------------------------------------------

/** @deprecated Use buildWorkerFirstTaskPrompt or buildWorkerSubsequentTaskPrompt */
export function buildWorkerSystemPrompt(params: {
  subtask: Subtask;
  orchestrationId: string;
  missionWorkspaceDir: string;
  hasExistingProject?: boolean;
}): string {
  return buildWorkerFirstTaskPrompt(params);
}
