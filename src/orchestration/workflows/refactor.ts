// src/orchestration/workflows/refactor.ts — Refactoring workflow

import type { WorkflowTemplate } from "./types.js";

/**
 * Refactoring Workflow
 *
 * A 4-phase approach for code refactoring:
 * 1. Analysis - Understand current code structure
 * 2. Design - Plan refactoring approach
 * 3. Refactor - Execute the refactoring
 * 4. Verification - Ensure no regressions
 */
export const refactorWorkflow: WorkflowTemplate = {
  name: "refactor",
  description: "Code refactoring with analysis, design, execution, and verification",

  phases: [
    {
      name: "analyze",
      specialization: "code-explorer",
      parallel: true,
      maxWorkers: 2,
      subtaskTemplate: "Analyze code: {area}",
      acceptanceCriteria: [
        "Current code structure documented",
        "Pain points and issues identified",
        "Dependencies and coupling mapped",
        "Refactoring opportunities listed",
      ],
    },
    {
      name: "design",
      specialization: "code-architect",
      parallel: false,
      dependsOn: ["analyze"],
      subtaskTemplate: "Design refactoring: {approach}",
      acceptanceCriteria: [
        "Refactoring strategy documented",
        "Target architecture defined",
        "Migration path outlined",
        "Risks and mitigations identified",
      ],
    },
    {
      name: "refactor",
      specialization: "code-implementer",
      parallel: true,
      maxWorkers: 3,
      dependsOn: ["design"],
      subtaskTemplate: "Refactor: {component}",
      acceptanceCriteria: [
        "Code refactored following design",
        "Functionality preserved",
        "Tests updated and passing",
        "Code quality improved",
      ],
    },
    {
      name: "verify",
      specialization: "code-reviewer",
      parallel: false,
      dependsOn: ["refactor"],
      subtaskTemplate: "Verify refactoring: {scope}",
      acceptanceCriteria: [
        "All tests pass (no regressions)",
        "Code quality metrics improved",
        "No new bugs introduced",
        "Documentation updated",
      ],
    },
  ],

  verifyCmd: "npm run lint && npm test",
};
