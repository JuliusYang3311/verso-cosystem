// src/orchestration/workflows/index.ts — Workflow registry

import type { WorkflowTemplate } from "./types.js";
import { bugFixWorkflow } from "./bug-fix.js";
import { featureDevWorkflow } from "./feature-dev.js";
import { refactorWorkflow } from "./refactor.js";
import { researchWorkflow } from "./research.js";

/**
 * Registry of all available workflow templates
 */
export const WORKFLOW_REGISTRY: Record<string, WorkflowTemplate> = {
  "feature-dev": featureDevWorkflow,
  "bug-fix": bugFixWorkflow,
  research: researchWorkflow,
  refactor: refactorWorkflow,
};

/**
 * Get a workflow template by name
 */
export function getWorkflow(name: string): WorkflowTemplate | undefined {
  return WORKFLOW_REGISTRY[name];
}

/**
 * Get all available workflow names
 */
export function getWorkflowNames(): string[] {
  return Object.keys(WORKFLOW_REGISTRY);
}

/**
 * Suggest a workflow based on task description
 * (This is a simple heuristic - the orchestrator agent will make the final decision)
 */
export function suggestWorkflow(userPrompt: string): string {
  const lower = userPrompt.toLowerCase();

  // Bug fix indicators
  if (
    lower.includes("fix") ||
    lower.includes("bug") ||
    lower.includes("error") ||
    lower.includes("issue") ||
    lower.includes("broken")
  ) {
    return "bug-fix";
  }

  // Research indicators
  if (
    lower.includes("research") ||
    lower.includes("analyze") ||
    lower.includes("compare") ||
    lower.includes("investigate") ||
    lower.includes("study")
  ) {
    return "research";
  }

  // Refactoring indicators
  if (
    lower.includes("refactor") ||
    lower.includes("restructure") ||
    lower.includes("reorganize") ||
    lower.includes("clean up") ||
    lower.includes("improve code")
  ) {
    return "refactor";
  }

  // Feature development (default for most tasks)
  if (
    lower.includes("add") ||
    lower.includes("build") ||
    lower.includes("create") ||
    lower.includes("implement") ||
    lower.includes("develop")
  ) {
    return "feature-dev";
  }

  // Default to feature-dev for ambiguous cases
  return "feature-dev";
}

// Re-export types
export type { WorkflowTemplate, WorkflowPhase, WorkflowContext } from "./types.js";
