// ui/src/ui/controllers/orchestration.ts — Orchestration data controller

import type { GatewayBrowserClient } from "../gateway.ts";

export type OrchestrationSubtask = {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  dependsOn?: string[];
  resultSummary?: string;
  error?: string;
  retryCount: number;
  createdAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
};

export type OrchestrationAcceptanceVerdict = {
  subtaskId: string;
  passed: boolean;
  reason?: string;
};

export type OrchestrationAcceptanceResult = {
  passed: boolean;
  verdicts: OrchestrationAcceptanceVerdict[];
  summary: string;
  testedAtMs: number;
};

export type OrchestrationFixTask = {
  id: string;
  sourceSubtaskId: string;
  description: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  error?: string;
  createdAtMs: number;
  completedAtMs?: number;
};

export type OrchestrationDetail = {
  id: string;
  userPrompt: string;
  orchestratorSessionKey: string;
  agentId: string;
  status: "planning" | "dispatching" | "running" | "acceptance" | "fixing" | "completed" | "failed";
  workspaceDir: string;
  sourceWorkspaceDir: string;
  plan?: { summary: string; subtasks: OrchestrationSubtask[] };
  fixTasks: OrchestrationFixTask[];
  acceptanceResults: OrchestrationAcceptanceResult[];
  maxFixCycles: number;
  currentFixCycle: number;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  error?: string;
};

export type OrchestrationListItem = {
  id: string;
  userPrompt: string;
  status: string;
  subtaskCount: number;
  fixCycle: number;
  maxFixCycles: number;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
};

export type OrchestrationState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  orchLoading: boolean;
  orchList: OrchestrationListItem[];
  orchError: string | null;
  orchDetail: OrchestrationDetail | null;
  orchDetailLoading: boolean;
  orchActiveId: string | null;
  orchSelectedSubtaskId: string | null;
  orchBusy: boolean;
};

export async function loadOrchestrations(state: OrchestrationState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.orchLoading) {
    return;
  }
  state.orchLoading = true;
  state.orchError = null;
  try {
    const res = await state.client.request<{ orchestrations?: OrchestrationListItem[] }>(
      "orchestration.list",
      { limit: 50 },
    );
    state.orchList = Array.isArray(res.orchestrations) ? res.orchestrations : [];
  } catch (err) {
    state.orchError = String(err);
  } finally {
    state.orchLoading = false;
  }
}

export async function loadOrchestrationDetail(state: OrchestrationState, id: string) {
  if (!state.client || !state.connected) {
    return;
  }
  state.orchDetailLoading = true;
  state.orchError = null;
  try {
    const res = await state.client.request<{ orchestration?: OrchestrationDetail }>(
      "orchestration.get",
      { id },
    );
    if (res.orchestration) {
      state.orchDetail = res.orchestration;
      state.orchActiveId = id;
    }
  } catch (err) {
    state.orchError = String(err);
  } finally {
    state.orchDetailLoading = false;
  }
}

export async function abortOrchestration(state: OrchestrationState, id: string) {
  if (!state.client || !state.connected || state.orchBusy) {
    return;
  }
  state.orchBusy = true;
  state.orchError = null;
  try {
    await state.client.request("orchestration.abort", { id });
    await loadOrchestrationDetail(state, id);
  } catch (err) {
    state.orchError = String(err);
  } finally {
    state.orchBusy = false;
  }
}

export async function retryOrchestration(state: OrchestrationState, id: string) {
  if (!state.client || !state.connected || state.orchBusy) {
    return;
  }
  state.orchBusy = true;
  state.orchError = null;
  try {
    await state.client.request("orchestration.retry", { id });
    await loadOrchestrationDetail(state, id);
  } catch (err) {
    state.orchError = String(err);
  } finally {
    state.orchBusy = false;
  }
}

export async function deleteOrchestration(state: OrchestrationState, id: string) {
  if (!state.client || !state.connected || state.orchBusy) {
    return;
  }
  state.orchBusy = true;
  state.orchError = null;
  try {
    await state.client.request("orchestration.delete", { id });
    if (state.orchActiveId === id) {
      state.orchActiveId = null;
      state.orchDetail = null;
    }
    await loadOrchestrations(state);
  } catch (err) {
    state.orchError = String(err);
  } finally {
    state.orchBusy = false;
  }
}
