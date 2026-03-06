/**
 * manager-session-files.ts
 * Session file reading, parsing, and delta tracking for MemoryIndexManager.
 * Extracted from manager.ts to reduce file size.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { hashText } from "./internal.js";
const SESSION_DELTA_READ_CHUNK_BYTES = 64 * 1024;
export async function listSessionFiles(agentId, customSessionsDir) {
  const dir = customSessionsDir ?? resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}
export function sessionPathForFile(absPath) {
  return path.join("sessions", path.basename(absPath)).replace(/\\/g, "/");
}
export function normalizeSessionText(value) {
  return value
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function extractSessionText(content) {
  if (typeof content === "string") {
    const normalized = normalizeSessionText(content);
    return normalized ? normalized : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block;
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    const normalized = normalizeSessionText(record.text);
    if (normalized) {
      parts.push(normalized);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" ");
}
export async function buildSessionEntry(absPath) {
  try {
    const stat = await fs.stat(absPath);
    const raw = await fs.readFile(absPath, "utf-8");
    const lines = raw.split("\n");
    const collected = [];
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record || typeof record !== "object" || record.type !== "message") {
        continue;
      }
      const message = record.message;
      if (!message || typeof message.role !== "string") {
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      const text = extractSessionText(message.content);
      if (!text) {
        continue;
      }
      const label = message.role === "user" ? "User" : "Assistant";
      collected.push(`${label}: ${text}`);
    }
    const content = collected.join("\n");
    return {
      path: sessionPathForFile(absPath),
      absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: hashText(content),
      content,
    };
  } catch {
    return null;
  }
}
export function isSessionFileForAgent(sessionFile, agentId) {
  if (!sessionFile) {
    return false;
  }
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const resolvedFile = path.resolve(sessionFile);
  const resolvedDir = path.resolve(sessionsDir);
  return resolvedFile.startsWith(`${resolvedDir}${path.sep}`);
}
export async function countNewlines(absPath, start, end) {
  if (end <= start) {
    return 0;
  }
  const handle = await fs.open(absPath, "r");
  try {
    let offset = start;
    let count = 0;
    const buffer = Buffer.alloc(SESSION_DELTA_READ_CHUNK_BYTES);
    while (offset < end) {
      const toRead = Math.min(buffer.length, end - offset);
      const { bytesRead } = await handle.read(buffer, 0, toRead, offset);
      if (bytesRead <= 0) {
        break;
      }
      for (let i = 0; i < bytesRead; i += 1) {
        if (buffer[i] === 10) {
          count += 1;
        }
      }
      offset += bytesRead;
    }
    return count;
  } finally {
    await handle.close();
  }
}
