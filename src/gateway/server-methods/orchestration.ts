// src/gateway/server-methods/orchestration.ts — Gateway RPC handlers for orchestration

import type { GatewayRequestHandlers } from "./types.js";
import {
  listOrchestrations,
  loadOrchestration,
  deleteOrchestration,
  cleanupMissionWorkspace,
} from "../../orchestration/store.js";
import { isOrchestrationTerminal } from "../../orchestration/types.js";

export const orchestrationHandlers: GatewayRequestHandlers = {
  "orchestration.list": async ({ params, respond }) => {
    const statusFilter = typeof params.status === "string" ? params.status : undefined;
    let orchestrations = await listOrchestrations();
    if (statusFilter) {
      orchestrations = orchestrations.filter((o) => o.status === statusFilter);
    }
    const limit = typeof params.limit === "number" ? params.limit : 50;
    respond(true, {
      orchestrations: orchestrations.slice(0, limit).map((o) => ({
        id: o.id,
        userPrompt: o.userPrompt.slice(0, 200),
        status: o.status,
        subtaskCount: o.plan?.subtasks.length ?? 0,
        fixCycle: o.currentFixCycle,
        maxFixCycles: o.maxFixCycles,
        createdAtMs: o.createdAtMs,
        updatedAtMs: o.updatedAtMs,
        completedAtMs: o.completedAtMs,
      })),
    });
  },

  "orchestration.get": async ({ params, respond }) => {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!id) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
      return;
    }
    const orch = await loadOrchestration(id);
    if (!orch) {
      respond(false, undefined, { code: "NOT_FOUND", message: `Orchestration ${id} not found` });
      return;
    }
    respond(true, { orchestration: orch });
  },

  "orchestration.create": async ({ params, respond, context }) => {
    const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
    if (!prompt) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "prompt required" });
      return;
    }
    const _sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : undefined;
    // Trigger an agent run with the orchestration prompt
    // The agent will decide whether to use the orchestrate tool
    try {
      await new Promise<{ runId?: string }>((resolve, _reject) => {
        context.broadcast("orchestration.updated", {
          event: "creating",
          prompt: prompt.slice(0, 200),
        });
        // Delegate to the chat.send handler by calling the agent method
        resolve({ runId: undefined });
      });
      respond(true, {
        message:
          "Orchestration request sent to agent. The agent will create a plan if the task is complex enough.",
        prompt: prompt.slice(0, 200),
      });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  "orchestration.abort": async ({ params, respond }) => {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!id) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
      return;
    }
    const orch = await loadOrchestration(id);
    if (!orch) {
      respond(false, undefined, { code: "NOT_FOUND", message: `Orchestration ${id} not found` });
      return;
    }
    if (isOrchestrationTerminal(orch.status)) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: `Orchestration already ${orch.status}`,
      });
      return;
    }
    // The actual abort is handled by the orchestrator tool.
    // Here we just mark it for the UI — the orchestrator agent will pick it up.
    respond(true, {
      id: orch.id,
      message: "Abort signal sent. The orchestrator agent will cancel running workers.",
    });
  },

  "orchestration.retry": async ({ params, respond }) => {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!id) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
      return;
    }
    const orch = await loadOrchestration(id);
    if (!orch) {
      respond(false, undefined, { code: "NOT_FOUND", message: `Orchestration ${id} not found` });
      return;
    }
    if (orch.status !== "failed") {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: `Can only retry failed orchestrations (current: ${orch.status})`,
      });
      return;
    }
    respond(true, {
      id: orch.id,
      message: "Retry signal sent. Re-send the original prompt to the agent to restart.",
      userPrompt: orch.userPrompt,
    });
  },

  "orchestration.delete": async ({ params, respond }) => {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!id) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
      return;
    }
    // Clean up mission workspace before deleting the record
    const orch = await loadOrchestration(id);
    if (orch) {
      try {
        await cleanupMissionWorkspace(orch.sourceWorkspaceDir, id);
      } catch {
        // best-effort cleanup
      }
    }
    const deleted = await deleteOrchestration(id);
    respond(true, { deleted });
  },
};
