// src/orchestration/workflows/research.ts — Research workflow

import type { WorkflowTemplate } from "./types.js";

/**
 * Research Workflow
 *
 * A 2-phase approach for multi-topic research:
 * 1. Parallel Research - Gather information on multiple topics simultaneously
 * 2. Synthesis - Consolidate findings into coherent report
 */
export const researchWorkflow: WorkflowTemplate = {
  name: "research",
  description: "Multi-topic research with parallel information gathering and synthesis",

  phases: [
    {
      name: "gather",
      specialization: "researcher",
      parallel: true,
      maxWorkers: 5,
      subtaskTemplate: "Research topic: {topic}",
      acceptanceCriteria: [
        "Comprehensive information gathered from multiple sources",
        "Key findings documented with evidence",
        "Sources cited with URLs and dates",
        "Data organized and structured",
      ],
    },
    {
      name: "synthesize",
      specialization: "researcher",
      parallel: false,
      dependsOn: ["gather"],
      subtaskTemplate: "Synthesize findings: {scope}",
      acceptanceCriteria: [
        "All research findings consolidated",
        "Patterns and trends identified",
        "Conclusions drawn from evidence",
        "Final report is coherent and actionable",
      ],
    },
  ],

  verifyCmd: "", // No mechanical verification for research tasks
};
