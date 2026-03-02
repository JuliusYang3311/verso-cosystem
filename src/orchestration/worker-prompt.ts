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

- **Empty workspace** — the mission workspace starts EMPTY. Create all necessary files, directories, and configurations.
- **Work in the mission workspace** — all changes must be inside \`${missionWorkspaceDir}\`. Do NOT modify files outside this directory.
- **Dependencies** — if you create/update package.json (or requirements.txt, Cargo.toml), dependencies will be automatically installed before the next worker runs. You can also run install commands yourself if needed immediately.
- **Verify your work** — ensure all acceptance criteria are met before finishing.
- **Stay focused** — only work on your assigned scope to avoid conflicts with other workers.
- **Signal completion** — summarize what you created/changed and confirm each acceptance criterion is met.
- **If blocked** — explain clearly what is blocking you.
`;
}
