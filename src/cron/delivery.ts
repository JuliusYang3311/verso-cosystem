import type { CronDeliveryMode, CronJob, CronMessageChannel } from "./types.js";

export type CronDeliveryPlan = {
  mode: CronDeliveryMode;
  channel: CronMessageChannel;
  to?: string;
  requested: boolean;
};

export function resolveCronDeliveryPlan(job: CronJob): CronDeliveryPlan {
  const delivery = job.delivery;
  if (!delivery) {
    return { mode: "none", channel: "last", requested: false };
  }

  const mode = delivery.mode === "announce" ? "announce" : "none";
  const channel = delivery.channel ?? "last";
  const to = delivery.to;

  return {
    mode,
    channel,
    to,
    requested: mode === "announce",
  };
}
