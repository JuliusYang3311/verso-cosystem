export function normalizeSlackSlashCommandName(raw) {
  return raw.replace(/^\/+/, "");
}
export function resolveSlackSlashCommandConfig(raw) {
  const normalizedName = normalizeSlackSlashCommandName(raw?.name?.trim() || "verso");
  const name = normalizedName || "verso";
  return {
    enabled: raw?.enabled === true,
    name,
    sessionPrefix: raw?.sessionPrefix?.trim() || "slack:slash",
    ephemeral: raw?.ephemeral !== false,
  };
}
export function buildSlackSlashCommandMatcher(name) {
  const normalized = normalizeSlackSlashCommandName(name);
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^/?${escaped}$`);
}
