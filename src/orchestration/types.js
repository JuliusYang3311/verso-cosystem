// src/orchestration/types.ts — Multi-agent orchestration data model
export const ORCHESTRATION_DEFAULTS = {
  enabled: true,
  maxWorkers: 4,
  maxFixCycles: 30,
  maxOrchestrations: 2,
  verifyCmd: "", // Empty = skip mechanical verification, rely on LLM acceptance criteria only
};
export function createOrchestration(params) {
  const now = Date.now();
  return {
    id: params.id,
    userPrompt: params.userPrompt,
    orchestratorSessionKey: params.orchestratorSessionKey,
    agentId: params.agentId,
    status: "planning",
    workspaceDir: params.workspaceDir,
    sourceWorkspaceDir: params.sourceWorkspaceDir,
    triggeringSessionKey: params.triggeringSessionKey,
    baseProjectDir: params.baseProjectDir,
    fixTasks: [],
    acceptanceResults: [],
    maxFixCycles: params.maxFixCycles ?? ORCHESTRATION_DEFAULTS.maxFixCycles,
    currentFixCycle: 0,
    createdAtMs: now,
    updatedAtMs: now,
  };
}
export function createSubtask(params) {
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
export function isSubtaskReady(subtask, allSubtasks) {
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
export function isOrchestrationTerminal(status) {
  return status === "completed" || status === "failed";
}
export function isTaskTerminal(status) {
  return status === "completed" || status === "failed" || status === "cancelled";
}
