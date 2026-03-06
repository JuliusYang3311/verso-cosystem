// src/orchestration/orchestrator-trigger-tool.ts — Tool for triggering orchestration
//
// This tool allows the main agent to submit orchestration requests.
// The orchestrator daemon will process the request in the background.

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { VersoConfig } from "../config/types.js";
import { jsonResult, readStringParam } from "../agents/tools/common.js";
import { submitOrchestration } from "./orchestrator.js";

const OrchestratorTriggerSchema = Type.Object({
  action: Type.Union([Type.Literal("submit"), Type.Literal("status")]),
  userPrompt: Type.Optional(
    Type.String({ description: "The user's task description (for submit action)" }),
  ),
  baseProjectDir: Type.Optional(
    Type.String({
      description:
        "Path to existing project directory to enhance (for submit action). If provided, the project will be copied to sandbox before orchestration starts.",
    }),
  ),
});

export type OrchestratorTriggerToolOptions = {
  agentId: string;
  config?: VersoConfig;
  sessionKey?: string;
  provider?: string;
  model?: string;
};

/**
 * Create the orchestrator trigger tool for the main agent.
 * This tool allows the agent to submit orchestration requests to the background daemon.
 */
export function createOrchestratorTriggerTool(opts: OrchestratorTriggerToolOptions): AnyAgentTool {
  return {
    label: "Orchestrator",
    name: "orchestrator",
    description: `Submit complex tasks to the orchestrator daemon for multi-agent parallel execution.

ACTIONS:
- submit: Submit a new orchestration request. The daemon will decompose the task, dispatch workers, run acceptance tests, and handle fix loops automatically. Requires: userPrompt. Optional: baseProjectDir (path to existing project to enhance).
- status: Check if the orchestrator daemon is running.

MODES:
1. Build from scratch: Don't provide baseProjectDir. Sandbox starts empty.
2. Enhance existing project: Provide baseProjectDir. Project is copied to sandbox, orchestrator reviews existing code, then plans enhancements. Results replace original project.

WHEN TO USE:
Use orchestration for complex tasks that involve:
- Building a new project or application from scratch
- Enhancing existing projects with multiple new features
- 3+ distinct components that can be worked on independently
- Parallel independent work (e.g., "create frontend, backend, and database schema")
- Multi-topic research or analysis (e.g., "analyze US stocks across tech, finance, and healthcare sectors")
- Comprehensive reports with multiple independent sections
- Tasks that would take significantly longer if done sequentially

DO NOT USE for:
- Simple, focused tasks (single file changes, bug fixes)
- Tasks that are inherently sequential
- Quick questions or explanations
- Single-topic research or simple analysis

WORKFLOW:
1. Call orchestrator with action "submit" and the user's task description
2. The daemon will process the request in the background
3. Results will be written to an output directory when complete
4. You can check orchestration status via the orchestration.get gateway method`,
    parameters: OrchestratorTriggerSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const action = readStringParam(params, "action", { required: true });

      switch (action) {
        case "submit": {
          const userPrompt = readStringParam(params, "userPrompt", { required: true });
          const baseProjectDir = readStringParam(params, "baseProjectDir");
          try {
            const result = await submitOrchestration(userPrompt, {
              cfg: opts.config,
              agentId: opts.agentId,
              triggeringSessionKey: opts.sessionKey,
              baseProjectDir,
              provider: opts.provider,
              model: opts.model,
            });
            return jsonResult({
              success: true,
              orchestrationId: result.orchestrationId,
              daemonStarted: result.daemonStarted,
              mode: baseProjectDir ? "enhance" : "build-from-scratch",
              message: result.daemonStarted
                ? `Orchestration submitted (ID: ${result.orchestrationId}). Daemon started in background.${baseProjectDir ? ` Enhancing project at: ${baseProjectDir}` : ""}`
                : `Orchestration submitted (ID: ${result.orchestrationId}). Daemon is processing the request.`,
            });
          } catch (err) {
            return jsonResult({
              success: false,
              error: String(err),
              message: `Failed to submit orchestration: ${String(err)}`,
            });
          }
        }

        default:
          return jsonResult({ error: `Unknown action: ${action}` });
      }
    },
  };
}
