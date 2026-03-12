---
name: novel-writer
description: Autonomous long-form fiction engine with style library, four-layer continuity memory, latent factor search, and greedy MMR diversity selection. Ingest corpora for style indexing, generate 6000+ token chapters from outlines, auto-update character/world/timeline/plot-thread memory after each chapter.
command-dispatch: tool
command-tool: novel_writer
command-arg-mode: raw
---

## Mandatory Rules

1. **6000+ tokens per chapter.** The engine auto-continues if output is too short. Never accept a short chapter.
2. **Write to file, NEVER to chat.** Chapters are saved as `{project}_chapter_XX.txt`. Only output a one-line confirmation in conversation.
3. **Language follows input.** Writing language matches the outline (write mode) or original chapter (rewrite mode). Not hardcoded to any language.
4. **Use `--rewrite` for revisions.** Rewrite mode automatically reverts memory, rewrites, and re-applies a fresh patch. Never manually edit memory files to "fix" a chapter.
5. **One patch per chapter.** Never merge multiple chapters into one patch.
6. **Read project `RULES.md` before writing** (`projects/<project>/RULES.md`), if it exists.
7. **Memory updates are automatic.** The autonomous engine handles extract → validate → apply after each chapter. Do not skip or manually override.

## Architecture

```
skills/novel-writer/
├── ts/                         # TypeScript source (built by tsdown → dist/skills/novel-writer/)
│   ├── write-chapter.ts        # Autonomous engine (write + rewrite modes)
│   ├── revert-memory.ts        # Memory rollback for rewrite mode
│   ├── novel-memory.ts         # Isolated SQLite DBs, 3-layer index (L0 tags / L1 sentences / L2 text), latent factor search + greedy MMR
│   ├── context.ts              # Assemble full context (JSON memory + search results)
│   ├── apply-patch.ts          # Apply patch + auto-index timeline + pre-patch snapshot
│   ├── validate-patch.ts       # Validate patch safety (protected chars/keys, shrink guard)
│   ├── extract-updates.ts      # LLM-based patch extraction from chapter text
│   ├── ingest-style.ts         # Ingest style corpus → shared style DB
│   ├── ingest-timeline.ts      # Bulk re-index timeline.jsonl → per-project timeline DB
│   ├── search.ts               # Search style or timeline DB
│   └── status.ts               # Show project progress
├── references/
│   ├── memory_schema.md        # JSON schemas for 4-layer memory
│   ├── style_tags.md           # Allowed tags + style taxonomy
│   └── doc_naming.md           # Google Docs naming rules
├── style/                      # SHARED style DB (all projects)
│   └── style_memory.sqlite
└── projects/<project>/         # PER-PROJECT isolation
    ├── state.json              # Progress tracking
    ├── RULES.md                # Optional per-project writing rules
    ├── memory/
    │   ├── characters.json
    │   ├── world_bible.json
    │   ├── plot_threads.json
    │   └── timeline.jsonl
    ├── patches/                # Patch history (for rewrite rollback)
    │   ├── patch-01.json       # Archived patch
    │   └── patch-01.pre.json   # Pre-patch snapshot (original values)
    ├── timeline_memory.sqlite  # Verso-backed timeline index (auto-updated)
    ├── chapters/               # Chapter text files (.txt)
    └── style/
        └── default_style.json  # Per-project default tags
```

## Storage Isolation

| Storage                                     | Scope                 | Updated by                     |
| ------------------------------------------- | --------------------- | ------------------------------ |
| `style/style_memory.sqlite`                 | Shared (all projects) | `ingest-style.ts` only         |
| `projects/<project>/memory/*.json`          | Per-project           | `apply-patch.ts`               |
| `projects/<project>/memory/timeline.jsonl`  | Per-project           | `apply-patch.ts` (append)      |
| `projects/<project>/timeline_memory.sqlite` | Per-project           | `apply-patch.ts` (auto-index)  |
| `projects/<project>/state.json`             | Per-project           | `apply-patch.ts` (auto-update) |

