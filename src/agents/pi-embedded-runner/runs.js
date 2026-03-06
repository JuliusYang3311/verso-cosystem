import {
  diagnosticLogger as diag,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";
const ACTIVE_EMBEDDED_RUNS = new Map();
const ACTIVE_RUN_TIMESTAMPS = new Map();
const MAX_ACTIVE_RUNS = 100;
const MAX_RUN_STALE_MS = 30 * 60 * 1000; // 30 minutes
const EMBEDDED_RUN_WAITERS = new Map();
/**
 * Pending dispatch buffer — messages that arrive between fire-and-forget
 * and the run actually registering via setActiveEmbeddedRun().
 * markDispatchPending() opens the buffer; setActiveEmbeddedRun() drains it.
 */
const PENDING_DISPATCH_MESSAGES = new Map();
const PENDING_DISPATCH_TIMESTAMPS = new Map();
const PENDING_DISPATCH_STALE_MS = 30_000; // 30s — if run never activates, drop
// Reap stale entries that were never cleared (e.g. exception in run).
const runsReapTimer = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, ts] of ACTIVE_RUN_TIMESTAMPS) {
    if (now - ts > MAX_RUN_STALE_MS) {
      diag.warn(`reaping stale run: sessionId=${sessionId} ageMs=${now - ts}`);
      ACTIVE_EMBEDDED_RUNS.delete(sessionId);
      ACTIVE_RUN_TIMESTAMPS.delete(sessionId);
      notifyEmbeddedRunEnded(sessionId);
    }
  }
  // Reap stale pending dispatches
  for (const [sessionId, ts] of PENDING_DISPATCH_TIMESTAMPS) {
    if (now - ts > PENDING_DISPATCH_STALE_MS) {
      const dropped = PENDING_DISPATCH_MESSAGES.get(sessionId)?.length ?? 0;
      if (dropped > 0) {
        diag.warn(
          `reaping stale pending dispatch: sessionId=${sessionId} droppedMessages=${dropped}`,
        );
      }
      PENDING_DISPATCH_MESSAGES.delete(sessionId);
      PENDING_DISPATCH_TIMESTAMPS.delete(sessionId);
    }
  }
}, 60_000);
runsReapTimer.unref?.();
/**
 * Mark a session as having a pending dispatch (fire-and-forget started but
 * run not yet registered). Opens the pending message buffer.
 */
export function markDispatchPending(sessionId) {
  if (!PENDING_DISPATCH_MESSAGES.has(sessionId)) {
    PENDING_DISPATCH_MESSAGES.set(sessionId, []);
    PENDING_DISPATCH_TIMESTAMPS.set(sessionId, Date.now());
    diag.debug(`dispatch pending: sessionId=${sessionId}`);
  }
}
/**
 * Clear pending dispatch state for a session.
 * Called when the fire-and-forget turn completes or fails without
 * ever registering via setActiveEmbeddedRun.
 */
export function clearDispatchPending(sessionId) {
  PENDING_DISPATCH_MESSAGES.delete(sessionId);
  PENDING_DISPATCH_TIMESTAMPS.delete(sessionId);
}
/**
 * Check if a session has a pending dispatch (turn fired but not yet active).
 */
export function isDispatchPending(sessionId) {
  return PENDING_DISPATCH_MESSAGES.has(sessionId);
}
/**
 * Buffer a message for a session whose run hasn't activated yet.
 * Returns true if the message was buffered.
 */
