/**
 * manager-batch-failure.ts
 * Batch failure tracking and fallback logic for MemoryIndexManager.
 * Handles failure counting, locking, timeout retry, and fallback-to-non-batch.
 * Extracted from manager.ts to reduce file size.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
const log = createSubsystemLogger("memory");
export const BATCH_FAILURE_LIMIT = 2;
export function createBatchFailureTracker(batchEnabled) {
  return {
    count: 0,
    lastError: undefined,
    lastProvider: undefined,
    lock: Promise.resolve(),
    batchEnabled,
  };
}
async function withBatchFailureLock(tracker, fn) {
  let release;
  const wait = tracker.lock;
  tracker.lock = new Promise((resolve) => {
    release = resolve;
  });
  await wait;
  try {
    return await fn();
  } finally {
    release();
  }
}
export async function resetBatchFailureCount(tracker) {
  await withBatchFailureLock(tracker, async () => {
    if (tracker.count > 0) {
      log.debug("memory embeddings: batch recovered; resetting failure count");
    }
    tracker.count = 0;
    tracker.lastError = undefined;
    tracker.lastProvider = undefined;
  });
}
export async function recordBatchFailure(tracker, params) {
  return await withBatchFailureLock(tracker, async () => {
    if (!tracker.batchEnabled) {
      return { disabled: true, count: tracker.count };
    }
    const increment = params.forceDisable ? BATCH_FAILURE_LIMIT : Math.max(1, params.attempts ?? 1);
    tracker.count += increment;
    tracker.lastError = params.message;
    tracker.lastProvider = params.provider;
    const disabled = params.forceDisable || tracker.count >= BATCH_FAILURE_LIMIT;
    if (disabled) {
      tracker.batchEnabled = false;
    }
    return { disabled, count: tracker.count };
  });
}
export function isBatchTimeoutError(message) {
  return /timed out|timeout/i.test(message);
}
export async function runBatchWithTimeoutRetry(params) {
  try {
    return await params.run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isBatchTimeoutError(message)) {
      log.warn(`memory embeddings: ${params.provider} batch timed out; retrying once`);
      try {
        return await params.run();
      } catch (retryErr) {
        retryErr.batchAttempts = 2;
        throw retryErr;
      }
    }
    throw err;
  }
}
export async function runBatchWithFallback(tracker, params) {
  if (!tracker.batchEnabled) {
    return await params.fallback();
  }
  try {
    const result = await runBatchWithTimeoutRetry({
      provider: params.provider,
      run: params.run,
    });
    await resetBatchFailureCount(tracker);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = err.batchAttempts ?? 1;
    const forceDisable = /asyncBatchEmbedContent not available/i.test(message);
    const failure = await recordBatchFailure(tracker, {
      provider: params.provider,
      message,
      attempts,
      forceDisable,
    });
    const suffix = failure.disabled ? "disabling batch" : "keeping batch enabled";
    log.warn(
      `memory embeddings: ${params.provider} batch failed (${failure.count}/${BATCH_FAILURE_LIMIT}); ${suffix}; falling back to non-batch embeddings: ${message}`,
    );
    return await params.fallback();
  }
}
