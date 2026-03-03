// src/orchestration/workflows/bug-fix.ts — Bug fix workflow

import type { WorkflowTemplate } from "./types.js";

/**
 * Bug Fix Workflow
 *
 * A focused 3-phase approach for fixing bugs:
 * 1. Investigation - Reproduce and understand the bug
 * 2. Fix Implementation - Implement the fix
 * 3. Verification - Verify the fix works and doesn't break anything
 */
export const bugFixWorkflow: WorkflowTemplate = {
  name: "bug-fix",
  description: "Focused bug fix with investigation, implementation, and verification",

  phases: [
    {
      name: "investigate",
      specialization: "code-explorer",
      parallel: false,
      subtaskTemplate: "Investigate bug: {description}",
      acceptanceCriteria: [
        "Bug reproduced successfully",
        "Root cause identified with evidence",
        "Affected code paths traced",
        "Impact scope documented",
      ],
    },
    {
      name: "fix",
      specialization: "code-implementer",
      parallel: false,
      dependsOn: ["investigate"],
      subtaskTemplate: "Implement fix: {approach}",
      acceptanceCriteria: [
        "Fix implemented addressing root cause",
        "Bug no longer reproducible",
        "Tests added to prevent regression",
        "Code follows project conventions",
      ],
    },
    {
      name: "verify",
      specialization: "code-reviewer",
      parallel: false,
      dependsOn: ["fix"],
      subtaskTemplate: "Verify fix: {scope}",
      acceptanceCriteria: [
        "All existing tests still pass",
        "New tests cover the bug scenario",
        "No unintended side effects introduced",
        "Fix is minimal and focused",
      ],
    },
  ],

  verifyCmd: "npm run lint && npm test",
};
