#!/usr/bin/env npx tsx
/**
 * apply-patch.ts
 * Safe merge + validation + rollback for 4-layer continuity memory.
 * After applying the patch, automatically re-indexes the new timeline
 * entry into the per-project timeline memory DB (verso-backed).
 *
 * Replaces scripts/apply_patch.py.
 *
 * Usage:
 *   npx tsx skills/novel-writer/ts/apply-patch.ts \
 *     --project mynovel --patch patch.json --chapter 8 --title "回响"
 */

import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { NovelMemoryStore } from "./novel-memory.js";

// ---------------------------------------------------------------------------
// Path resolution: projects → user workspace, style DB → state dir
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  return p.startsWith("~/") || p === "~" ? path.join(os.homedir(), p.slice(2)) : p;
}

function resolveVersoStateDir(): string {
  const override = process.env.VERSO_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  return override ? expandHome(override) : path.join(os.homedir(), ".verso");
}

function resolveNovelPaths(): { projectsDir: string; styleDbPath: string } {
  const stateDir = resolveVersoStateDir();

  // Read workspace from verso config (agents.defaults.workspace)
  let workspaceDir: string | undefined;
  try {
    const configPath = process.env.VERSO_CONFIG_PATH?.trim() || path.join(stateDir, "verso.json");
    const raw = fsSync.readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const ws = (cfg?.agents as Record<string, unknown> | undefined)?.defaults as
      | Record<string, unknown>
      | undefined;
    const rawWs = (ws?.workspace as string | undefined)?.trim();
    if (rawWs) workspaceDir = expandHome(rawWs);
  } catch {
    // config missing or unreadable — fall back to default workspace
  }

  const effectiveWorkspace = workspaceDir ?? path.join(stateDir, "workspace");
  const novelRoot = path.join(effectiveWorkspace, "novel-writer");
  return {
    projectsDir: path.join(novelRoot, "projects"),
    styleDbPath: path.join(novelRoot, "style", "style_memory.sqlite"),
  };
}

const { projectsDir, styleDbPath } = resolveNovelPaths();
export const PROJECTS_DIR = projectsDir;
export const STYLE_DB_PATH = styleDbPath;

// Log resolved paths once at startup for diagnostics
console.error(`[novel-writer] PROJECTS_DIR=${PROJECTS_DIR}`);

// --- Helpers ---

export function projectDir(project: string): string {
  const dir = path.join(PROJECTS_DIR, project);
  fsSync.mkdirSync(path.join(dir, "memory"), { recursive: true });
  fsSync.mkdirSync(path.join(dir, "chapters"), { recursive: true });
  return dir;
}

export function memPath(project: string, file: string): string {
  return path.join(PROJECTS_DIR, project, "memory", file);
}

export function timelineDbPath(project: string): string {
  return path.join(PROJECTS_DIR, project, "timeline_memory.sqlite");
}

