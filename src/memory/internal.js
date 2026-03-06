import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
export function ensureDir(dir) {
  try {
    fsSync.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}
export function normalizeRelPath(value) {
  const trimmed = value.trim().replace(/^[./]+/, "");
  return trimmed.replace(/\\/g, "/");
}
export function normalizeExtraMemoryPaths(workspaceDir, extraPaths) {
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
export function isMemoryPath(relPath) {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) {
    return false;
  }
  if (normalized === "MEMORY.md" || normalized === "memory.md") {
    return true;
  }
  return normalized.startsWith("memory/");
}
async function walkDir(dir, files) {
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
export async function listMemoryFiles(workspaceDir, extraPaths) {
  const result = [];
  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  const altMemoryFile = path.join(workspaceDir, "memory.md");
  const memoryDir = path.join(workspaceDir, "memory");
  const addMarkdownFile = async (absPath) => {
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
  const seen = new Set();
  const deduped = [];
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
export function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
export async function buildFileEntry(absPath, workspaceDir) {
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
/**
 * Patterns for detecting break points in markdown.
 * Higher scores = better places to split.
 */
const BREAK_PATTERNS = [
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
export function scanBreakPoints(text) {
  const seen = new Map();
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
export function findCodeFences(text) {
  const regions = [];
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
function isInsideCodeFence(pos, fences) {
  return fences.some((f) => pos > f.start && pos < f.end);
}
/**
 * Find the best cut position using scored break points with distance decay.
 * Squared distance decay: headings far back still beat low-quality breaks near target.
 */
export function findBestCutoff(
  breakPoints,
  targetCharPos,
  windowChars = CHUNK_WINDOW_CHARS,
  decayFactor = 0.7,
  codeFences = [],
) {
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
function lineAt(text, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
    }
  }
  return line;
}
export function chunkMarkdown(content, chunking) {
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
  const chunks = [];
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
export function parseEmbedding(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
export function cosineSimilarity(a, b) {
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
export async function runWithConcurrency(tasks, limit) {
  if (tasks.length === 0) {
    return [];
  }
  const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
  const results = Array.from({ length: tasks.length });
  let next = 0;
  let firstError = null;
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
// ---------- L0 abstract generation (synchronous, no LLM) ----------
const L0_MAX_CHARS = 400;
const FILE_L0_MAX_CHARS = 600;
const MD_FORMAT_RE = /[*_`#~[\]]/g;
function stripMarkdownFormatting(text) {
  return text.replace(MD_FORMAT_RE, "").trim();
}
/**
 * Generate an L0 abstract for a single chunk.
 * Extracts the first meaningful line (heading or text), optionally appends the
 * first sentence of the following paragraph, and truncates to ~400 chars.
 */
export function generateL0Abstract(chunk) {
  const lines = chunk.text.split("\n");
  let heading = "";
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("#")) {
      heading = stripMarkdownFormatting(trimmed.replace(/^#+\s*/, ""));
      bodyStart = i + 1;
      break;
    }
    // First non-empty, non-heading line
    heading = stripMarkdownFormatting(trimmed);
    bodyStart = i + 1;
    break;
  }
  if (!heading) {
    return "";
  }
  // Try to append the first sentence of the next paragraph
  let firstSentence = "";
  for (let i = bodyStart; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const cleaned = stripMarkdownFormatting(trimmed);
    const dotIdx = cleaned.indexOf(".");
    firstSentence = dotIdx >= 0 ? cleaned.slice(0, dotIdx + 1) : cleaned;
    break;
  }
  const combined =
    firstSentence && firstSentence !== heading ? `${heading}: ${firstSentence}` : heading;
  return combined.length > L0_MAX_CHARS ? combined.slice(0, L0_MAX_CHARS) : combined;
}
/**
 * Generate a file-level L0 abstract by joining all chunk L0 abstracts.
 * Truncates to ~600 chars.
 */
export function generateFileL0(chunkL0s) {
  const filtered = chunkL0s.filter(Boolean);
  if (filtered.length === 0) {
    return "";
  }
  const combined = filtered.join("; ");
  return combined.length > FILE_L0_MAX_CHARS ? combined.slice(0, FILE_L0_MAX_CHARS) : combined;
}
