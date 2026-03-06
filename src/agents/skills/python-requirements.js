/**
 * Scans skill directories for Python requirements and merges them.
 *
 * Sources (in priority order):
 * 1. `metadata.requires.pythonPackages` from SKILL.md frontmatter
 * 2. `requirements.txt` file in skill directory
 * 3. `pyproject.toml` `[project].dependencies` array
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
/**
 * Normalize a pip package name for deduplication.
 * PEP 503: lowercase, replace [-_.] with "-".
 */
function normalizePkgName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}
/** Extract package name from a pip requirement line (e.g. "requests>=2.31.0" → "requests"). */
function extractPkgName(req) {
  const match = req.match(/^([a-zA-Z0-9_.-]+)/);
  return match ? match[1] : req;
}
/** Parse a requirements.txt file, ignoring comments and blank lines. */
function parseRequirementsTxt(filePath) {
  if (!existsSync(filePath)) {
    return [];
  }
  const content = readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("-"));
}
/** Parse pyproject.toml dependencies (simple regex — no TOML parser needed). */
function parsePyprojectDeps(filePath) {
  if (!existsSync(filePath)) {
    return [];
  }
  const content = readFileSync(filePath, "utf-8");
  // Match dependencies = ["pkg>=1.0", "pkg2"]
  const match = content.match(/dependencies\s*=\s*\[([^\]]*)\]/s);
  if (!match) {
    return [];
  }
  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0);
}
/**
 * Collect and merge Python requirements from all skill entries and directories.
 * Returns deduplicated pip-format requirement lines.
 */
export function collectPythonRequirements(params) {
  const seen = new Map(); // normalized name → full requirement line
  const addReq = (req) => {
    const name = normalizePkgName(extractPkgName(req));
    if (!seen.has(name)) {
      seen.set(name, req);
    }
    // If already seen, keep the first (broader) constraint — don't override.
  };
  // 1. From skill metadata
  for (const entry of params.skillEntries) {
    const pkgs = entry.metadata?.requires?.pythonPackages;
    if (pkgs) {
      for (const pkg of pkgs) {
        addReq(pkg);
      }
    }
  }
  // 2. From skill directories
  for (const dir of params.skillDirs) {
    const reqTxt = path.join(dir, "requirements.txt");
    for (const req of parseRequirementsTxt(reqTxt)) {
      addReq(req);
    }
    const pyproject = path.join(dir, "pyproject.toml");
    for (const dep of parsePyprojectDeps(pyproject)) {
      addReq(dep);
    }
  }
  return [...seen.values()];
}
/**
 * Check if any skill entries require Python.
 */
export function hasPythonSkills(entries) {
  return entries.some((e) => {
    const bins = e.metadata?.requires?.bins;
    const pkgs = e.metadata?.requires?.pythonPackages;
    return (bins && bins.includes("python3")) || (pkgs && pkgs.length > 0);
  });
}
