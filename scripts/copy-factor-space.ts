#!/usr/bin/env tsx
/**
 * Copy factor-space.json to dist/evolver/assets/gep/ for bundled builds.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const src = path.join(projectRoot, "src", "memory", "factor-space.json");
const dest = path.join(projectRoot, "dist", "evolver", "assets", "gep", "factor-space.json");

if (!fs.existsSync(src)) {
  console.warn("[copy-factor-space] factor-space.json not found at", src);
  process.exit(0);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
console.log(`[copy-factor-space] Copied -> ${path.relative(projectRoot, dest)}`);