export function loadJson(filePath: string, fallback: unknown): any {
  if (!fsSync.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fsSync.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

export function saveJson(filePath: string, data: unknown): void {
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  fsSync.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function appendJsonl(filePath: string, data: unknown): void {
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  fsSync.appendFileSync(filePath, JSON.stringify(data) + "\n", "utf-8");
}

export function nowTs(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

type AnyObj = Record<string, any>;

function byName(items: AnyObj[]): Map<string, AnyObj> {
  const map = new Map<string, AnyObj>();
  for (const item of items) {
    const name = String(item.name ?? "").trim();
    if (name) map.set(name, item);
  }
  return map;
}

function mergeItem(base: AnyObj, patch: AnyObj): AnyObj {
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "name") continue;
    merged[key] = value;
  }
  return merged;
}

// --- Patch application ---

export function applyCharacterPatch(characters: AnyObj, patch: AnyObj): AnyObj {
  const items: AnyObj[] = characters.characters ?? [];
  const existing = byName(items);

  for (const item of (patch.add ?? []) as AnyObj[]) {
    const name = String(item.name ?? "").trim();
    if (!name) continue;
    existing.set(name, existing.has(name) ? mergeItem(existing.get(name)!, item) : item);
  }

  for (const item of (patch.update ?? []) as AnyObj[]) {
    const name = String(item.name ?? "").trim();
    if (!name) continue;
    existing.set(name, existing.has(name) ? mergeItem(existing.get(name)!, item) : item);
  }

  const protectedNames = new Set<string>();
  for (const [n, v] of existing) {
    if (v.protected === true) protectedNames.add(n);
  }

  const toDelete = new Set<string>();
  for (const item of (patch.delete ?? []) as any[]) {
    const name = String(typeof item === "object" ? (item?.name ?? item) : item).trim();
    if (name && !protectedNames.has(name)) toDelete.add(name);
  }

  // Guardrail: major character shrink protection
  const majorsBefore = [...existing.values()].filter((v) => v.role === "main" || v.protected);
  const remaining = new Map<string, AnyObj>();
  for (const [n, v] of existing) {
    if (!toDelete.has(n)) remaining.set(n, v);
  }
  const majorsAfter = [...remaining.values()].filter((v) => v.role === "main" || v.protected);
  if (
    majorsBefore.length > 0 &&
    majorsAfter.length < Math.max(1, Math.floor(majorsBefore.length * 0.7))
  ) {
    throw new Error("character shrink validation failed (major characters drop)");
  }

  return { characters: [...remaining.values()] };
}

export function applyWorldPatch(world: AnyObj, patch: AnyObj): AnyObj {
  const data: AnyObj = { ...world.world };
  const protectedKeys = new Set<string>(world.protected_keys ?? []);

  const add = patch.add ?? {};
  if (typeof add === "object" && !Array.isArray(add)) {
    Object.assign(data, add);
  } else if (Array.isArray(add)) {
    for (const item of add) {
      if (typeof item === "object") Object.assign(data, item);
    }
  }

  const update = patch.update ?? {};
  if (typeof update === "object" && !Array.isArray(update)) {
    Object.assign(data, update);
  } else if (Array.isArray(update)) {
    for (const item of update) {
      if (typeof item === "object") Object.assign(data, item);
    }
  }

  for (const key of (patch.delete ?? []) as string[]) {
    if (typeof key === "string" && key in data && !protectedKeys.has(key)) {
      delete data[key];
    }
  }

  return { world: data, protected_keys: world.protected_keys ?? [] };
}

export function applyPlotPatch(plot: AnyObj, patch: AnyObj): AnyObj {
  const threads: AnyObj[] = plot.threads ?? [];
  const byId = new Map<string, AnyObj>();
  for (const t of threads) {
    if (t.thread_id) byId.set(t.thread_id, t);
  }

  // LLM patches may use "id" instead of "thread_id" — normalize both
  const tid = (item: AnyObj): string | undefined => item.thread_id ?? item.id ?? undefined;

  for (const item of (patch.add ?? []) as AnyObj[]) {
    const id = tid(item);
    if (!id) continue;
    const normalized: AnyObj = { ...item, thread_id: id };
    delete normalized.id;
    byId.set(id, normalized);
  }

  for (const item of (patch.update ?? []) as AnyObj[]) {
    const id = tid(item);
    if (!id) continue;
    const base = byId.get(id) ?? {};
    const normalized: AnyObj = { ...base, ...item, thread_id: id };
    delete normalized.id;
    byId.set(id, normalized);
  }

  for (const item of (patch.close ?? []) as any[]) {
    const id = typeof item === "object" ? (item?.thread_id ?? item?.id) : item;
    if (!id) continue;
    const base = byId.get(id) ?? { thread_id: id };
    base.status = "closed";
    byId.set(id, base);
  }

  return { threads: [...byId.values()] };
}

// --- Pre-patch snapshot for revert support ---

export function buildPrePatchSnapshot(
  chapter: number,
  charBackup: AnyObj,
  worldBackup: AnyObj,
  plotBackup: AnyObj,
  patchData: AnyObj,
): AnyObj {
  const snapshot: AnyObj = { chapter };

  // Characters: track what's being added/updated/deleted
  const charPatch = patchData.characters ?? {};
  const existingChars = byName(charBackup.characters ?? []);
  snapshot.characters = {
    added_names: ((charPatch.add ?? []) as AnyObj[])
      .map((c) => String(c.name ?? "").trim())
      .filter((n) => n && !existingChars.has(n)),
    updated_originals: ((charPatch.update ?? []) as AnyObj[])
      .map((c) => existingChars.get(String(c.name ?? "").trim()))
      .filter(Boolean),
    deleted_originals: ((charPatch.delete ?? []) as any[])
      .map((c) => existingChars.get(String(typeof c === "object" ? (c?.name ?? c) : c).trim()))
      .filter(Boolean),
  };

  // World bible: track added/updated/deleted keys
  const worldPatch = patchData.world_bible ?? {};
  const worldData = worldBackup.world ?? {};
  const wAdded: AnyObj = {};
  const wUpdated: AnyObj = {};
  const wDeleted: AnyObj = {};
  const addW = worldPatch.add ?? {};
  if (typeof addW === "object" && !Array.isArray(addW)) {
    for (const [k, v] of Object.entries(addW)) {
      if (!(k in worldData)) wAdded[k] = v;
      else wUpdated[k] = worldData[k];
    }
  }
  const updateW = worldPatch.update ?? {};
  if (typeof updateW === "object" && !Array.isArray(updateW)) {
    for (const [k] of Object.entries(updateW)) {
      if (k in worldData && !(k in wUpdated)) wUpdated[k] = worldData[k];
    }
  }
  for (const key of (worldPatch.delete ?? []) as string[]) {
    if (typeof key === "string" && key in worldData) wDeleted[key] = worldData[key];
  }
  snapshot.world_bible = {
    added_keys: wAdded,
    updated_originals: wUpdated,
    deleted_originals: wDeleted,
  };

  // Plot threads: track added/updated/closed
  const plotPatch = patchData.plot_threads ?? {};
  const existingThreads = new Map<string, AnyObj>();
  for (const t of (plotBackup.threads ?? []) as AnyObj[]) {
    if (t.thread_id) existingThreads.set(t.thread_id, t);
  }
  snapshot.plot_threads = {
    added_ids: ((plotPatch.add ?? []) as AnyObj[])
      .map((t) => t.thread_id ?? t.id)
      .filter((id: string) => id && !existingThreads.has(id)),
    updated_originals: ((plotPatch.update ?? []) as AnyObj[])
      .map((t) => existingThreads.get(t.thread_id ?? t.id))
      .filter(Boolean),
    closed_originals: ((plotPatch.close ?? []) as any[])
      .map((t) => existingThreads.get(typeof t === "object" ? (t?.thread_id ?? t?.id) : t))
      .filter(Boolean),
  };

  return snapshot;
}

// --- Exported API ---

export interface ApplyPatchOpts {
  project: string;
  patch: Record<string, any>;
  chapter: number;
  title: string;
  summary?: string;
}

export interface ApplyResult {
  status: string;
  state: Record<string, any>;
}

export async function applyPatch(opts: ApplyPatchOpts): Promise<ApplyResult> {
  const { project, chapter, title, summary = "" } = opts;
  const patchData = opts.patch as AnyObj;
  console.error(
    `[applyPatch] chapter=${chapter} title=${title} patchKeys=${Object.keys(patchData).join(",")}`,
  );
  const pDir = projectDir(project);

  // --- Backup current state ---
  const charPath = memPath(project, "characters.json");
  const worldPath = memPath(project, "world_bible.json");
  const plotPath = memPath(project, "plot_threads.json");
  const timelinePath = memPath(project, "timeline.jsonl");

  const charBackup = loadJson(charPath, { characters: [] });
  const worldBackup = loadJson(worldPath, { world: {}, protected_keys: [] });
  const plotBackup = loadJson(plotPath, { threads: [] });

  // --- Save pre-patch snapshot for revert support ---
  const patchesDir = path.join(pDir, "patches");
  fsSync.mkdirSync(patchesDir, { recursive: true });
  const padChapter = String(chapter).padStart(2, "0");
  const preSnapshot = buildPrePatchSnapshot(
    chapter,
    charBackup,
    worldBackup,
    plotBackup,
    patchData,
  );
  saveJson(path.join(patchesDir, `patch-${padChapter}.pre.json`), preSnapshot);

  try {
    // --- Apply patches ---
    const newChars = applyCharacterPatch(charBackup, patchData.characters ?? {});
    const newWorld = applyWorldPatch(worldBackup, patchData.world_bible ?? {});
    const newPlot = applyPlotPatch(plotBackup, patchData.plot_threads ?? {});

    saveJson(charPath, newChars);
    saveJson(worldPath, newWorld);
    saveJson(plotPath, newPlot);
    console.error(`[applyPatch] characters/world/plot saved`);

    // --- Append timeline entry ---
    const tlPatch = patchData.timeline ?? {};
    const timelineEntry: AnyObj = {
      chapter,
      title,
      summary: tlPatch.summary || summary || "",
      events: tlPatch.events ?? [],
      consequences: tlPatch.consequences ?? [],
      pov: tlPatch.pov ?? "",
      locations: tlPatch.locations ?? [],
      characters: tlPatch.characters ?? [],
      updated_at: nowTs(),
    };
    appendJsonl(timelinePath, timelineEntry);
    console.error(`[applyPatch] timeline entry appended`);

    // --- Auto-index timeline entry into verso memory DB ---
    try {
      const store = await NovelMemoryStore.open({
        dbPath: timelineDbPath(project),
        source: "timeline",
      });

      // Build markdown for the new entry
      const parts: string[] = [];
      let heading = `## Chapter ${chapter}`;
      if (title) heading += ` — ${title}`;
      parts.push(heading);
      if (timelineEntry.pov) parts.push(`POV: ${timelineEntry.pov}`);
      if (timelineEntry.locations?.length)
        parts.push(`Locations: ${timelineEntry.locations.join(", ")}`);
      if (timelineEntry.characters?.length)
        parts.push(`Characters: ${timelineEntry.characters.join(", ")}`);
      parts.push("");
      if (timelineEntry.summary) parts.push(timelineEntry.summary);
      if (timelineEntry.events?.length)
        parts.push("", `Events: ${timelineEntry.events.join("; ")}`);
      if (timelineEntry.consequences?.length)
        parts.push(`Consequences: ${timelineEntry.consequences.join("; ")}`);

      const markdown = parts.join("\n");

      // Use chapter-based path for revert support
      const virtualPath = `timeline/chapter-${padChapter}`;

      await store.indexContent({ virtualPath, content: markdown });
      store.close();

      console.error(`Timeline entry indexed: ${virtualPath}`);
    } catch (err) {
      console.error(`Warning: timeline auto-index failed: ${String(err)}`);
      // Non-fatal — JSON memory is already saved
    }

    // --- Update state.json ---
    const statePath = path.join(pDir, "state.json");
    const state: AnyObj = loadJson(statePath, {});
    const written: AnyObj[] = Array.isArray(state.chapters_written) ? state.chapters_written : [];
    const existingEntries = new Set(written.map((w) => `${w.chapter}:${w.title}`));
    if (!existingEntries.has(`${chapter}:${title}`)) {
      written.push({ chapter, title });
    }
    state.last_chapter = chapter;
    state.last_title = title;
    state.updated_at = nowTs();
    state.chapters_written = written;
    saveJson(statePath, state);
    console.error(`[applyPatch] state.json updated, last_chapter=${chapter}`);
    // --- Archive patch ---
    saveJson(path.join(patchesDir, `patch-${padChapter}.json`), patchData);

    return { status: "ok", state };
  } catch (err) {
    // --- Rollback on failure ---
    console.error(`Patch failed, rolling back: ${String(err)}`);
    saveJson(charPath, charBackup);
    saveJson(worldPath, worldBackup);
    saveJson(plotPath, plotBackup);
    throw err;
  }
}

// CLI entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      patch: { type: "string" },
      chapter: { type: "string" },
      title: { type: "string" },
      summary: { type: "string", default: "" },
    },
    strict: true,
  });
  if (!values.project || !values.patch || !values.chapter || !values.title) {
    console.error("--project, --patch, --chapter, --title are all required");
    process.exit(1);
  }
  if (!fsSync.existsSync(values.patch)) {
    console.error(`patch file not found: ${values.patch}`);
    process.exit(1);
  }
  const patchData = JSON.parse(fsSync.readFileSync(values.patch, "utf-8"));
  applyPatch({
    project: values.project,
    patch: patchData,
    chapter: parseInt(values.chapter, 10),
    title: values.title,
    summary: values.summary,
  })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
