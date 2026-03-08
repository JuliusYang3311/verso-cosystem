#!/usr/bin/env tsx
/**
 * Copy evolver assets to dist so they are available in packaged builds.
 *
 * Layout:
 *   src/evolver/assets/context_params.json  →  dist/evolver/assets/context_params.json
 *   src/evolver/assets/gep/capsules.json    →  dist/evolver/assets/gep/capsules.json
 *   (etc.)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// Copy shared evolver assets (context_params.json etc.)
const sharedSrcDir = path.join(projectRoot, "src", "evolver", "assets");
const sharedDestDir = path.join(projectRoot, "dist", "evolver", "assets");

if (fs.existsSync(sharedSrcDir)) {
  fs.mkdirSync(sharedDestDir, { recursive: true });
  for (const file of fs.readdirSync(sharedSrcDir)) {
    const srcFile = path.join(sharedSrcDir, file);
    if (!fs.statSync(srcFile).isFile()) continue;
    const destFile = path.join(sharedDestDir, file);
    fs.copyFileSync(srcFile, destFile);
    console.log(
      `[copy-evolver-assets] Copied ${path.relative(projectRoot, srcFile)} -> ${path.relative(projectRoot, destFile)}`,
    );
  }
}

// Copy GEP-specific assets (capsules.json, genes.json, etc.)
const gepSrcDir = path.join(sharedSrcDir, "gep");
const gepDestDir = path.join(sharedDestDir, "gep");

if (fs.existsSync(gepSrcDir)) {
  fs.mkdirSync(gepDestDir, { recursive: true });
  for (const file of fs.readdirSync(gepSrcDir)) {
    const srcFile = path.join(gepSrcDir, file);
    if (!fs.statSync(srcFile).isFile()) continue;
    const destFile = path.join(gepDestDir, file);
    fs.copyFileSync(srcFile, destFile);
    console.log(
      `[copy-evolver-assets] Copied ${path.relative(projectRoot, srcFile)} -> ${path.relative(projectRoot, destFile)}`,
    );
  }
} else {
  console.warn(`[copy-evolver-assets] GEP source dir not found: ${gepSrcDir}`);
}
