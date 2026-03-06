import { createOrchestratorTriggerTool } from "../orchestration/orchestrator-trigger-tool.js";
import { resolvePluginTools } from "../plugins/tools.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import { createBrowserTool } from "./tools/browser-tool.js";
import { createCanvasTool } from "./tools/canvas-tool.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createMessageTool } from "./tools/message-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createNovelWriterTool } from "./tools/novel-writer-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createTtsTool } from "./tools/tts-tool.js";
import {
  createWebFetchTool,
  createWebSearchTool,
  gmailListMessages,
  gmailGetMessage,
  gmailSendEmail,
  gmailSendEmailWithAttachment,
  docsCreateDocument,
  sheetsCreateSpreadsheet,
  sheetsAppendValues,
  calendarListEvents,
  calendarCreateEvent,
  driveListFiles,
  slidesCreatePresentation,
  driveUploadFile,
  driveDownloadFile,
} from "./tools/web-tools.js";
export function createVersoTools(options) {
  const imageTool = options?.agentDir?.trim()
    ? createImageTool({
        config: options?.config,
        agentDir: options.agentDir,
        sandboxRoot: options?.sandboxRoot,
        modelHasVision: options?.modelHasVision,
      })
    : null;
  const webSearchTool = createWebSearchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
  });
  const webFetchTool = createWebFetchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
  });
  const messageTool = options?.disableMessageTool
    ? null
    : createMessageTool({
        agentAccountId: options?.agentAccountId,
        agentSessionKey: options?.agentSessionKey,
        config: options?.config,
        currentChannelId: options?.currentChannelId,
        currentChannelProvider: options?.agentChannel,
        currentThreadTs: options?.currentThreadTs,
        replyToMode: options?.replyToMode,
        hasRepliedRef: options?.hasRepliedRef,
        sandboxRoot: options?.sandboxRoot,
        requireExplicitTarget: options?.requireExplicitMessageTarget,
      });
  const tools = [
    createBrowserTool({
      sandboxBridgeUrl: options?.sandboxBrowserBridgeUrl,
      allowHostControl: options?.allowHostBrowserControl,
    }),
    createCanvasTool(),
    createNodesTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    createCronTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    ...(messageTool ? [messageTool] : []),
    createTtsTool({
      agentChannel: options?.agentChannel,
      config: options?.config,
    }),
    createGatewayTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    createAgentsListTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
    }),
    createSessionStatusTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    ...(webSearchTool ? [webSearchTool] : []),
    ...(webFetchTool ? [webFetchTool] : []),
    ...(imageTool ? [imageTool] : []),
    createNovelWriterTool({
      agentChannel: options?.agentChannel,
      agentTo: options?.agentTo,
      agentThreadId: options?.agentThreadId,
      config: options?.config,
    }),
  ];
  if (options?.config?.google?.enabled) {
    const services = options.config.google.services || ["gmail", "docs", "calendar"];
    if (services.includes("gmail")) {
      tools.push(gmailListMessages, gmailGetMessage, gmailSendEmail, gmailSendEmailWithAttachment);
    }
    if (services.includes("docs")) {
      tools.push(docsCreateDocument);
    }
    if (services.includes("sheets")) {
      tools.push(sheetsCreateSpreadsheet, sheetsAppendValues);
    }
    if (services.includes("calendar")) {
      tools.push(calendarListEvents, calendarCreateEvent);
    }
    if (services.includes("drive")) {
      tools.push(driveListFiles, driveUploadFile, driveDownloadFile);
    }
    if (services.includes("slides")) {
      tools.push(slidesCreatePresentation);
    }
  }
  // Orchestrator trigger tool — submit tasks to orchestrator daemon
  const agentId = resolveSessionAgentId({
    sessionKey: options?.agentSessionKey,
    config: options?.config,
  });
  const orchConfig = options?.config?.agents?.list?.find((a) => a.id === agentId)?.orchestration;
  const orchEnabled = orchConfig?.enabled ?? true;
  if (orchEnabled) {
    tools.push(
      createOrchestratorTriggerTool({
        agentId: agentId ?? "main",
        config: options?.config,
        sessionKey: options?.agentSessionKey,
      }),
    );
  }
  const pluginTools = resolvePluginTools({
    context: {
      config: options?.config,
      workspaceDir: options?.workspaceDir,
      agentDir: options?.agentDir,
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
      sessionKey: options?.agentSessionKey,
      messageChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      sandboxed: options?.sandboxed,
    },
    existingToolNames: new Set(tools.map((tool) => tool.name)),
    toolAllowlist: options?.pluginToolAllowlist,
  });
  return [...tools, ...pluginTools];
}
