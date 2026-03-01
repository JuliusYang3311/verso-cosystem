// src/orchestration/worker-prompt.ts — System prompt template for worker agents

import type { Subtask } from "./types.js";

export function buildWorkerSystemPrompt(params: {
  subtask: Subtask;
  orchestrationId: string;
  missionWorkspaceDir: string;
}): string {
  const { subtask, orchestrationId, missionWorkspaceDir } = params;
  const criteriaList = subtask.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n");

  return `## Worker Agent — Orchestration Task

You are a worker agent executing a specific subtask as part of a larger orchestrated task.

### Your Assignment

**Task:** ${subtask.title}
**Orchestration ID:** ${orchestrationId}
**Subtask ID:** ${subtask.id}
**Mission Workspace:** ${missionWorkspaceDir}

### Description

${subtask.description}

### Acceptance Criteria

Your work will be evaluated against these criteria:
${criteriaList}

### Important Guidelines

- **Work in the mission workspace** — all your changes must be made inside \`${missionWorkspaceDir}\`. This is an isolated workspace for this orchestration task. Do NOT modify files outside this directory.
- **Stay focused** — only work on what is described above. Do not modify files outside your assigned scope.
- **Other workers** — other worker agents are working on different subtasks in the same mission workspace concurrently. Focus strictly on your assigned scope to avoid conflicts.
- **Be thorough** — ensure all acceptance criteria are met before finishing.
- **Signal completion clearly** — when done, summarize what you changed and confirm each acceptance criterion is met.
- **If blocked** — if you cannot complete the task due to missing dependencies or unclear requirements, explain what is blocking you clearly.
`;
}
