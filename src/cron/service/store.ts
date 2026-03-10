import fs from "node:fs";
import type { CronJob } from "../types.js";
import type { CronServiceState } from "./state.js";
import { parseAbsoluteTimeMs } from "../parse.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { recomputeNextRuns } from "./jobs.js";
import { inferLegacyName, normalizeOptionalText } from "./normalize.js";

function normalizePayloadKind(payload: Record<string, unknown>) {
  const raw = typeof payload.kind === "string" ? payload.kind.trim().toLowerCase() : "";
  if (raw === "agentturn") {
    payload.kind = "agentTurn";
    return true;
  }
  if (raw === "systemevent") {
    payload.kind = "systemEvent";
    return true;
  }
  return false;
}

function inferPayloadIfMissing(raw: Record<string, unknown>) {
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (message) {
    raw.payload = { kind: "agentTurn", message };
    return true;
  }
  if (text) {
    raw.payload = { kind: "systemEvent", text };
    return true;
  }
  return false;
}

function copyTopLevelAgentTurnFields(
  raw: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  let mutated = false;

  const copyTrimmedString = (field: "model" | "thinking") => {
    const existing = payload[field];
    if (typeof existing === "string" && existing.trim()) {
      return;
    }
    const value = raw[field];
    if (typeof value === "string" && value.trim()) {
      payload[field] = value.trim();
      mutated = true;
    }
  };
  copyTrimmedString("model");
  copyTrimmedString("thinking");

  if (
    typeof payload.timeoutSeconds !== "number" &&
    typeof raw.timeoutSeconds === "number" &&
    Number.isFinite(raw.timeoutSeconds)
  ) {
    payload.timeoutSeconds = Math.max(1, Math.floor(raw.timeoutSeconds));
    mutated = true;
  }

  if (
    typeof payload.allowUnsafeExternalContent !== "boolean" &&
    typeof raw.allowUnsafeExternalContent === "boolean"
  ) {
    payload.allowUnsafeExternalContent = raw.allowUnsafeExternalContent;
    mutated = true;
  }

  return mutated;
}

function stripLegacyPayloadDeliveryFields(payload: Record<string, unknown>) {
  let mutated = false;
  for (const field of ["deliver", "channel", "to", "bestEffortDeliver", "provider"] as const) {
    if (field in payload) {
      delete payload[field];
      mutated = true;
    }
  }
  return mutated;
}

function buildDeliveryFromLegacyTopLevel(
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  const deliver = raw.deliver;
  const channelRaw = typeof raw.channel === "string" ? raw.channel.trim().toLowerCase() : "";
  const providerRaw = typeof raw.provider === "string" ? raw.provider.trim().toLowerCase() : "";
  const toRaw = typeof raw.to === "string" ? raw.to.trim() : "";
  const bestEffort = typeof raw.bestEffortDeliver === "boolean" ? raw.bestEffortDeliver : undefined;
  const hasLegacy =
    typeof deliver === "boolean" ||
    Boolean(toRaw) ||
    Boolean(channelRaw) ||
    Boolean(providerRaw) ||
    bestEffort !== undefined;
  if (!hasLegacy) return null;
  const next: Record<string, unknown> = { mode: deliver === false ? "none" : "announce" };
  const ch = channelRaw || providerRaw;
  if (ch) next.channel = ch;
  if (toRaw) next.to = toRaw;
  if (bestEffort !== undefined) next.bestEffort = bestEffort;
  return next;
}

function buildDeliveryFromLegacyPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const deliver = payload.deliver;
  const channelRaw =
    typeof payload.channel === "string" ? payload.channel.trim().toLowerCase() : "";
  const providerRaw =
    typeof payload.provider === "string" ? payload.provider.trim().toLowerCase() : "";
  const toRaw = typeof payload.to === "string" ? payload.to.trim() : "";
  const bestEffort =
    typeof payload.bestEffortDeliver === "boolean" ? payload.bestEffortDeliver : undefined;
  const hasLegacy =
    typeof deliver === "boolean" ||
    Boolean(toRaw) ||
    Boolean(channelRaw) ||
    Boolean(providerRaw) ||
    bestEffort !== undefined;
  if (!hasLegacy) return null;
  const next: Record<string, unknown> = { mode: deliver === false ? "none" : "announce" };
  const ch = channelRaw || providerRaw;
  if (ch) next.channel = ch;
  if (toRaw) next.to = toRaw;
  if (bestEffort !== undefined) next.bestEffort = bestEffort;
  return next;
}

