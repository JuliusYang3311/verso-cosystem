# Verso — Project Notes

## Memory System: 3-Layer Architecture

### Overview

| Layer | Storage                      | Content                                                        | Access                                              |
| ----- | ---------------------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| L0    | `chunks.l0_tags` (JSON)      | `{ factorId: cosineScore }` — factor projection tags           | Pre-filter in search pipeline                       |
| L1    | `chunks.l1_sentences` (JSON) | `[{ text, startChar, endChar }]` — MMR-extracted key sentences | Injected into `snippet`; used for context injection |
| L2    | `chunks.text` (SQL)          | Full chunk text                                                | On-demand via `memory_get(chunkId)`                 |

### Search Pipeline (`src/memory/manager.ts`)

```
Query
  → projectQueryToFactors()  → selectedFactors (+ "_primary" fallback)
  → For each factor:
      getChunkIdsForFactor()  → all chunks with non-zero L0 tag
      findGapCutoff(l0Scores) → trim to top candidates
      searchVectorFiltered(chunkIds, queryVec) → ranked rows
  → Merge (dedup, keep highest score per chunk ID)
  → Optional hybrid keyword boost
  → toMemorySearchResult():
      snippet = l1Sentences.map(s => s.text).join(" ")  [fallback: raw text truncated]
  → emit factor hit/miss signals to evolver
```

### L1 Extraction (`src/memory/manager-l1-extractive.ts`)

No LLM — pure embedding arithmetic:

1. `splitSentences(text)` — natural language (sentence-end punctuation) or code (line-by-line)
2. `embedBatch(sentences)` → per-sentence vectors
3. MMR greedy: `gain = sim(sent, centroid) - max_sim_to_already_selected`
4. Gap detection: sort gains descending, cut at largest drop → `extractL1Sentences()`

### L0 Tag Generation (during sync)

`projectChunkToFactors(chunkEmbedding, factorSpace)` → raw cosine scores `{ factorId: score }`
stored in `chunks.l0_tags`. On factor space change: `reprojectAllTags()` (matrix multiply, no re-embedding).

---

## Context Injection Format

Injected as a synthetic user message (prepended) before each LLM call by the SDK `context` event handler.

**Current format** (`src/agents/pi-extensions/dynamic-context/extension.ts`):

```
<memory-context>
The following are relevant memory snippets retrieved for this conversation:

[path/to/file.md:10-45] (score=0.85)
<L1 snippet text>
---
[sessions/2024-03-08.jsonl:150-180] (score=0.72)
<L1 snippet text>
</memory-context>
```

**Known gap**: No `chunkId` or `→ memory_get(chunkId)` reference is included. The LLM can see the snippet but has no structured pointer to call `memory_get` for L2 details. Chunk IDs are available on `RetrievedChunk.id`.

---

## `memory_search` Tool Response

LLM receives: `id`, `path`, `startLine`, `endLine`, `score`, `source`, `snippet`, `citation` (optional).

Stripped before sending: `l1Sentences` (char offsets, internal) and `l0Tags` (factor scores, internal).
`snippet` is the canonical L1 text (or L2 fallback). No duplicate content.

---

## Novel-Writer Storage

Projects and style database live under the user's configured workspace, not the repo:

```
<workspace>/novel-writer/projects/   ← PROJECTS_DIR
<workspace>/novel-writer/style/      ← STYLE_DB_PATH parent
```

Workspace resolved from `VERSO_CONFIG_PATH` → `agents.defaults.workspace`, fallback `~/.verso/workspace`.
All novel-writer consumers import `PROJECTS_DIR` / `STYLE_DB_PATH` from `skills/novel-writer/ts/apply-patch.ts`.

---

## Key File Locations

| Purpose                          | File                                                           |
| -------------------------------- | -------------------------------------------------------------- |
| Schema (chunks/files tables)     | `src/memory/memory-schema.ts`                                  |
| Main indexer + search            | `src/memory/manager.ts`                                        |
| L0/L1 SQL queries                | `src/memory/manager-search.ts`                                 |
| L1 extractive summarisation      | `src/memory/manager-l1-extractive.ts`                          |
| Factor space + projection        | `src/memory/latent-factors.ts`                                 |
| Hybrid merge                     | `src/memory/hybrid.ts`                                         |
| Chunk diversity / MMR            | `src/memory/chunk-diversity.ts`                                |
| Memory search types              | `src/memory/types.ts`                                          |
| memory_search / memory_get tools | `src/agents/tools/memory-tool.ts`                              |
| Dynamic context builder          | `src/agents/dynamic-context.ts`                                |
| Dynamic context SDK extension    | `src/agents/pi-extensions/dynamic-context/extension.ts`        |
| Context params (evolver-tunable) | loaded from `getContextParamsPath()` via `loadContextParams()` |
| Novel-writer memory              | `skills/novel-writer/ts/novel-memory.ts`                       |
| Novel-writer path resolution     | `skills/novel-writer/ts/apply-patch.ts`                        |

---

## Test Coverage Summary

| File                                          | Tests | Covers                                                                             |
| --------------------------------------------- | ----- | ---------------------------------------------------------------------------------- |
| `src/memory/index.test.ts`                    | 16    | Indexing, L1/L2 integration, `readChunk`, snippet from L1                          |
| `src/memory/manager-search.test.ts`           | 10    | `getChunkIdsForFactor` — L0 tag filtering, sort, source/model isolation            |
| `src/agents/dynamic-context.test.ts`          | 18    | `selectRecentMessages`, ratio, time decay, progressive load, `buildDynamicContext` |
| `skills/novel-writer/ts/novel-memory.test.ts` | 30    | Novel store indexing, search, L1 threading, L0 factor filter, `computeMeanVector`  |

**Gaps (known defects):**

- `src/agents/pi-extensions/dynamic-context/extension.ts` — no tests (search call, `<memory-context>` assembly, chunkId missing from format, error fallback)
- `loadContextParams()` — no test for evolver path fallback to defaults
