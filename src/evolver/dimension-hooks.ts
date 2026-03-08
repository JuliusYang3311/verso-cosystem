/**
 * dimension-hooks.ts
 *
 * Online learning hooks for the latent factor space.
 *
 * Signals flow:  memory-search / web-search  →  emitFactorHit / emitFactorMiss
 *                                             →  learningDimensionHooks
 *                                             →  updateFactorWeight (EMA)
 *
 * Weight update rule (exponential moving average):
 *   hit  → w' = w + lr × (score − baseline)   // reward factors that retrieve well
 *   miss → w' = w × (1 − decay)               // slowly shrink unused factors
 *
 * All writes go to workspace/evolver/assets/factor-space.json via
 * updateFactorWeight(), which reloads the latest file before writing.
 */

import { loadFactorSpace, updateFactorWeight } from "../memory/latent-factors.js";

// ---------- Event types ----------

export type FactorHitEvent = {
  factorId: string;
  querySnippet: string;
  retrievalScore: number;
  providerModel: string;
  useCase: string;
  timestamp: number;
};

export type FactorMissEvent = {
  factorId: string;
  querySnippet: string;
  providerModel: string;
  useCase: string;
  timestamp: number;
};

export type ThresholdFeedbackEvent = {
  factorId: string;
  currentThreshold: number;
  suggestedThreshold: number;
  providerModel: string;
  timestamp: number;
};

export type DimensionHooks = {
  onFactorHit(event: FactorHitEvent): void;
  onFactorMiss(event: FactorMissEvent): void;
  onThresholdFeedback(event: ThresholdFeedbackEvent): void;
};

// ---------- Learning hyperparameters ----------

const LEARNING_RATE = 0.05;
const MISS_DECAY = 0.02;
const SCORE_BASELINE = 0.5;

// Debounce: batch weight updates to avoid excessive I/O
const _pendingUpdates = new Map<
  string,
  { delta: number; providerModel: string; useCase: string }
>();
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 5_000;

async function flushWeightUpdates(): Promise<void> {
  if (_pendingUpdates.size === 0) return;
  const batch = new Map(_pendingUpdates);
  _pendingUpdates.clear();

  try {
    let space = await loadFactorSpace();
    for (const [factorId, { delta, providerModel, useCase }] of batch) {
      const factor = space.factors.find((f) => f.id === factorId);
      if (!factor) continue;
      const wKey = `${providerModel}:${useCase}`;
      const current = factor.weights[wKey] ?? 1.0;
      space = await updateFactorWeight(space, factorId, providerModel, useCase, current + delta);
    }
  } catch {
    // Non-critical — weight updates are best-effort
  }
}

function scheduleFlush(): void {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    void flushWeightUpdates();
  }, FLUSH_INTERVAL_MS);
}

function accumulateUpdate(
  factorId: string,
  providerModel: string,
  useCase: string,
  delta: number,
): void {
  const key = `${factorId}:${providerModel}:${useCase}`;
  const existing = _pendingUpdates.get(key);
  if (existing) {
    existing.delta += delta;
  } else {
    _pendingUpdates.set(key, { delta, providerModel, useCase });
  }
  scheduleFlush();
}

// ---------- Learning implementation ----------

export const learningDimensionHooks: DimensionHooks = {
  onFactorHit(event) {
    const delta = LEARNING_RATE * (event.retrievalScore - SCORE_BASELINE);
    accumulateUpdate(event.factorId, event.providerModel, event.useCase, delta);
  },
  onFactorMiss(event) {
    accumulateUpdate(event.factorId, event.providerModel, event.useCase, -MISS_DECAY);
  },
  onThresholdFeedback(_event) {
    // Threshold tuning is handled by the evolver's GEP loop, not online
  },
};

// ---------- Logging implementation (fallback) ----------

export const loggingDimensionHooks: DimensionHooks = {
  onFactorHit(event) {
    console.debug(
      `[latent-factor] hit factor=${event.factorId} score=${event.retrievalScore.toFixed(3)} model=${event.providerModel}`,
    );
  },
  onFactorMiss(event) {
    console.debug(`[latent-factor] miss factor=${event.factorId} model=${event.providerModel}`);
  },
  onThresholdFeedback(event) {
    console.debug(
      `[latent-factor] threshold-feedback factor=${event.factorId} current=${event.currentThreshold} suggested=${event.suggestedThreshold} model=${event.providerModel}`,
    );
  },
};

// ---------- No-op implementation (for testing) ----------

export const noopDimensionHooks: DimensionHooks = {
  onFactorHit: () => {},
  onFactorMiss: () => {},
  onThresholdFeedback: () => {},
};

// ---------- Hook registry ----------

let _activeHooks: DimensionHooks = learningDimensionHooks;

export function getDimensionHooks(): DimensionHooks {
  return _activeHooks;
}

export function registerDimensionHooks(hooks: DimensionHooks): void {
  _activeHooks = hooks;
}

// ---------- Convenience emitters ----------

export function emitFactorHit(
  factorId: string,
  querySnippet: string,
  retrievalScore: number,
  providerModel: string,
  useCase = "memory",
): void {
  _activeHooks.onFactorHit({
    factorId,
    querySnippet,
    retrievalScore,
    providerModel,
    useCase,
    timestamp: Date.now(),
  });
}

export function emitFactorMiss(
  factorId: string,
  querySnippet: string,
  providerModel: string,
  useCase = "memory",
): void {
  _activeHooks.onFactorMiss({
    factorId,
    querySnippet,
    providerModel,
    useCase,
    timestamp: Date.now(),
  });
}

export function emitThresholdFeedback(
  factorId: string,
  currentThreshold: number,
  suggestedThreshold: number,
  providerModel: string,
): void {
  _activeHooks.onThresholdFeedback({
    factorId,
    currentThreshold,
    suggestedThreshold,
    providerModel,
    timestamp: Date.now(),
  });
}
