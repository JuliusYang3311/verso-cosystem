// src/orchestration/types.ts — Multi-agent orchestration data model

import type { ChannelId } from "../channels/plugins/types.js";
import type { WorkerSpecialization } from "./specializations/index.js";

export type OrchestrationDelivery = {
  channel: ChannelId;
  to: string;
  bestEffort?: boolean;
};

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type OrchestrationStatus =
  | "planning"
  | "dispatching"
  | "running"
  | "acceptance"
  | "fixing"
  | "completed"
  | "failed";

export type Subtask = {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: TaskStatus;
  specialization: WorkerSpecialization; // Worker specialization type for domain-specific execution
  workerSessionKey?: string;
  runId?: string;
  dependsOn?: string[];
  resultSummary?: string;
  error?: string;
  retryCount: number;
  createdAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
};

export type FactCheckDetail = {
  claim: string;
  status: "verified" | "contradicted" | "unverifiable";
  source?: string;
};

export type FactCheckResult = {
  checked: number;
  verified: number;
  contradicted: number;
  unverifiable: number;
  details?: FactCheckDetail[];
};

export type AcceptanceVerdict = {
  subtaskId: string;
  passed: boolean;
  confidence: number; // Confidence score 0-100 (inspired by Claude Code's confidence-based filtering)
  reasoning: string;
  issues?: Array<{
    severity: "critical" | "major" | "minor";
    confidence: number;
    description: string;
    file?: string;
    line?: number;
  }>;
  factCheck?: FactCheckResult;
};

export type AcceptanceResult = {
  passed: boolean;
  verdicts: AcceptanceVerdict[];
  summary: string;
  testedAtMs: number;
};

export type FixTask = {
  id: string;
  sourceSubtaskId: string;
  description: string;
  status: TaskStatus;
  workerSessionKey?: string;
  runId?: string;
  error?: string;
  createdAtMs: number;
  completedAtMs?: number;
};

export type OrchestrationPlan = {
  summary: string;
  subtasks: Subtask[];
  verifyCmd?: string; // Project-specific verify command, determined at plan creation
};

export type Orchestration = {
  id: string;
  userPrompt: string;
  orchestratorSessionKey: string;
  agentId: string;
  status: OrchestrationStatus;
  /** Isolated workspace directory for this orchestration (mission_workspace). */
  workspaceDir: string;
  /** The original workspace directory the orchestration was initiated from. */
  sourceWorkspaceDir: string;
  /** The chat session key for notification delivery (hardcoded to agent:main:main). */
  chatSessionKey: string;
  /** Base project directory to enhance (if provided, copied to sandbox before orchestration starts). */
  baseProjectDir?: string;
  /** Optional outbound delivery config. When set, completion/failure notifications are
   *  delivered to this channel instead of being injected into the main session transcript. */
  delivery?: OrchestrationDelivery;
  plan?: OrchestrationPlan;
  fixTasks: FixTask[];
  acceptanceResults: AcceptanceResult[];
  maxFixCycles: number;
  currentFixCycle: number;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  error?: string;
};

export type OrchestrationConfig = {
  enabled?: boolean;
  maxFixCycles?: number;
  maxOrchestrations?: number;
  verifyCmd?: string;
};

export const ORCHESTRATION_DEFAULTS: Required<OrchestrationConfig> = {
  enabled: true,
  maxFixCycles: 30,
  maxOrchestrations: 2,
  verifyCmd: "", // Empty = skip mechanical verification, rely on LLM acceptance criteria only
};

export function createOrchestration(params: {
  id: string;
  userPrompt: string;
  orchestratorSessionKey: string;
  agentId: string;
  workspaceDir: string;
  sourceWorkspaceDir: string;
  baseProjectDir?: string;
  delivery?: OrchestrationDelivery;
  maxFixCycles?: number;
}): Orchestration {
  const now = Date.now();
  return {
    id: params.id,
    userPrompt: params.userPrompt,
    orchestratorSessionKey: params.orchestratorSessionKey,
    agentId: params.agentId,
    status: "planning",
    workspaceDir: params.workspaceDir,
    sourceWorkspaceDir: params.sourceWorkspaceDir,
    chatSessionKey: "agent:main:main",
    baseProjectDir: params.baseProjectDir,
    delivery: params.delivery,
    fixTasks: [],
    acceptanceResults: [],
    maxFixCycles: params.maxFixCycles ?? ORCHESTRATION_DEFAULTS.maxFixCycles,
    currentFixCycle: 0,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

export function createSubtask(params: {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  specialization: WorkerSpecialization; // REQUIRED - no default
  dependsOn?: string[];
}): Subtask {
  return {
    id: params.id,
    title: params.title,
    description: params.description,
    acceptanceCriteria: params.acceptanceCriteria,
    specialization: params.specialization,
    status: "pending",
    dependsOn: params.dependsOn,
    retryCount: 0,
    createdAtMs: Date.now(),
  };
}

/**
 * Validate that all dependsOn references point to existing task IDs.
 * Returns an array of error messages (empty = valid).
 */
export function validateDependencyIds(subtasks: Subtask[]): string[] {
  const validIds = new Set(subtasks.map((s) => s.id));
  const errors: string[] = [];
  for (const s of subtasks) {
    if (!s.dependsOn) continue;
    for (const depId of s.dependsOn) {
      if (!validIds.has(depId)) {
        errors.push(`Subtask "${s.id}" (${s.title}) depends on non-existent task "${depId}"`);
      }
    }
  }
  return errors;
}

/**
 * Find pending tasks that are permanently blocked because they reference
 * non-existent dependency IDs (orphaned deps). These can never become ready.
 */
export function findOrphanedTasks(subtasks: Subtask[]): Subtask[] {
  const allIds = new Set(subtasks.map((s) => s.id));
  return subtasks.filter(
    (s) => s.status === "pending" && s.dependsOn?.some((depId) => !allIds.has(depId)),
  );
}

export function isSubtaskReady(subtask: Subtask, allSubtasks: Subtask[]): boolean {
  if (subtask.status !== "pending") {
    return false;
  }
  if (!subtask.dependsOn || subtask.dependsOn.length === 0) {
    return true;
  }
  return subtask.dependsOn.every((depId) => {
    const dep = allSubtasks.find((s) => s.id === depId);
    return dep?.status === "completed";
  });
}

export function isOrchestrationTerminal(status: OrchestrationStatus): boolean {
  return status === "completed" || status === "failed";
}

export function isTaskTerminal(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