- Style library is **never** modified by chapter writes. Only `ingest-style.ts` adds content.
- Each project's memory is **completely isolated**. No cross-project contamination.
- Timeline DB is **automatically re-indexed** every time `apply-patch.ts` runs.

## 3-Layer Memory Architecture

Matches verso's main memory system exactly:

| Layer | Column         | Content                                                   | Used for                        |
| ----- | -------------- | --------------------------------------------------------- | ------------------------------- |
| L0    | `l0_tags`      | `{ factorId: score }` — chunk projected onto factor space | Coarse pre-filter at query time |
| L1    | `l1_sentences` | MMR-selected key sentences (embedding + gap detection)    | Context injection               |
| L2    | `chunks.text`  | Full chunk text                                           | Read on demand                  |

**Indexing pipeline:**

```
content → chunkMarkdown()
  → embed chunks
  → L0: projectChunkToFactors() → l0_tags
  → L1: splitSentences() + embedBatch + extractL1Sentences() → l1_sentences
  → file-level vector = mean(chunk embeddings) → FILES_VECTOR_TABLE
```

## Search: Latent Factors + L0 Pre-filter + Greedy MMR

Style and timeline search use the same retrieval pipeline as verso's main memory system:

1. **Latent factor projection** — query projected into factor space, generating orthogonal sub-queries via MMR diversification
2. **L0 pre-filter** — each factor sub-query calls `getChunkIdsForFactor()` to restrict vector search to L0-matching chunks (`searchVectorFiltered`). Falls through to unfiltered search when no L0 matches exist.
3. **Hybrid search** — vector + BM25 per sub-query (unfiltered path when no factor space)
4. **Diversity pipeline** — all candidates merged, deduplicated, threshold-filtered, selected via greedy MMR

Controlled by `context_params.json`: `latentFactorEnabled`, `factorActivationThreshold`, `factorMmrLambda`, `mmrLambda`, `baseThreshold`, `thresholdFloor`. When `latentFactorEnabled: false`, falls back to single-query hybrid search.

## Autonomous Mode (Primary)

One command completes the full pipeline: context assembly → LLM writing (6000+ tokens) → save chapter → extract updates → validate → apply patch → update memory.

**Write new chapter** (auto-detects next chapter number):

```bash
node dist/skills/novel-writer/write-chapter.js \
  --project my_novel \
  --outline "林澈在旧港码头发现暗门，苏宁被跟踪"
```

**Rewrite existing chapter** (reverts memory → rewrites → re-applies patch):

```bash
node dist/skills/novel-writer/write-chapter.js \
  --project my_novel \
  --rewrite \
  --chapter 8 \
  --notes "节奏太慢，需要加强悬疑感"
```

Returns JSON:

```json
{
  "summary": "主角发现暗门，苏宁遭遇跟踪...",
  "chapterPath": "skills/novel-writer/projects/my_novel/chapters/my_novel_chapter_08.txt",
  "wordCount": 12350,
  "memoryUpdated": ["新角色: 守护者", "伏笔: 核心裂痕"],
  "rewritten": false
}
```

Optional flags: `--title "章节标题"`, `--style "noir 悬疑"`, `--budget 8000`

## Manual Mode (Debugging)

### Create Project

Use `--project <name>` on any command. Directories are created automatically.

### Ingest Style Corpus (One-Time, Shared)

```bash
npx tsx skills/novel-writer/ts/ingest-style.ts \
  --source-dir /path/to/corpus \
  --glob "**/*.txt" \
  --author "Author Name" \
  --genre "悬疑" \
  --tags "noir,快节奏"
```

Options: `--min-chars`/`--max-chars` (chunk bounds), `--author`, `--genre`, `--pov`, `--rhythm`, `--tone`, `--tags`, `--force`

### Set Per-Project Default Style

Create `projects/<project>/style/default_style.json`:

```json
{ "tags": ["悬疑", "快节奏", "noir"] }
```

### Retrieve Context

