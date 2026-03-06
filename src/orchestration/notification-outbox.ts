// src/orchestration/notification-outbox.ts — Notification outbox for reliable delivery
//
// Decouples notification delivery from orchestration completion.
// Notifications are persisted to disk and delivered asynchronously with retry.

import fs from "node:fs";
import path from "node:path";
import type { VersoConfig } from "../config/types.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const logger = createSubsystemLogger("orchestration-outbox");

export type NotificationTask = {
  id: string;
  orchestrationId: string;
  targetSessionKey: string;
  message: string;
  createdAtMs: number;
  retryCount: number;
  lastAttemptMs?: number;
  status: "pending" | "delivered" | "failed";
  error?: string;
};

const MAX_RETRIES = 5;
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000]; // Exponential backoff
const OUTBOX_CHECK_INTERVAL_MS = 5000; // Check every 5 seconds

let outboxWorkerInterval: NodeJS.Timeout | null = null;

/**
 * Get the outbox directory path.
 */
function getOutboxDir(): string {
  const stateDir = resolveStateDir();
  const outboxDir = path.join(stateDir, "orchestration-outbox");
  fs.mkdirSync(outboxDir, { recursive: true });
  return outboxDir;
}

/**
 * Get the path for a notification task file.
 */
function getTaskFilePath(taskId: string): string {
  return path.join(getOutboxDir(), `${taskId}.json`);
}

/**
 * Save a notification task to disk.
 */
function saveTask(task: NotificationTask): void {
  const filePath = getTaskFilePath(task.id);
  fs.writeFileSync(filePath, JSON.stringify(task, null, 2), "utf8");
  logger.info("Saved notification task", { taskId: task.id, status: task.status });
}

/**
 * Load a notification task from disk.
 */
function loadTask(taskId: string): NotificationTask | null {
  const filePath = getTaskFilePath(taskId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return JSON.parse(content) as NotificationTask;
  } catch (err) {
    logger.error("Failed to load notification task", { taskId, error: String(err) });
    return null;
  }
}

/**
 * Delete a notification task from disk.
 */
function deleteTask(taskId: string): void {
  const filePath = getTaskFilePath(taskId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    logger.info("Deleted notification task", { taskId });
  }
}

/**
 * List all pending notification tasks.
 */
function listPendingTasks(): NotificationTask[] {
  const outboxDir = getOutboxDir();
  const files = fs.readdirSync(outboxDir);
  const tasks: NotificationTask[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const taskId = file.replace(".json", "");
    const task = loadTask(taskId);
    if (task && task.status === "pending") {
      tasks.push(task);
    }
  }

  return tasks;
}

/**
 * Enqueue a notification for delivery.
 */
export function enqueueNotification(params: {
  orchestrationId: string;
  targetSessionKey: string;
  message: string;
}): string {
  const taskId = `notif-${params.orchestrationId}-${Date.now()}`;
  const task: NotificationTask = {
    id: taskId,
    orchestrationId: params.orchestrationId,
    targetSessionKey: params.targetSessionKey,
    message: params.message,
    createdAtMs: Date.now(),
    retryCount: 0,
    status: "pending",
  };

  saveTask(task);
  logger.info("Enqueued notification", {
    taskId,
    orchestrationId: params.orchestrationId,
    targetSessionKey: params.targetSessionKey,
  });

  return taskId;
}

/**
 * Attempt to deliver a notification task.
 */
async function deliverTask(task: NotificationTask, config: VersoConfig): Promise<boolean> {
  logger.info("Attempting to deliver notification", {
    taskId: task.id,
    orchestrationId: task.orchestrationId,
    targetSessionKey: task.targetSessionKey,
    retryCount: task.retryCount,
  });

  try {
    const { callGateway } = await import("../gateway/call.js");
    const { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } =
      await import("../utils/message-channel.js");

    await callGateway({
      method: "chat.inject",
      params: {
        sessionKey: task.targetSessionKey,
        message: task.message,
        label: "orchestration",
      },
      timeoutMs: 5000,
      config,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "orchestrator-notifier",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });

    logger.info("Successfully delivered notification", {
      taskId: task.id,
      orchestrationId: task.orchestrationId,
    });

    return true;
  } catch (err) {
    logger.warn("Failed to deliver notification", {
      taskId: task.id,
      orchestrationId: task.orchestrationId,
      retryCount: task.retryCount,
      error: String(err),
    });

    return false;
  }
}

/**
 * Process pending notification tasks.
 */
async function processOutbox(config: VersoConfig): Promise<void> {
  const pendingTasks = listPendingTasks();

  if (pendingTasks.length === 0) {
    return;
  }

  logger.info("Processing outbox", { pendingCount: pendingTasks.length });

  for (const task of pendingTasks) {
    // Check if enough time has passed since last attempt
    if (task.lastAttemptMs) {
      const timeSinceLastAttempt = Date.now() - task.lastAttemptMs;
      const requiredDelay = RETRY_DELAYS_MS[Math.min(task.retryCount, RETRY_DELAYS_MS.length - 1)];

      if (timeSinceLastAttempt < requiredDelay) {
        // Not ready to retry yet
        continue;
      }
    }

    // Attempt delivery
    const success = await deliverTask(task, config);

    if (success) {
      // Mark as delivered and delete
      task.status = "delivered";
      saveTask(task);
      deleteTask(task.id);
    } else {
      // Increment retry count
      task.retryCount++;
      task.lastAttemptMs = Date.now();

      if (task.retryCount >= MAX_RETRIES) {
        // Max retries reached - mark as failed (dead letter)
        task.status = "failed";
        task.error = `Max retries (${MAX_RETRIES}) exceeded`;
        saveTask(task);

        logger.error("Notification delivery failed permanently", {
          taskId: task.id,
          orchestrationId: task.orchestrationId,
          targetSessionKey: task.targetSessionKey,
          retryCount: task.retryCount,
        });
      } else {
        // Save updated retry count
        saveTask(task);
      }
    }
  }
}

/**
 * Start the outbox worker that processes pending notifications.
 */
export function startOutboxWorker(config: VersoConfig): void {
  if (outboxWorkerInterval) {
    logger.warn("Outbox worker already running");
    return;
  }

  logger.info("Starting outbox worker", { checkIntervalMs: OUTBOX_CHECK_INTERVAL_MS });

  outboxWorkerInterval = setInterval(() => {
    void processOutbox(config);
  }, OUTBOX_CHECK_INTERVAL_MS);
}

/**
 * Stop the outbox worker.
 */
export function stopOutboxWorker(): void {
  if (outboxWorkerInterval) {
    clearInterval(outboxWorkerInterval);
    outboxWorkerInterval = null;
    logger.info("Stopped outbox worker");
  }
}

/**
 * Get outbox statistics.
 */
export function getOutboxStats(): {
  pending: number;
  failed: number;
} {
  const outboxDir = getOutboxDir();
  const files = fs.readdirSync(outboxDir);

  let pending = 0;
  let failed = 0;

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const taskId = file.replace(".json", "");
    const task = loadTask(taskId);
    if (task) {
      if (task.status === "pending") pending++;
      if (task.status === "failed") failed++;
    }
  }

  return { pending, failed };
}