function stripLegacyTopLevelFields(raw: Record<string, unknown>) {
  const fields = [
    "model",
    "thinking",
    "timeoutSeconds",
    "allowUnsafeExternalContent",
    "message",
    "text",
    "deliver",
    "channel",
    "to",
    "bestEffortDeliver",
    "provider",
  ] as const;
  let had = false;
  for (const field of fields) {
    if (field in raw) {
      delete raw[field];
      had = true;
    }
  }
  return had;
}

async function getFileMtimeMs(path: string): Promise<number | null> {
  try {
    const stats = await fs.promises.stat(path);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

export async function ensureLoaded(
  state: CronServiceState,
  opts?: {
    forceReload?: boolean;
    /** Skip recomputing nextRunAtMs after load so the caller can run due
     *  jobs against the persisted values first (see onTimer). */
    skipRecompute?: boolean;
  },
) {
  if (state.store && !opts?.forceReload) {
    return;
  }

  const fileMtimeMs = await getFileMtimeMs(state.deps.storePath);
  const loaded = await loadCronStore(state.deps.storePath);
  const jobs = (loaded.jobs ?? []) as unknown as Array<Record<string, unknown>>;
  let mutated = false;
  for (const raw of jobs) {
    const rawState = raw.state;
    if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) {
      raw.state = {};
      mutated = true;
    }

    const nameRaw = raw.name;
    if (typeof nameRaw !== "string" || nameRaw.trim().length === 0) {
      raw.name = inferLegacyName({
        schedule: raw.schedule as never,
        payload: raw.payload as never,
      });
      mutated = true;
    } else {
      raw.name = nameRaw.trim();
    }

    const desc = normalizeOptionalText(raw.description);
    if (raw.description !== desc) {
      raw.description = desc;
      mutated = true;
    }

    if (typeof raw.enabled !== "boolean") {
      raw.enabled = true;
      mutated = true;
    }

    const payload = raw.payload;
    if (
      (!payload || typeof payload !== "object" || Array.isArray(payload)) &&
      inferPayloadIfMissing(raw)
    ) {
      mutated = true;
    }

    const payloadRecord =
      raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
        ? (raw.payload as Record<string, unknown>)
        : null;

    if (payloadRecord) {
      if (normalizePayloadKind(payloadRecord)) {
        mutated = true;
      }
      if (!payloadRecord.kind) {
        if (typeof payloadRecord.message === "string" && payloadRecord.message.trim()) {
          payloadRecord.kind = "agentTurn";
          mutated = true;
        } else if (typeof payloadRecord.text === "string" && payloadRecord.text.trim()) {
          payloadRecord.kind = "systemEvent";
          mutated = true;
        }
      }
      if (payloadRecord.kind === "agentTurn") {
        if (copyTopLevelAgentTurnFields(raw, payloadRecord)) {
          mutated = true;
        }
      }
    }

    // Build delivery from legacy sources before stripping.
    const delivery = raw.delivery;
    const hasDelivery = delivery && typeof delivery === "object" && !Array.isArray(delivery);
    if (!hasDelivery) {
      // Try legacy top-level fields first, then payload fields.
      const fromTopLevel = buildDeliveryFromLegacyTopLevel(raw);
      const fromPayload = payloadRecord ? buildDeliveryFromLegacyPayload(payloadRecord) : null;
      const legacyDelivery = fromTopLevel ?? fromPayload;
      if (legacyDelivery) {
        raw.delivery = legacyDelivery;
        mutated = true;
      } else {
        // Default: isolated agentTurn jobs get announce delivery.
        const payloadKind =
          payloadRecord && typeof payloadRecord.kind === "string" ? payloadRecord.kind : "";
        const sessionTarget =
          typeof raw.sessionTarget === "string" ? raw.sessionTarget.trim().toLowerCase() : "";
        const isIsolatedAgentTurn =
          sessionTarget === "isolated" || (sessionTarget === "" && payloadKind === "agentTurn");
        if (isIsolatedAgentTurn && payloadKind === "agentTurn") {
          raw.delivery = { mode: "announce" };
          mutated = true;
        }
      }
    } else {
      const deliveryRecord = delivery as Record<string, unknown>;
      const modeRaw = deliveryRecord.mode;
      if (typeof modeRaw === "string") {
        const lowered = modeRaw.trim().toLowerCase();
        if (lowered === "deliver") {
          deliveryRecord.mode = "announce";
          mutated = true;
        }
      } else if (modeRaw === undefined || modeRaw === null) {
        deliveryRecord.mode = "announce";
        mutated = true;
      }
    }

    // Strip all legacy fields after delivery migration.
    if (stripLegacyTopLevelFields(raw)) {
      mutated = true;
    }
    if (payloadRecord && stripLegacyPayloadDeliveryFields(payloadRecord)) {
      mutated = true;
    }

    const isolation = raw.isolation;
    if (isolation && typeof isolation === "object" && !Array.isArray(isolation)) {
      delete raw.isolation;
      mutated = true;
    }

    const schedule = raw.schedule;
    if (schedule && typeof schedule === "object" && !Array.isArray(schedule)) {
      const sched = schedule as Record<string, unknown>;
      const kind = typeof sched.kind === "string" ? sched.kind.trim().toLowerCase() : "";
      if (!kind && ("at" in sched || "atMs" in sched)) {
        sched.kind = "at";
        mutated = true;
      }
      const atRaw = typeof sched.at === "string" ? sched.at.trim() : "";
      const atMsRaw = sched.atMs;
      const parsedAtMs =
        typeof atMsRaw === "number"
          ? atMsRaw
          : typeof atMsRaw === "string"
            ? parseAbsoluteTimeMs(atMsRaw)
            : atRaw
              ? parseAbsoluteTimeMs(atRaw)
              : null;
      if (parsedAtMs !== null) {
        sched.at = new Date(parsedAtMs).toISOString();
        if ("atMs" in sched) {
          delete sched.atMs;
        }
        mutated = true;
      }

      const everyMsRaw = sched.everyMs;
      const everyMs =
        typeof everyMsRaw === "number" && Number.isFinite(everyMsRaw)
          ? Math.floor(everyMsRaw)
          : null;
      if ((kind === "every" || sched.kind === "every") && everyMs !== null) {
        const anchorRaw = sched.anchorMs;
        const normalizedAnchor =
          typeof anchorRaw === "number" && Number.isFinite(anchorRaw)
            ? Math.max(0, Math.floor(anchorRaw))
            : typeof raw.createdAtMs === "number" && Number.isFinite(raw.createdAtMs)
              ? Math.max(0, Math.floor(raw.createdAtMs))
              : typeof raw.updatedAtMs === "number" && Number.isFinite(raw.updatedAtMs)
                ? Math.max(0, Math.floor(raw.updatedAtMs))
                : null;
        if (normalizedAnchor !== null && anchorRaw !== normalizedAnchor) {
          sched.anchorMs = normalizedAnchor;
          mutated = true;
        }
      }
    }
  }
  state.store = { version: 1, jobs: jobs as unknown as CronJob[] };
  state.storeLoadedAtMs = state.deps.nowMs();
  state.storeFileMtimeMs = fileMtimeMs;

  if (!opts?.skipRecompute) {
    recomputeNextRuns(state);
  }

  if (mutated) {
    await persist(state);
  }
}

export function warnIfDisabled(state: CronServiceState, action: string) {
  if (state.deps.cronEnabled) {
    return;
  }
  if (state.warnedDisabled) {
    return;
  }
  state.warnedDisabled = true;
  state.deps.log.warn(
    { enabled: false, action, storePath: state.deps.storePath },
    "cron: scheduler disabled; jobs will not run automatically",
  );
}

export async function persist(state: CronServiceState) {
  if (!state.store) {
    return;
  }
  await saveCronStore(state.deps.storePath, state.store);
  state.storeFileMtimeMs = await getFileMtimeMs(state.deps.storePath);
}
