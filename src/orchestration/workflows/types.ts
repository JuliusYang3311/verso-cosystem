// src/orchestration/workflows/types.ts — Workflow template types

import type { WorkerSpecialization } from "../specializations/index.js";

/**
 * A phase in a workflow template.
 * Defines how subtasks should be created and executed for this phase.
 */
export type WorkflowPhase = {
  /** Phase name (e.g., 'explore', 'design', 'implement') */
  name: string;
  /** Worker specialization for this phase */
  specialization: WorkerSpecialization;
  /** Whether tasks in this phase can run in parallel */
  parallel: boolean;
  /** Maximum number of parallel workers (if parallel=true) */
  maxWorkers?: number;
  /** Template for subtask titles (can include {placeholders}) */
  subtaskTemplate: string;
  /** Default acceptance criteria for tasks in this phase */
  acceptanceCriteria: string[];
  /** Phase names this phase depends on (must complete before this phase starts) */
  dependsOn?: string[];
};

/**
 * A complete workflow template.
 * Defines a structured multi-phase approach for a specific type of task.
 */
export type WorkflowTemplate = {
  /** Workflow name (e.g., 'feature-dev', 'bug-fix') */
  name: string;
  /** Human-readable description */
  description: string;
  /** Phases in execution order */
  phases: WorkflowPhase[];
  /** Default verification command for this workflow type */
  verifyCmd?: string;
};

/**
 * Context for generating subtasks from a workflow template.
 */
export type WorkflowContext = {
  /** Original user prompt */
  userPrompt: string;
  /** Whether working with existing project or building from scratch */
  hasExistingProject: boolean;
  /** Additional context from orchestrator's analysis */
  analysisNotes?: string;
};
