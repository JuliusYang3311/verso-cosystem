#!/usr/bin/env tsx
/**
 * Copy evolver assets (context_params.json, capsules.json, genes.json etc.)
 * to dist so they are available in packaged (DMG) builds where source tree
 * is absent.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const srcDir = path.join(projectRoot, "src", "evolver", "assets", "gep");
const destDir = path.join(projectRoot, "dist", "evolver", "assets", "gep");

if (!fs.existsSync(srcDir)) {
  console.warn(`[copy-evolver-assets] Source dir not found: ${srcDir}`);
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });

for (const file of fs.readdirSync(srcDir)) {
  const srcFile = path.join(srcDir, file);
  if (!fs.statSync(srcFile).isFile()) continue;
  const destFile = path.join(destDir, file);
  fs.copyFileSync(srcFile, destFile);
  console.log(
    `[copy-evolver-assets] Copied ${path.relative(projectRoot, srcFile)} -> ${path.relative(projectRoot, destFile)}`,
  );
}
