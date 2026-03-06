#!/usr/bin/env npx tsx
/**
 * revert-memory.ts
 * Reverts all memory changes made by a specific chapter's patch.
 * Reads the pre-patch snapshot (patches/patch-NN.pre.json) and reverses:
 *   - characters.json: delete added, restore updated/deleted originals
 *   - world_bible.json: delete added keys, restore updated/deleted originals
 *   - plot_threads.json: delete added, restore updated/closed originals
 *   - timeline.jsonl: remove entries for the chapter
 *   - timeline_memory.sqlite: remove embeddings for the chapter
 *   - patches/patch-NN.json + patch-NN.pre.json: delete
 */

import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PROJECTS_DIR, loadJson, saveJson, memPath, timelineDbPath } from "./apply-patch.js";
import { loadJsonl } from "./context.js";
import { NovelMemoryStore } from "./novel-memory.js";

type AnyObj = Record<string, any>;

function patchesDir(project: string): string {
  return path.join(PROJECTS_DIR, project, "patches");
}

function padChapter(chapter: number): string {
  return String(chapter).padStart(2, "0");
}

export interface RevertResult {
  status: string;
  chapter: number;
  reverted: string[];
}

export async function revertChapterMemory(project: string, chapter: number): Promise<RevertResult> {
  const pad = padChapter(chapter);
  const prePath = path.join(patchesDir(project), `patch-${pad}.pre.json`);
  const patchPath = path.join(patchesDir(project), `patch-${pad}.json`);
  if (!fsSync.existsSync(prePath)) {
    throw new Error(`Pre-patch snapshot not found: ${prePath}`);
  }
  const pre: AnyObj = JSON.parse(fsSync.readFileSync(prePath, "utf-8"));
  const reverted: string[] = [];

  // --- Revert characters ---
  const charPath = memPath(project, "characters.json");
  const chars: AnyObj = loadJson(charPath, { characters: [] });
  const charList: AnyObj[] = chars.characters ?? [];

  // Delete characters that were added by the patch
  const addedNames = new Set<string>(pre.characters?.added_names ?? []);
  if (addedNames.size > 0) {
    chars.characters = charList.filter((c) => !addedNames.has(String(c.name ?? "").trim()));
    reverted.push(`characters: removed ${addedNames.size} added`);
  }

  // Restore updated originals
  for (const orig of (pre.characters?.updated_originals ?? []) as AnyObj[]) {
    const name = String(orig.name ?? "").trim();
    const idx = (chars.characters as AnyObj[]).findIndex(
      (c) => String(c.name ?? "").trim() === name,
    );
    if (idx >= 0) (chars.characters as AnyObj[])[idx] = orig;
    else (chars.characters as AnyObj[]).push(orig);
  }

  // Restore deleted originals
  for (const orig of (pre.characters?.deleted_originals ?? []) as AnyObj[]) {
    (chars.characters as AnyObj[]).push(orig);
  }
  if (
    (pre.characters?.updated_originals?.length ?? 0) +
      (pre.characters?.deleted_originals?.length ?? 0) >
    0
  ) {
    reverted.push("characters: restored originals");
  }
  saveJson(charPath, chars);

  // --- Revert world bible ---
  const worldPath = memPath(project, "world_bible.json");
  const world: AnyObj = loadJson(worldPath, { world: {}, protected_keys: [] });
  const worldData: AnyObj = world.world ?? {};

  // Delete added keys
  for (const key of Object.keys(pre.world_bible?.added_keys ?? {})) {
    delete worldData[key];
  }
  // Restore updated originals
  Object.assign(worldData, pre.world_bible?.updated_originals ?? {});
  // Restore deleted originals
  Object.assign(worldData, pre.world_bible?.deleted_originals ?? {});
  world.world = worldData;
  saveJson(worldPath, world);
  reverted.push("world_bible: reverted");
  // --- Revert plot threads ---
  const plotPath = memPath(project, "plot_threads.json");
  const plot: AnyObj = loadJson(plotPath, { threads: [] });
  let threads: AnyObj[] = plot.threads ?? [];

  // Delete added threads
  const addedIds = new Set<string>(pre.plot_threads?.added_ids ?? []);
  if (addedIds.size > 0) {
    threads = threads.filter((t) => !addedIds.has(t.thread_id));
  }

  // Restore updated originals
  for (const orig of (pre.plot_threads?.updated_originals ?? []) as AnyObj[]) {
    const idx = threads.findIndex((t) => t.thread_id === orig.thread_id);
    if (idx >= 0) threads[idx] = orig;
    else threads.push(orig);
  }

  // Restore closed originals (reopen)
  for (const orig of (pre.plot_threads?.closed_originals ?? []) as AnyObj[]) {
    const idx = threads.findIndex((t) => t.thread_id === orig.thread_id);
    if (idx >= 0) threads[idx] = orig;
    else threads.push(orig);
  }
  plot.threads = threads;
  saveJson(plotPath, plot);
  reverted.push("plot_threads: reverted");

  // --- Revert timeline.jsonl ---
  const tlPath = memPath(project, "timeline.jsonl");
  if (fsSync.existsSync(tlPath)) {
    const entries = loadJsonl(tlPath);
    const filtered = entries.filter((e: any) => e.chapter !== chapter);
    fsSync.writeFileSync(
      tlPath,
      filtered.map((e) => JSON.stringify(e)).join("\n") + (filtered.length ? "\n" : ""),
      "utf-8",
    );
    reverted.push(`timeline: removed ${entries.length - filtered.length} entries`);
  }

  // --- Revert timeline embeddings ---
  const tlDbFile = timelineDbPath(project);
  if (fsSync.existsSync(tlDbFile)) {
    try {
      const store = await NovelMemoryStore.open({ dbPath: tlDbFile, source: "timeline" });
      store.removePath(`timeline/chapter-${pad}`);
      store.close();
      reverted.push("timeline_embeddings: cleared");
    } catch (err) {
      console.error(`Warning: timeline embedding cleanup failed: ${String(err)}`);
    }
  }

  // --- Delete patch files ---
  if (fsSync.existsSync(patchPath)) fsSync.unlinkSync(patchPath);
  if (fsSync.existsSync(prePath)) fsSync.unlinkSync(prePath);
  reverted.push("patch_files: deleted");

  return { status: "ok", chapter, reverted };
}

// CLI entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      chapter: { type: "string" },
    },
    strict: true,
  });
  if (!values.project || !values.chapter) {
    console.error("--project and --chapter are required");
    process.exit(1);
  }
  revertChapterMemory(values.project, parseInt(values.chapter, 10))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