export function queuePendingMessage(sessionId, text) {
  const buf = PENDING_DISPATCH_MESSAGES.get(sessionId);
  if (!buf) {
    return false;
  }
  buf.push(text);
  logMessageQueued({ sessionId, source: "pending-dispatch" });
  diag.debug(`pending message queued: sessionId=${sessionId} bufferSize=${buf.length}`);
  return true;
}
export function queueEmbeddedPiMessage(sessionId, text) {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=no_active_run`);
    return false;
  }
  logMessageQueued({ sessionId, source: "pi-embedded-runner" });
  void handle.queueMessage(text);
  return true;
}
export function abortEmbeddedPiRun(sessionId) {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    diag.debug(`abort failed: sessionId=${sessionId} reason=no_active_run`);
    return false;
  }
  diag.debug(`aborting run: sessionId=${sessionId}`);
  handle.abort();
  return true;
}
export function isEmbeddedPiRunActive(sessionId) {
  const active = ACTIVE_EMBEDDED_RUNS.has(sessionId);
  if (active) {
    diag.debug(`run active check: sessionId=${sessionId} active=true`);
  }
  return active;
}
export function isEmbeddedPiRunStreaming(sessionId) {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    return false;
  }
  return handle.isStreaming();
}
export function waitForEmbeddedPiRunEnd(sessionId, timeoutMs = 15_000) {
  if (!sessionId || !ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
    return Promise.resolve(true);
  }
  diag.debug(`waiting for run end: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
  return new Promise((resolve) => {
    const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? new Set();
    const waiter = {
      resolve,
      timer: setTimeout(
        () => {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            EMBEDDED_RUN_WAITERS.delete(sessionId);
          }
          diag.warn(`wait timeout: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
          resolve(false);
        },
        Math.max(100, timeoutMs),
      ),
    };
    waiters.add(waiter);
    EMBEDDED_RUN_WAITERS.set(sessionId, waiters);
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      waiters.delete(waiter);
      if (waiters.size === 0) {
        EMBEDDED_RUN_WAITERS.delete(sessionId);
      }
      clearTimeout(waiter.timer);
      resolve(true);
    }
  });
}
function notifyEmbeddedRunEnded(sessionId) {
  const waiters = EMBEDDED_RUN_WAITERS.get(sessionId);
  if (!waiters || waiters.size === 0) {
    return;
  }
  EMBEDDED_RUN_WAITERS.delete(sessionId);
  diag.debug(`notifying waiters: sessionId=${sessionId} waiterCount=${waiters.size}`);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
}
export function setActiveEmbeddedRun(sessionId, handle) {
  // Enforce max active runs limit
  if (!ACTIVE_EMBEDDED_RUNS.has(sessionId) && ACTIVE_EMBEDDED_RUNS.size >= MAX_ACTIVE_RUNS) {
    // Evict oldest by timestamp
    let oldestId;
    let oldestTs = Infinity;
    for (const [id, ts] of ACTIVE_RUN_TIMESTAMPS) {
      if (ts < oldestTs) {
        oldestTs = ts;
        oldestId = id;
      }
    }
    if (oldestId) {
      diag.warn(`run limit reached (${MAX_ACTIVE_RUNS}), evicting oldest: sessionId=${oldestId}`);
      ACTIVE_EMBEDDED_RUNS.delete(oldestId);
      ACTIVE_RUN_TIMESTAMPS.delete(oldestId);
      notifyEmbeddedRunEnded(oldestId);
    }
  }
  const wasActive = ACTIVE_EMBEDDED_RUNS.has(sessionId);
  ACTIVE_EMBEDDED_RUNS.set(sessionId, handle);
  ACTIVE_RUN_TIMESTAMPS.set(sessionId, Date.now());
  logSessionStateChange({
    sessionId,
    state: "processing",
    reason: wasActive ? "run_replaced" : "run_started",
  });
  if (!sessionId.startsWith("probe-")) {
    diag.debug(`run registered: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
  }
  // Drain any messages buffered while the run was pending.
  const pendingMessages = PENDING_DISPATCH_MESSAGES.get(sessionId);
  PENDING_DISPATCH_MESSAGES.delete(sessionId);
  PENDING_DISPATCH_TIMESTAMPS.delete(sessionId);
  if (pendingMessages && pendingMessages.length > 0) {
    diag.debug(`draining pending messages: sessionId=${sessionId} count=${pendingMessages.length}`);
    for (const text of pendingMessages) {
      void handle.queueMessage(text);
    }
  }
}
export function clearActiveEmbeddedRun(sessionId, handle) {
  if (ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle) {
    ACTIVE_EMBEDDED_RUNS.delete(sessionId);
    ACTIVE_RUN_TIMESTAMPS.delete(sessionId);
    // Drop any remaining pending messages for this session.
    PENDING_DISPATCH_MESSAGES.delete(sessionId);
    PENDING_DISPATCH_TIMESTAMPS.delete(sessionId);
    logSessionStateChange({ sessionId, state: "idle", reason: "run_completed" });
    if (!sessionId.startsWith("probe-")) {
      diag.debug(`run cleared: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
    }
    notifyEmbeddedRunEnded(sessionId);
  } else {
    diag.debug(`run clear skipped: sessionId=${sessionId} reason=handle_mismatch`);
  }
}
