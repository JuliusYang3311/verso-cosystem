import { Type } from "@sinclair/typebox";
import type { VersoConfig } from "../../config/config.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import type { MemorySearchManager, MemorySearchResult } from "../../memory/types.js";
import type { AnyAgentTool } from "./common.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const MemorySearchSchema = Type.Object({
  query: Type.String(),

  minScore: Type.Optional(Type.Number()),
});

const MemoryGetSchema = Type.Object({
  chunkId: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
});

export function createMemorySearchTool(options: {
  config?: VersoConfig;
  agentSessionKey?: string;
  /** Pre-resolved manager — bypasses config resolution. Used by orchestrator workers. */
  memoryManager?: MemorySearchManager;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg && !options.memoryManager) {
    return null;
  }
  const agentId = cfg
    ? resolveSessionAgentId({ sessionKey: options.agentSessionKey, config: cfg })
    : "";
  if (!options.memoryManager && cfg && !resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  const resolveManager = async () => {
    if (options.memoryManager)
      return { manager: options.memoryManager as MemorySearchManager | null, error: undefined };
    return getMemorySearchManager({ cfg: cfg!, agentId });
  };
  return {
    label: "Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall step: semantically search memory (MEMORY.md, memory/*.md, session transcripts). Returns L1 summaries (key sentences) with chunk IDs. Use memory_get with the chunk ID to read the full L2 text when you need details.",
    parameters: MemorySearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const minScore = readNumberParam(params, "minScore");
      const { manager, error } = await resolveManager();
      if (!manager) {
        return jsonResult({ results: [], disabled: true, error });
      }
      try {
        const citationsMode = cfg
          ? resolveMemoryCitationsMode(cfg)
          : ("off" as MemoryCitationsMode);
        const includeCitations = shouldIncludeCitations({
          mode: citationsMode,
          sessionKey: options.agentSessionKey,
        });
        const rawResults = await manager.search(query, {
          minScore,
          sessionKey: options.agentSessionKey,
        });
        const decorated = decorateCitations(rawResults, includeCitations);
        const forLlm = decorated.map(({ l1Sentences: _l1, l0Tags: _l0, ...rest }) => rest);
        return jsonResult({
          results: forLlm,
          provider: manager.status().provider,
          model: manager.status().model,
          fallback: manager.status().fallback,
          citations: citationsMode,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ results: [], disabled: true, error: message });
      }
    },
  };
}

export function createMemoryGetTool(options: {
  config?: VersoConfig;
  agentSessionKey?: string;
  /** Pre-resolved manager — bypasses config resolution. Used by orchestrator workers. */
  memoryManager?: MemorySearchManager;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg && !options.memoryManager) {
    return null;
  }
  const agentId = cfg
    ? resolveSessionAgentId({ sessionKey: options.agentSessionKey, config: cfg })
    : "";
  if (!options.memoryManager && cfg && !resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  const resolveManager = async () => {
    if (options.memoryManager)
      return { manager: options.memoryManager as MemorySearchManager | null, error: undefined };
    return getMemorySearchManager({ cfg: cfg!, agentId });
  };
  return {
    label: "Memory Get",
    name: "memory_get",
    description:
      "Read L2 full chunk text by chunk ID (from memory_search results), or read a memory file by path. Use after memory_search to get full details.",
    parameters: MemoryGetSchema,
    execute: async (_toolCallId, params) => {
      const chunkId = readStringParam(params, "chunkId");
      const relPath = readStringParam(params, "path");
      const from = readNumberParam(params, "from", { integer: true });
      const lines = readNumberParam(params, "lines", { integer: true });
      const { manager, error } = await resolveManager();
      if (!manager) {
        return jsonResult({ text: "", disabled: true, error });
      }
      try {
        // Prefer chunk ID lookup (L2 from SQL)
        if (chunkId) {
          const chunk = await manager.readChunk(chunkId);
          if (!chunk) {
            return jsonResult({ text: "", error: `chunk not found: ${chunkId}` });
          }
          return jsonResult(chunk);
        }
        // Fallback to file path read
        if (!relPath) {
          return jsonResult({ text: "", error: "chunkId or path required" });
        }
        const result = await manager.readFile({
          relPath,
          from: from ?? undefined,
          lines: lines ?? undefined,
        });
        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ path: relPath, text: "", disabled: true, error: message });
      }
    },
  };
}

function resolveMemoryCitationsMode(cfg: VersoConfig): MemoryCitationsMode {
  const mode = cfg.memory?.citations;
  if (mode === "on" || mode === "off" || mode === "auto") {
    return mode;
  }
  return "auto";
}

function decorateCitations(results: MemorySearchResult[], include: boolean): MemorySearchResult[] {
  if (!include) {
    return results.map((entry) => ({ ...entry, citation: undefined }));
  }
  return results.map((entry) => {
    const citation = formatCitation(entry);
    const snippet = `${entry.snippet.trim()}\n\nSource: ${citation}`;
    return { ...entry, citation, snippet };
  });
}

function formatCitation(entry: MemorySearchResult): string {
  const lineRange =
    entry.startLine === entry.endLine
      ? `#L${entry.startLine}`
      : `#L${entry.startLine}-L${entry.endLine}`;
  return `${entry.path}${lineRange}`;
}

function shouldIncludeCitations(params: {
  mode: MemoryCitationsMode;
  sessionKey?: string;
}): boolean {
  if (params.mode === "on") {
    return true;
  }
  if (params.mode === "off") {
    return false;
  }
  // auto: show citations in direct chats; suppress in groups/channels by default.
  const chatType = deriveChatTypeFromSessionKey(params.sessionKey);
  return chatType === "direct";
}

function deriveChatTypeFromSessionKey(sessionKey?: string): "direct" | "group" | "channel" {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return "direct";
  }
  const tokens = new Set(parsed.rest.toLowerCase().split(":").filter(Boolean));
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("group")) {
    return "group";
  }
  return "direct";
}
