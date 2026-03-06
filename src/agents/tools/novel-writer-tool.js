/**
 * novel-writer-tool.ts
 * Tool-dispatch entry point for the novel-writer skill.
 * Spawns write-chapter.js in the background, returns immediately,
 * and delivers the result back to the calling session when done.
 */
import { execFile } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";
import { logVerbose } from "../../globals.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { jsonResult } from "./common.js";
const NovelWriterSchema = {
  type: "object",
  properties: {
    command: { type: "string", description: "Raw command arguments" },
  },
  required: ["command"],
};
// Resolve repo root by walking up from import.meta.dirname to find package.json,
// then locate the compiled script under dist/skills/novel-writer/.
function findRepoRoot() {
  let dir = import.meta.dirname;
  for (let i = 0; i < 10; i++) {
    if (fsSync.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return process.cwd();
}
const SCRIPT_PATH = path.join(findRepoRoot(), "dist", "skills", "novel-writer", "write-chapter.js");
function parseArgs(raw) {
  const args = [];
  const re = /--(\S+)\s+(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    args.push(`--${m[1]}`, m[2] ?? m[3] ?? m[4]);
  }
  // Handle bare flags like --rewrite
  const flagRe = /--(\S+)(?=\s+--|$)/g;
  while ((m = flagRe.exec(raw)) !== null) {
    if (!args.includes(`--${m[1]}`)) {
      args.push(`--${m[1]}`);
    }
  }
  return args;
}
function runScript(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "node",
      [SCRIPT_PATH, ...args],
      { timeout: 1_200_000, maxBuffer: 50 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}
function formatResult(json) {
  const parts = [];
  if (json.rewritten) {
    parts.push("Rewrite complete");
  } else {
    parts.push("Chapter written");
  }
  if (typeof json.summary === "string") {
    parts.push(`Summary: ${json.summary}`);
  }
  if (typeof json.chapterPath === "string") {
    parts.push(`File: ${json.chapterPath}`);
  }
  if (typeof json.wordCount === "number") {
    parts.push(`Words: ${json.wordCount}`);
  }
  const mem = json.memoryUpdated;
  if (mem?.length) {
    parts.push(`Memory updated: ${mem.join(", ")}`);
  }
  return parts.join("\n");
}
export function createNovelWriterTool(options) {
  const cfg = options?.config;
  const channel = options?.agentChannel;
  const to = options?.agentTo;
  const threadId = options?.agentThreadId;
  return {
    label: "NovelWriter",
    name: "novel_writer",
    description:
      "Autonomous novel-writing engine. Write or rewrite chapters with full memory management. " +
      "Args: --project <name> --outline <text> [--title <title>] [--style <style>] [--budget <n>] " +
      "[--rewrite --chapter <n> --notes <text>]",
    parameters: NovelWriterSchema,
    execute: async (_toolCallId, input) => {
      const params = input;
      const raw = (params.command ?? "").trim();
      if (!raw) {
        return jsonResult({ error: "Missing command arguments" });
      }
      const args = parseArgs(raw);
      const isRewrite = args.includes("--rewrite");
      // Fire-and-forget: spawn script, deliver result when done
      runScript(args)
        .then(({ stdout, stderr }) => {
          if (stderr?.trim()) {
            logVerbose(`[novel-writer] stderr: ${stderr.trim()}`);
          }
          const json = JSON.parse(stdout);
          const text = formatResult(json);
          if (cfg && channel && channel !== "none" && to) {
            void deliverOutboundPayloads({ cfg, channel, to, threadId, payloads: [{ text }] });
          } else {
            logVerbose(`[novel-writer] No delivery channel, result: ${text}`);
          }
        })
        .catch((err) => {
          const errText = `Write failed: ${err instanceof Error ? err.message : String(err)}`;
          if (cfg && channel && channel !== "none" && to) {
            void deliverOutboundPayloads({
              cfg,
              channel,
              to,
              threadId,
              payloads: [{ text: errText }],
            });
          } else {
            logVerbose(`[novel-writer] ${errText}`);
          }
        });
      const ack = isRewrite ? "Rewriting chapter..." : "Writing new chapter...";
      return jsonResult({ status: "started", message: ack });
    },
  };
}
