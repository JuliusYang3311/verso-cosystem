// src/orchestration/types.ts — Multi-agent orchestration data model

import type { WorkerSpecialization } from "./specializations/index.js";

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
  maxWorkers?: number;
  maxFixCycles?: number;
  maxOrchestrations?: number;
  verifyCmd?: string;
};

export const ORCHESTRATION_DEFAULTS: Required<OrchestrationConfig> = {
  enabled: true,
  maxWorkers: 4,
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
    chatSessionKey: "agent:main:main", // Hardcoded notification target
    baseProjectDir: params.baseProjectDir,
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
