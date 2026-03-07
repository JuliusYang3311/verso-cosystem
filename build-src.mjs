// build-src.mjs - Build script to compile src/ directory

import * as esbuild from "esbuild";
import { glob } from "glob";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Find all .ts files in src/ (excluding test files)
const entryPoints = await glob("src/**/*.ts", {
  cwd: __dirname,
  ignore: ["**/*.test.ts", "**/*.spec.ts"],
  absolute: true,
});

console.log(`Building ${entryPoints.length} files from src/...`);

await esbuild.build({
  entryPoints,
  outdir: join(__dirname, "dist"),
  outbase: join(__dirname, "src"),
  platform: "node",
  format: "esm",
  target: "node18",
  sourcemap: true,
  logLevel: "info",
  outExtension: { ".js": ".js" },
});

console.log("Build complete! Output in dist/");