```bash
npx tsx skills/novel-writer/ts/context.ts \
  --project my_novel \
  --outline "第8章：林澈在旧港码头发现暗门" \
  --style "noir 悬疑 紧张氛围" \
  --budget 8000
```

### Extract + Validate + Apply Patch

```bash
# Extract
npx tsx skills/novel-writer/ts/extract-updates.ts \
  --project my_novel --chapter 8 --title "回响" \
  --text chapters/my_novel_chapter_08.txt > patch.json

# Validate
npx tsx skills/novel-writer/ts/validate-patch.ts \
  --project my_novel --patch patch.json

# Apply (updates all 4 layers + timeline DB + state)
npx tsx skills/novel-writer/ts/apply-patch.ts \
  --project my_novel --patch patch.json --chapter 8 --title "回响"
```

### Bulk Re-Index Timeline

```bash
npx tsx skills/novel-writer/ts/ingest-timeline.ts --project my_novel [--force]
```

### Search

```bash
npx tsx skills/novel-writer/ts/search.ts --db style --query "dark gothic atmosphere"
npx tsx skills/novel-writer/ts/search.ts --db timeline --project my_novel --query "betrayal scene"
```

### Check Progress

```bash
npx tsx skills/novel-writer/ts/status.ts --project my_novel --recent 5
```

## Four-Layer Continuity Memory

### characters.json

```json
{
  "characters": [
    {
      "name": "林澈",
      "aliases": ["阿澈"],
      "role": "main",
      "traits": ["谨慎", "冷静"],
      "status": "alive",
      "relations": { "苏宁": "搭档" },
      "protected": true
    }
  ]
}
```

### world_bible.json

```json
{
  "world": { "rules": ["时间不可回溯"], "locations": ["北城", "旧港"] },
  "protected_keys": ["rules"]
}
```

### timeline.jsonl (append-only)

```json
{
  "chapter": 2,
  "title": "旧照片",
  "summary": "主角被跟踪并收到旧照片",
  "events": ["被跟踪", "收到旧照片"],
  "consequences": ["开始调查"],
  "pov": "第三人称",
  "locations": ["旧港码头"],
  "characters": ["林澈", "苏宁"]
}
```

### plot_threads.json

```json
{
  "threads": [
    {
      "thread_id": "t-ghost-interest",
      "introduced_in": 2,
      "promise": "主角被人惦记",
      "stakes": "身份/安全",
      "status": "open",
      "must_resolve_by": 8
    }
  ]
}
```

## Patch Format

Every chapter produces a patch JSON with keys: `characters`, `world_bible`, `timeline`, `plot_threads`. Empty layers use empty patch objects (not omitted).

```json
{
  "characters": { "add": [], "update": [], "delete": [] },
  "world_bible": { "add": {}, "update": {}, "delete": [] },
  "timeline": {
    "summary": "",
    "events": [],
    "consequences": [],
    "pov": "",
    "locations": [],
    "characters": []
  },
  "plot_threads": { "add": [], "update": [], "close": [] }
}
```

## Safety

- **Never overwrite full memory files.** Only apply patch objects.
- Protected characters cannot be deleted; major character list cannot shrink by >30%
- Protected world keys cannot be erased
- Transactional: backup → apply → validate → commit or rollback
- Pre-patch snapshots (`patches/patch-NN.pre.json`) enable precise memory rollback for rewrites

## Embedding

Provider resolved from verso config (`~/.verso/verso.json`): OpenAI, Gemini, Voyage, or local models. Embedding cache is per-DB.

- **Chunk embedding** — used for vector search and as L1 centroid
- **Sentence embedding** — all sentences across all chunks in one batch call; used by `extractL1Sentences()` for L1 MMR selection
- **File-level embedding** — mean of chunk embeddings; stored in `FILES_VECTOR_TABLE` for file-level vector pre-filter

LLM extraction (patch generation) uses `agents.defaults.model`.

## References

- `references/memory_schema.md`: JSON schemas for 4-layer memory + patch format
- `references/style_tags.md`: allowed tags + style taxonomy
- `references/doc_naming.md`: Google Docs naming rules
