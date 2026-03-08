import type { CommandHandler } from "./commands-types.js";
import {
  getEvolverStatus,
  readRecentActivity,
  startEvolverDaemon,
  stopEvolverDaemon,
} from "../../agents/evolver.js";
import { readPendingReview, decidePendingReview } from "../../evolver/evolver-review.js";
import { logVerbose } from "../../globals.js";

function shouldHandle(command: string, prefix: string) {
  return command === prefix || command.startsWith(`${prefix} `);
}

function parseEvolveMode(body: string): "on" | "off" | "status" | "approve" | "reject" {
  const trimmed = body.trim();
  if (trimmed === "/evolve") {
    return "on";
  }
  const rest = trimmed.slice("/evolve".length).trim();
  if (!rest) {
    return "on";
  }
  if (rest === "off") {
    return "off";
  }
  if (rest === "status") {
    return "status";
  }
  if (rest === "on") {
    return "on";
  }
  if (rest === "approve" || rest === "yes" || rest === "y") {
    return "approve";
  }
  if (rest === "reject" || rest === "no" || rest === "n") {
    return "reject";
  }
  return "status";
}

export const handleEvolverCommand: CommandHandler = async (params) => {
  const body = params.command.commandBodyNormalized;
  if (!shouldHandle(body, "/evolve") && !shouldHandle(body, "/evolveoff")) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring evolve command from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  if (shouldHandle(body, "/evolveoff")) {
    const result = await stopEvolverDaemon();
    const reply = result.stopped
      ? `🧬 Evolver stopped (pid ${result.pid ?? "unknown"}).`
      : "🧬 Evolver is not running.";
    return { shouldContinue: false, reply: { text: reply } };
  }

  const mode = parseEvolveMode(body);

  if (mode === "approve") {
    const review = readPendingReview();
    if (!review || review.decision) {
      return { shouldContinue: false, reply: { text: "🧬 No pending review to approve." } };
    }
    decidePendingReview("approve");
    return {
      shouldContinue: false,
      reply: {
        text: `🧬 Review approved. Deploying ${review.filesChanged.length} file(s):\n${review.filesChanged.join("\n")}`,
      },
    };
  }

  if (mode === "reject") {
    const review = readPendingReview();
    if (!review || review.decision) {
      return { shouldContinue: false, reply: { text: "🧬 No pending review to reject." } };
    }
    decidePendingReview("reject");
    return {
      shouldContinue: false,
      reply: { text: "🧬 Review rejected. Changes will be rolled back." },
    };
  }

  if (mode === "status") {
    const status = await getEvolverStatus();
    const activity = await readRecentActivity();
    const review = readPendingReview();
    const lines = [
      status.running
        ? `🧬 Evolver running (pid ${status.pid ?? "unknown"}).`
        : "🧬 Evolver is not running.",
      `Log: ${status.logPath}`,
    ];
    if (review && !review.decision) {
      lines.push(
        `\n⏳ Pending review (${review.cycleId}):`,
        `  Files: ${review.filesChanged.join(", ")}`,
        `  Summary: ${review.summary}`,
        `  Use /evolve approve or /evolve reject to decide.`,
      );
    }
    lines.push(activity ? `\nRecent activity:\n${activity}` : "\nNo recent activity.");
    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  if (mode === "off") {
    const result = await stopEvolverDaemon();
    const reply = result.stopped
      ? `🧬 Evolver stopped (pid ${result.pid ?? "unknown"}).`
      : "🧬 Evolver is not running.";
    return { shouldContinue: false, reply: { text: reply } };
  }

  const start = await startEvolverDaemon({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
  });
  if (!start.started) {
    const error = start.error ? ` ${start.error}` : "";
    return {
      shouldContinue: false,
      reply: {
        text: `🧬 Evolver already running (pid ${start.pid ?? "unknown"}). Log: ${start.logPath}${error}`,
      },
    };
  }
  return {
    shouldContinue: false,
    reply: {
      text: `🧬 Evolver started (pid ${start.pid}). Log: ${start.logPath}`,
    },
  };
};
