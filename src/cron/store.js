import JSON5 from "json5";
import fs from "node:fs";
import path from "node:path";
import { expandHomePrefix } from "../infra/home-dir.js";
import { CONFIG_DIR } from "../utils.js";
export const DEFAULT_CRON_DIR = path.join(CONFIG_DIR, "cron");
export const DEFAULT_CRON_STORE_PATH = path.join(DEFAULT_CRON_DIR, "jobs.json");
export function resolveCronStorePath(storePath) {
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw));
    }
    return path.resolve(raw);
  }
  return DEFAULT_CRON_STORE_PATH;
}
export async function loadCronStore(storePath) {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    let parsed;
    try {
      parsed = JSON5.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse cron store at ${storePath}: ${String(err)}`, {
        cause: err,
      });
    }
    const parsedRecord =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    const jobs = Array.isArray(parsedRecord.jobs) ? parsedRecord.jobs : [];
    return {
      version: 1,
      jobs: jobs.filter(Boolean),
    };
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { version: 1, jobs: [] };
    }
    throw err;
  }
}
export async function saveCronStore(storePath, store) {
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const json = JSON.stringify(store, null, 2);
  await fs.promises.writeFile(tmp, json, "utf-8");
  await fs.promises.rename(tmp, storePath);
  try {
    await fs.promises.copyFile(storePath, `${storePath}.bak`);
  } catch {
    // best-effort
  }
}
