#!/usr/bin/env tsx
/**
 * Copy evolver assets (context_params.json etc.) to dist so they are
 * available in packaged (DMG) builds where source tree is absent.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const assets = [
  {
    src: path.join(projectRoot, "src", "evolver", "assets", "gep", "context_params.json"),
    dest: path.join(projectRoot, "dist", "evolver", "assets", "gep", "context_params.json"),
  },
];

for (const { src, dest } of assets) {
  if (!fs.existsSync(src)) {
    console.warn(`[copy-evolver-assets] Not found: ${src}`);
    continue;
  }
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  fs.copyFileSync(src, dest);
  console.log(
    `[copy-evolver-assets] Copied ${path.relative(projectRoot, src)} -> ${path.relative(projectRoot, dest)}`,
  );
}
