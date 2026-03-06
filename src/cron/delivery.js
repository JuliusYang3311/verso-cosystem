function normalizeChannel(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}
function normalizeTo(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
export function resolveCronDeliveryPlan(job) {
  const payload = job.payload.kind === "agentTurn" ? job.payload : null;
  const delivery = job.delivery;
  const hasDelivery = delivery && typeof delivery === "object";
  const rawMode = hasDelivery ? delivery.mode : undefined;
  const normalizedMode = typeof rawMode === "string" ? rawMode.trim().toLowerCase() : rawMode;
  const mode =
    normalizedMode === "announce"
      ? "announce"
      : normalizedMode === "none"
        ? "none"
        : normalizedMode === "deliver"
          ? "announce"
          : undefined;
  const payloadChannel = normalizeChannel(payload?.channel);
  const payloadTo = normalizeTo(payload?.to);
  const deliveryChannel = normalizeChannel(delivery?.channel);
  const deliveryTo = normalizeTo(delivery?.to);
  const channel = deliveryChannel ?? payloadChannel ?? "last";
  const to = deliveryTo ?? payloadTo;
  if (hasDelivery) {
    const resolvedMode = mode ?? "announce";
    return {
      mode: resolvedMode,
      channel,
      to,
      source: "delivery",
      requested: resolvedMode === "announce",
    };
  }
  const legacyMode =
    payload?.deliver === true ? "explicit" : payload?.deliver === false ? "off" : "auto";
  const hasExplicitTarget = Boolean(to);
  const requested = legacyMode === "explicit" || (legacyMode === "auto" && hasExplicitTarget);
  return {
    mode: requested ? "announce" : "none",
    channel,
    to,
    source: "payload",
    requested,
  };
}
