import { createRequire } from "node:module";
const CORE_PACKAGE_NAME = "openclaw";
const PACKAGE_JSON_CANDIDATES = [
  "../package.json",
  "../../package.json",
  "../../../package.json",
  "./package.json",
];
const BUILD_INFO_CANDIDATES = ["../build-info.json", "../../build-info.json", "./build-info.json"];
function readVersionFromJsonCandidates(moduleUrl, candidates, opts = {}) {
  try {
    const require = createRequire(moduleUrl);
    for (const candidate of candidates) {
      try {
        const parsed = require(candidate);
        const version = parsed.version?.trim();
        if (!version) {
          continue;
        }
        if (opts.requirePackageName && parsed.name !== CORE_PACKAGE_NAME) {
          continue;
        }
        return version;
      } catch {
        // ignore missing or unreadable candidate
      }
    }
    return null;
  } catch {
    return null;
  }
}
export function readVersionFromPackageJsonForModuleUrl(moduleUrl) {
  return readVersionFromJsonCandidates(moduleUrl, PACKAGE_JSON_CANDIDATES, {
    requirePackageName: true,
  });
}
export function readVersionFromBuildInfoForModuleUrl(moduleUrl) {
  return readVersionFromJsonCandidates(moduleUrl, BUILD_INFO_CANDIDATES);
}
export function resolveVersionFromModuleUrl(moduleUrl) {
  return (
    readVersionFromPackageJsonForModuleUrl(moduleUrl) ||
    readVersionFromBuildInfoForModuleUrl(moduleUrl)
  );
}
// Single source of truth for the current Verso version.
// - Embedded/bundled builds: injected define or env var.
// - Dev/npm builds: package.json.
export const VERSION =
  (typeof __OPENCLAW_VERSION__ === "string" && __OPENCLAW_VERSION__) ||
  process.env.OPENCLAW_BUNDLED_VERSION ||
  resolveVersionFromModuleUrl(import.meta.url) ||
  "0.0.0";
