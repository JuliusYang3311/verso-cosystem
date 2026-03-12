import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type MemoryFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
};

export type MemoryChunk = {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
};

export function ensureDir(dir: string): string {
  try {
    fsSync.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

export function normalizeRelPath(value: string): string {
  const trimmed = value.trim().replace(/^[./]+/, "");
  return trimmed.replace(/\\/g, "/");
}

export function normalizeExtraMemoryPaths(workspaceDir: string, extraPaths?: string[]): string[] {
  if (!extraPaths?.length) {
    return [];
  }
  const resolved = extraPaths
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) =>
      path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceDir, value),
    );
  return Array.from(new Set(resolved));
}

export function isMemoryPath(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) {
    return false;
  }
  if (normalized === "MEMORY.md" || normalized === "memory.md") {
    return true;
  }
  return normalized.startsWith("memory/");
}

async function walkDir(dir: string, files: string[]) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      await walkDir(full, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.endsWith(".md")) {
      continue;
    }
    files.push(full);
  }
}

export async function listMemoryFiles(
  workspaceDir: string,
  extraPaths?: string[],
): Promise<string[]> {
  const result: string[] = [];
  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  const altMemoryFile = path.join(workspaceDir, "memory.md");
  const memoryDir = path.join(workspaceDir, "memory");

  const addMarkdownFile = async (absPath: string) => {
    try {
      const stat = await fs.lstat(absPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return;
      }
      if (!absPath.endsWith(".md")) {
        return;
      }
      result.push(absPath);
    } catch {}
  };

  await addMarkdownFile(memoryFile);
  await addMarkdownFile(altMemoryFile);
  try {
    const dirStat = await fs.lstat(memoryDir);
    if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) {
      await walkDir(memoryDir, result);
    }
  } catch {}

  const normalizedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
  if (normalizedExtraPaths.length > 0) {
    for (const inputPath of normalizedExtraPaths) {
      try {
        const stat = await fs.lstat(inputPath);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          await walkDir(inputPath, result);
          continue;
        }
        if (stat.isFile() && inputPath.endsWith(".md")) {
          result.push(inputPath);
        }
      } catch {}
    }
  }
  if (result.length <= 1) {
    return result;
  }
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of result) {
    let key = entry;
    try {
      key = await fs.realpath(entry);
    } catch {}
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

export function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function buildFileEntry(
  absPath: string,
  workspaceDir: string,
): Promise<MemoryFileEntry> {
  const stat = await fs.stat(absPath);
  const content = await fs.readFile(absPath, "utf-8");
  const hash = hashText(content);
  return {
    path: path.relative(workspaceDir, absPath).replace(/\\/g, "/"),
    absPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash,
  };
}

// ---------------------------------------------------------------------------
// Smart Chunking — break-point scoring (ported from QMD)
// ---------------------------------------------------------------------------

export interface BreakPoint {
  pos: number;
  score: number;
  type: string;
}

export interface CodeFenceRegion {
  start: number;
  end: number;
}

/**
 * Patterns for detecting break points in markdown.
 * Higher scores = better places to split.
 */
const BREAK_PATTERNS: [RegExp, number, string][] = [
  [/\n#{1}(?!#)/g, 100, "h1"],
  [/\n#{2}(?!#)/g, 90, "h2"],
  [/\n#{3}(?!#)/g, 80, "h3"],
  [/\n#{4}(?!#)/g, 70, "h4"],
  [/\n#{5}(?!#)/g, 60, "h5"],
  [/\n#{6}(?!#)/g, 50, "h6"],
  [/\n```/g, 80, "codeblock"],
  [/\n(?:---|\*\*\*|___)\s*\n/g, 60, "hr"],
  [/\n\n+/g, 20, "blank"],
  [/\n[-*]\s/g, 5, "list"],
  [/\n\d+\.\s/g, 5, "numlist"],
  [/\n/g, 1, "newline"],
];

const CHUNK_WINDOW_CHARS = 800; // ~200 tokens × 4 chars/token

export function scanBreakPoints(text: string): BreakPoint[] {
  const seen = new Map<number, BreakPoint>();
  for (const [pattern, score, type] of BREAK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const pos = match.index;
      const existing = seen.get(pos);
      if (!existing || score > existing.score) {
        seen.set(pos, { pos, score, type });
      }
    }
  }
  return Array.from(seen.values()).toSorted((a, b) => a.pos - b.pos);
}

export function findCodeFences(text: string): CodeFenceRegion[] {
  const regions: CodeFenceRegion[] = [];
  const fencePattern = /\n```/g;
  let inFence = false;
  let fenceStart = 0;
  for (const match of text.matchAll(fencePattern)) {
    if (!inFence) {
      fenceStart = match.index;
      inFence = true;
    } else {
      regions.push({ start: fenceStart, end: match.index + match[0].length });
      inFence = false;
    }
  }
  if (inFence) {
    regions.push({ start: fenceStart, end: text.length });
  }
  return regions;
}

function isInsideCodeFence(pos: number, fences: CodeFenceRegion[]): boolean {
  return fences.some((f) => pos > f.start && pos < f.end);
}

/**
 * Find the best cut position using scored break points with distance decay.
 * Squared distance decay: headings far back still beat low-quality breaks near target.
 */
export function findBestCutoff(
  breakPoints: BreakPoint[],
  targetCharPos: number,
  windowChars: number = CHUNK_WINDOW_CHARS,
  decayFactor: number = 0.7,
  codeFences: CodeFenceRegion[] = [],
): number {
  const windowStart = targetCharPos - windowChars;
  let bestScore = -1;
  let bestPos = targetCharPos;
  for (const bp of breakPoints) {
    if (bp.pos < windowStart) {
      continue;
    }
    if (bp.pos > targetCharPos) {
      break;
    }
    if (isInsideCodeFence(bp.pos, codeFences)) {
      continue;
    }
    const distance = targetCharPos - bp.pos;
    const normalizedDist = distance / windowChars;
    const multiplier = 1.0 - normalizedDist * normalizedDist * decayFactor;
    const finalScore = bp.score * multiplier;
    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestPos = bp.pos;
    }
  }
  return bestPos;
}

// ---------------------------------------------------------------------------
// chunkMarkdown — smart chunking with break-point scoring
// ---------------------------------------------------------------------------

/** Count newlines in text up to (but not including) `pos`. Returns 1-based line number. */
function lineAt(text: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
    }
  }
  return line;
}

export function chunkMarkdown(
  content: string,
  chunking: { tokens: number; overlap: number },
): MemoryChunk[] {
  if (!content || content.length === 0) {
    return [];
  }
  const maxChars = Math.max(32, chunking.tokens * 4);
  const overlapChars = Math.max(0, chunking.overlap * 4);

  if (content.length <= maxChars) {
    const endLine = content.split("\n").length;
    return [{ startLine: 1, endLine, text: content, hash: hashText(content) }];
  }

  const breakPoints = scanBreakPoints(content);
  const codeFences = findCodeFences(content);
  const chunks: MemoryChunk[] = [];
  let charPos = 0;

  while (charPos < content.length) {
    const targetEndPos = Math.min(charPos + maxChars, content.length);
    let endPos = targetEndPos;

    if (endPos < content.length) {
      const bestCutoff = findBestCutoff(
        breakPoints,
        targetEndPos,
        CHUNK_WINDOW_CHARS,
        0.7,
        codeFences,
      );
      if (bestCutoff > charPos && bestCutoff <= targetEndPos) {
        endPos = bestCutoff;
      }
    }

    // Ensure progress
    if (endPos <= charPos) {
      endPos = Math.min(charPos + maxChars, content.length);
    }

    const text = content.slice(charPos, endPos);
    const startLine = lineAt(content, charPos);
    const endLine = lineAt(content, endPos - 1);
    chunks.push({ startLine, endLine, text, hash: hashText(text) });

    if (endPos >= content.length) {
      break;
    }
    const nextPos = endPos - overlapChars;
    charPos = nextPos <= charPos ? endPos : nextPos;
  }

  return chunks;
}

export function parseEmbedding(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as number[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  if (tasks.length === 0) {
    return [];
  }
  const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
  const results: T[] = Array.from({ length: tasks.length });
  let next = 0;
  let firstError: unknown = null;

  const workers = Array.from({ length: resolvedLimit }, async () => {
    while (true) {
      if (firstError) {
        return;
      }
      const index = next;
      next += 1;
      if (index >= tasks.length) {
        return;
      }
      try {
        results[index] = await tasks[index]();
      } catch (err) {
        firstError = err;
        return;
      }
    }
  });

  await Promise.allSettled(workers);
  if (firstError) {
    throw firstError;
  }
  return results;
}
