import { readPendingReview } from "../../evolver/evolver-review.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { shouldHandleTextCommands } from "../commands-registry.js";
import { handleAllowlistCommand } from "./commands-allowlist.js";
import { handleApproveCommand } from "./commands-approve.js";
import { handleBashCommand } from "./commands-bash.js";
import { handleCompactCommand } from "./commands-compact.js";
import { handleConfigCommand, handleDebugCommand } from "./commands-config.js";
import { handleEvolverCommand } from "./commands-evolver.js";
import {
  handleCommandsListCommand,
  handleContextCommand,
  handleHelpCommand,
  handleStatusCommand,
  handleWhoamiCommand,
} from "./commands-info.js";
import { handleModelsCommand } from "./commands-models.js";
import { handlePluginCommand } from "./commands-plugin.js";
import {
  handleAbortTrigger,
  handleActivationCommand,
  handleRestartCommand,
  handleSendPolicyCommand,
  handleStopCommand,
  handleUsageCommand,
} from "./commands-session.js";
import { handleTtsCommands } from "./commands-tts.js";
import { routeReply } from "./route-reply.js";
let HANDLERS = null;
export async function handleCommands(params) {
  if (HANDLERS === null) {
    HANDLERS = [
      // Plugin commands are processed first, before built-in commands
      handlePluginCommand,
      handleBashCommand,
      handleActivationCommand,
      handleSendPolicyCommand,
      handleUsageCommand,
      handleRestartCommand,
      handleTtsCommands,
      handleHelpCommand,
      handleCommandsListCommand,
      handleStatusCommand,
      handleAllowlistCommand,
      handleApproveCommand,
      handleContextCommand,
      handleWhoamiCommand,
      handleConfigCommand,
      handleDebugCommand,
      handleModelsCommand,
      handleStopCommand,
      handleCompactCommand,
      handleEvolverCommand,
      handleAbortTrigger,
    ];
  }
  const resetMatch = params.command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/);
  const resetRequested = Boolean(resetMatch);
  if (resetRequested && !params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /reset from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  // Trigger internal hook for reset/new commands
  if (resetRequested && params.command.isAuthorizedSender) {
    const commandAction = resetMatch?.[1] ?? "new";
    const hookEvent = createInternalHookEvent("command", commandAction, params.sessionKey ?? "", {
      sessionEntry: params.sessionEntry,
      previousSessionEntry: params.previousSessionEntry,
      commandSource: params.command.surface,
      senderId: params.command.senderId,
      cfg: params.cfg, // Pass config for LLM slug generation
    });
    await triggerInternalHook(hookEvent);
    // Send hook messages immediately if present
    if (hookEvent.messages.length > 0) {
      // Use OriginatingChannel/To if available, otherwise fall back to command channel/from
      // oxlint-disable-next-line typescript/no-explicit-any
      const channel = params.ctx.OriginatingChannel || params.command.channel;
      // For replies, use 'from' (the sender) not 'to' (which might be the bot itself)
      const to = params.ctx.OriginatingTo || params.command.from || params.command.to;
      if (channel && to) {
        const hookReply = { text: hookEvent.messages.join("\n\n") };
        await routeReply({
          payload: hookReply,
          channel: channel,
          to: to,
          sessionKey: params.sessionKey,
          accountId: params.ctx.AccountId,
          threadId: params.ctx.MessageThreadId,
          cfg: params.cfg,
        });
      }
    }
  }
  const allowTextCommands = shouldHandleTextCommands({
    cfg: params.cfg,
    surface: params.command.surface,
    commandSource: params.ctx.CommandSource,
  });
  // Side-channel: notify user once about pending evolver review (non-blocking)
  try {
    const review = readPendingReview();
    if (review && !review.decision && !review.notified) {
      const fs = await import("node:fs");
      const { resolveStateDir } = await import("../../config/paths.js");
      const path = await import("node:path");
      const reviewPath = path.join(resolveStateDir(), "logs", "evolver-pending-review.json");
      review.notified = true;
      fs.writeFileSync(reviewPath, JSON.stringify(review, null, 2) + "\n");
      const channel = params.ctx.OriginatingChannel || params.command.channel;
      const to = params.ctx.OriginatingTo || params.command.from || params.command.to;
      if (channel && to) {
        const fileList = review.filesChanged.slice(0, 5).join(", ");
        const more =
          review.filesChanged.length > 5 ? ` and ${review.filesChanged.length - 5} more` : "";
        await routeReply({
          payload: {
            text: `🧬 Evolver review ready (${review.cycleId}): ${review.filesChanged.length} file(s) changed (${fileList}${more}). Use /evolve approve or /evolve reject.`,
          },
          channel,
          to,
          sessionKey: params.sessionKey,
          accountId: params.ctx.AccountId,
          threadId: params.ctx.MessageThreadId,
          cfg: params.cfg,
        });
      }
    }
  } catch {
    // Non-critical: don't break command processing if review check fails
  }
  for (const handler of HANDLERS) {
    const result = await handler(params, allowTextCommands);
    if (result) {
      return result;
    }
  }
  const sendPolicy = resolveSendPolicy({
    cfg: params.cfg,
    entry: params.sessionEntry,
    sessionKey: params.sessionKey,
    channel: params.sessionEntry?.channel ?? params.command.channel,
    chatType: params.sessionEntry?.chatType,
  });
  if (sendPolicy === "deny") {
    logVerbose(`Send blocked by policy for session ${params.sessionKey ?? "unknown"}`);
    return { shouldContinue: false };
  }
  return { shouldContinue: true };
}
