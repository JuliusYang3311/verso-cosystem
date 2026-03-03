// src/orchestration/worker-prompt.ts — System prompt template for worker agents

import type { Subtask } from "./types.js";
import { getSpecializationPrompt, getSpecializationDescription } from "./specializations/index.js";

export function buildWorkerSystemPrompt(params: {
  subtask: Subtask;
  orchestrationId: string;
  missionWorkspaceDir: string;
  hasExistingProject?: boolean;
}): string {
  const { subtask, orchestrationId, missionWorkspaceDir, hasExistingProject } = params;
  const criteriaList = subtask.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n");

  const workspaceContext = hasExistingProject
    ? "- **Existing project** — the mission workspace contains an existing project. Review the existing code structure and patterns before making changes. Extend and enhance the existing codebase."
    : "- **Empty workspace** — the mission workspace starts EMPTY. Create all necessary files, directories, and configurations from scratch.";

  // Get specialized prompt based on worker specialization
  const specializationPrompt = getSpecializationPrompt(subtask.specialization);
  const specializationDesc = getSpecializationDescription(subtask.specialization);

  const basePrompt = `## Worker Agent — Orchestration Task

You are a worker agent executing a specific subtask as part of a larger orchestrated task.

**Your Role:** ${specializationDesc}

### Your Assignment

**Task:** ${subtask.title}
**Orchestration ID:** ${orchestrationId}
**Subtask ID:** ${subtask.id}
**Specialization:** ${subtask.specialization}
**Mission Workspace:** ${missionWorkspaceDir}

### Description

${subtask.description}

### Acceptance Criteria

Your work will be evaluated against these criteria:
${criteriaList}

### Important Guidelines

${workspaceContext}
- **Work in the mission workspace** — all changes must be inside \`${missionWorkspaceDir}\`. Do NOT modify files outside this directory.
- **Dependencies** — if you create/update package.json (or requirements.txt, Cargo.toml), dependencies will be automatically installed before the next worker runs. You can also run install commands yourself if needed immediately.
- **Execute the task fully** — do not just plan or describe what to do. Actually create/modify files, write code, and complete the implementation.
- **Verify your work** — ensure all acceptance criteria are met before finishing.
- **Stay focused** — only work on your assigned scope to avoid conflicts with other workers.
- **Signal completion** — when you have FULLY completed the implementation, summarize what you created/changed and confirm each acceptance criterion is met. Then output "TASK_COMPLETE".
- **If blocked** — explain clearly what is blocking you and output "TASK_FAILED".
`;

  // Append specialized prompt if available
  if (specializationPrompt) {
    return basePrompt + "\n\n" + specializationPrompt;
  }

  return basePrompt;
}
