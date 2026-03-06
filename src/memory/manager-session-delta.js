/**
 * manager-session-delta.ts
 * Session delta tracking and dirty-state management for MemoryIndexManager.
 * Tracks byte/message deltas per session file to decide when re-indexing is needed.
 * Extracted from manager.ts to reduce file size.
 */
import fs from "node:fs/promises";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { countNewlines } from "./manager-session-files.js";
const log = createSubsystemLogger("memory");
/**
 * Update the delta tracking state for a single session file.
 * Returns null if thresholds are not configured.
 */
export async function updateSessionDelta(sessionFile, thresholds, deltas) {
  if (!thresholds) {
    return null;
  }
  let stat;
  try {
    stat = await fs.stat(sessionFile);
  } catch {
    return null;
  }
  const size = stat.size;
  let state = deltas.get(sessionFile);
  if (!state) {
    state = { lastSize: 0, pendingBytes: 0, pendingMessages: 0 };
    deltas.set(sessionFile, state);
  }
  const deltaBytes = Math.max(0, size - state.lastSize);
  if (deltaBytes === 0 && size === state.lastSize) {
    return {
      deltaBytes: thresholds.deltaBytes,
      deltaMessages: thresholds.deltaMessages,
      pendingBytes: state.pendingBytes,
      pendingMessages: state.pendingMessages,
    };
  }
  if (size < state.lastSize) {
    state.lastSize = size;
    state.pendingBytes += size;
    const shouldCountMessages =
      thresholds.deltaMessages > 0 &&
      (thresholds.deltaBytes <= 0 || state.pendingBytes < thresholds.deltaBytes);
    if (shouldCountMessages) {
      state.pendingMessages += await countNewlines(sessionFile, 0, size);
    }
  } else {
    state.pendingBytes += deltaBytes;
    const shouldCountMessages =
      thresholds.deltaMessages > 0 &&
      (thresholds.deltaBytes <= 0 || state.pendingBytes < thresholds.deltaBytes);
    if (shouldCountMessages) {
      state.pendingMessages += await countNewlines(sessionFile, state.lastSize, size);
    }
    state.lastSize = size;
  }
  deltas.set(sessionFile, state);
  return {
    deltaBytes: thresholds.deltaBytes,
    deltaMessages: thresholds.deltaMessages,
    pendingBytes: state.pendingBytes,
    pendingMessages: state.pendingMessages,
  };
}
/**
 * Reset the delta tracking for a session file after successful indexing.
 */
export function resetSessionDelta(absPath, size, deltas) {
  const state = deltas.get(absPath);
  if (!state) {
    return;
  }
  state.lastSize = size;
  state.pendingBytes = 0;
  state.pendingMessages = 0;
}
/**
 * Process a batch of pending session files and determine which need sync.
 * Returns the set of files that crossed the delta threshold.
 */
export async function processSessionDeltaBatch(params) {
  if (params.pendingFiles.size === 0) {
    return;
  }
  const pending = Array.from(params.pendingFiles);
  params.pendingFiles.clear();
  let shouldSync = false;
  for (const sessionFile of pending) {
    const delta = await updateSessionDelta(sessionFile, params.thresholds, params.deltas);
    if (!delta) {
      continue;
    }
    const bytesThreshold = delta.deltaBytes;
    const messagesThreshold = delta.deltaMessages;
    const bytesHit =
      bytesThreshold <= 0 ? delta.pendingBytes > 0 : delta.pendingBytes >= bytesThreshold;
    const messagesHit =
      messagesThreshold <= 0
        ? delta.pendingMessages > 0
        : delta.pendingMessages >= messagesThreshold;
    if (!bytesHit && !messagesHit) {
      continue;
    }
    params.dirtyFiles.add(sessionFile);
    const state = params.deltas.get(sessionFile);
    if (state) {
      state.pendingBytes =
        bytesThreshold > 0 ? Math.max(0, state.pendingBytes - bytesThreshold) : 0;
      state.pendingMessages =
        messagesThreshold > 0 ? Math.max(0, state.pendingMessages - messagesThreshold) : 0;
    }
    shouldSync = true;
  }
  if (shouldSync) {
    void params.sync("session-delta").catch((err) => {
      log.warn(`memory sync failed (session-delta): ${String(err)}`);
    });
  }
}
