import { defineConfig } from "tsdown";

const env = {
  NODE_ENV: "production",
};

export default defineConfig([
  {
    entry: "src/index.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/entry.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/infra/warning-filter.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/plugin-sdk/index.ts",
    outDir: "dist/plugin-sdk",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/extensionAPI.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: ["src/hooks/bundled/*/handler.ts", "src/hooks/llm-slug-generator.ts"],
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: [
      "src/evolver/daemon-entry.ts",
      "src/evolver/sandbox-agent.ts",
      "src/evolver/evolve.ts",
      "src/evolver/evolver-review.ts",
      "src/evolver/gep/sandbox-runner.ts",
      "src/evolver/gep/solidify.ts",
    ],
    outDir: "dist/evolver",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: ["src/orchestration/daemon-entry.ts"],
    outDir: "dist/orchestration",
    env,
    fixedExtension: false,
    platform: "node",
  },
  // Pi-extensions are loaded at runtime by jiti via DefaultResourceLoader.
  // They MUST be separate .js files — not bundled into the main chunk — so that
  // jiti can find and load them independently.
  {
    entry: [
      "src/agents/pi-extensions/dynamic-context.ts",
      "src/agents/pi-extensions/context-pruning.ts",
      "src/agents/pi-extensions/compaction-safeguard.ts",
    ],
    outDir: "dist/pi-extensions",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: [
      "skills/novel-writer/ts/write-chapter.ts",
      "skills/novel-writer/ts/context.ts",
      "skills/novel-writer/ts/extract-updates.ts",
      "skills/novel-writer/ts/validate-patch.ts",
      "skills/novel-writer/ts/apply-patch.ts",
      "skills/novel-writer/ts/revert-memory.ts",
      "skills/novel-writer/ts/ingest-style.ts",
      "skills/novel-writer/ts/ingest-timeline.ts",
      "skills/novel-writer/ts/search.ts",
      "skills/novel-writer/ts/status.ts",
    ],
    outDir: "dist/skills/novel-writer",
    env,
    fixedExtension: false,
    platform: "node",
  },
]);
