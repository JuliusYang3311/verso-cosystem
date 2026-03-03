// src/orchestration/workflows/feature-dev.ts — Feature development workflow

import type { WorkflowTemplate } from "./types.js";

/**
 * Feature Development Workflow
 *
 * Inspired by Claude Code's feature-dev plugin.
 *
 * A structured 4-phase approach for building new features:
 * 1. Exploration - Understand existing codebase
 * 2. Architecture Design - Plan implementation approach
 * 3. Implementation - Build the feature
 * 4. Quality Review - Review code quality and correctness
 */
export const featureDevWorkflow: WorkflowTemplate = {
  name: "feature-dev",
  description:
    "Structured feature development with exploration, design, implementation, and review",

  phases: [
    {
      name: "explore",
      specialization: "code-explorer",
      parallel: true,
      maxWorkers: 2,
      subtaskTemplate: "Explore existing codebase: {aspect}",
      acceptanceCriteria: [
        "Identified all relevant files and entry points",
        "Documented key patterns and abstractions",
        "Mapped architecture layers and dependencies",
        "Listed 5-10 essential files to understand",
      ],
    },
    {
      name: "design",
      specialization: "code-architect",
      parallel: true,
      maxWorkers: 2,
      dependsOn: ["explore"],
      subtaskTemplate: "Design architecture: {approach}",
      acceptanceCriteria: [
        "Architecture approach documented with rationale",
        "Component responsibilities clearly defined",
        "Integration points with existing code identified",
        "Implementation roadmap with phases outlined",
      ],
    },
    {
      name: "implement",
      specialization: "code-implementer",
      parallel: true,
      maxWorkers: 4,
      dependsOn: ["design"],
      subtaskTemplate: "Implement: {component}",
      acceptanceCriteria: [
        "Code compiles without errors",
        "Unit tests written and passing",
        "Follows project conventions and patterns",
        "Integration with existing code verified",
      ],
    },
    {
      name: "review",
      specialization: "code-reviewer",
      parallel: true,
      maxWorkers: 3,
      dependsOn: ["implement"],
      subtaskTemplate: "Review: {aspect}",
      acceptanceCriteria: [
        "No critical bugs found (confidence ≥ 80)",
        "Code quality meets project standards",
        "Documentation is complete and accurate",
        "No security vulnerabilities identified",
      ],
    },
  ],

  verifyCmd: "npm run lint && npm test",
};
