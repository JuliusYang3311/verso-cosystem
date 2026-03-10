# Verso Project Notes

## Memory System Architecture — 3-Layer Redesign

### Overview

The memory system uses a 3-layer architecture for indexing and retrieval:

- **L0 (Tag Layer)**: Factor projection scores per chunk. Used for coarse filtering.
- **L1 (Summary Layer)**: Extractive key sentences (embedding-based MMR + gap detection). Used for fine search and context injection. Contains references to L2.
- **L2 (Chunk Layer)**: Full chunk text. Accessed on-demand via `memory_get(path, from, lines)`.

### Search Flow

```
Query → factor decomposition → N activated factors
  ↓
Each factor → match L0 tags (gap detection threshold) → candidate set
  ↓
Each sub-query → vector + BM25 search on L1 within candidate set → fine rank
  ↓
Merge → inject L1 sentences into <memory-context> with L2 references
  ↓
Agent needs details → calls memory_get(path, from, lines) to read L2
```

### Indexing Flow

```
File content
  → chunkMarkdown() → chunks with embedding
  → project chunk embedding onto factor space → L0 tags { factorId: score }
  → embedding-based extractive summarization (MMR + gap cutoff) → L1 sentences
  → store L2 full text, L1 sentences + ref, L0 tags
```

### L0 Tag Generation (Factor Projection)

- Reuses existing `projectQueryToFactors()` in reverse: chunk → factor space
- Each chunk gets `{ factorId: score }` tags via cosine similarity + softmax
- On factor space changes: reprojectAllTags() — recompute from stored embeddings, no re-embedding needed

### L1 Extractive Summarization (No LLM)

Algorithm:

1. Split chunk text into sentences
2. Batch-embed all sentences (reuse existing embedding provider)
3. Compute centroid (chunk embedding or mean of sentence embeddings)
4. MMR greedy selection:
   - `gain_i = sim(sentence_i, centroid) - max_j∈selected sim(sentence_i, selected_j)`
5. Gap detection cutoff: sort gains, find largest drop, keep sentences before the drop
6. Store selected sentences + L2 reference `{ path, from, lines }`

### Multi-Factor Query Adaptation (Scheme B)

- L0 tags are stable (factor-independent at index time; derived from chunk embeddings)
- At query time, each activated factor dynamically matches L0 tags via gap detection
- Each factor sub-query searches only its L0-filtered candidate set
- Factors without matching chunks are skipped entirely (e.g., no "trend"-tagged chunks → skip "trend" sub-query)
- Factor changes → reprojectAllTags() (cheap: matrix multiply on existing embeddings)

### Gap Detection (Used in Two Places)

1. **L0 factor→tag matching**: factor similarity scores sorted descending, find largest gap → threshold
2. **L1 sentence selection cutoff**: MMR gains sorted, find largest gap → stop selecting

### Context Injection Format

```
<memory-context>
[sessions/2024-03-08.jsonl:150-180] (score=0.85)
- OAuth credentials written to auth-profiles.json
- Chose SQLite over Postgres for embedded deployment
→ memory_get("sessions/2024-03-08.jsonl", from=150, lines=30)

[memory/architecture.md:10-45] (score=0.72)
- Three-layer memory: tags, summaries, full text
→ memory_get("memory/architecture.md", from=10, lines=35)
</memory-context>
```

### Schema Changes

```sql
-- chunks table
-- REMOVE: l0_abstract, l1_overview, l1_status
-- ADD:
l0_tags TEXT NOT NULL DEFAULT '{}'       -- JSON: { factorId: score, ... }
l1_sentences TEXT NOT NULL DEFAULT '[]'  -- JSON: [{ text: string, startChar: number, endChar: number }]
l1_ref TEXT NOT NULL DEFAULT ''          -- "path:startLine-endLine"

-- files table
-- REMOVE: l0_abstract
-- KEEP: l0_embedding (still used for hierarchical file-level search)
```

### Implementation Phases

1. **Schema migration**: Update chunks/files tables, add new columns, remove old ones
2. **L0 indexing**: Factor projection during chunk indexing, reprojectAllTags() for factor changes
3. **L1 indexing**: Embedding-based extractive summarization (MMR + gap detection) in new file `manager-l1-extractive.ts`
4. **Search pipeline**: L0 tag filtering per factor, L1 fine search within filtered set
5. **Context injection**: Inject L1 sentences with L2 refs (no more progressive loading)
6. **memory_search tool**: Returns L1 summaries; memory_get reads L2 on demand (already works)
7. **Consumer adaptation**: dynamic-context.ts, attempt.ts, orchestrator-memory.ts, novel-writer
8. **Cleanup**: Remove old L0/L1 generators, progressive loading, maxResults, candidateMultiplier
9. **Tests**: Update all memory-related tests

### Files to Modify

Core memory:

- `src/memory/memory-schema.ts` — schema changes
- `src/memory/manager.ts` — indexing + search rewrite
- `src/memory/manager-search.ts` — L1-based search queries
- `src/memory/manager-hierarchical-search.ts` — integrate L0 tag pre-filter
- `src/memory/manager-l1-extractive.ts` — NEW: extractive summarization
- `src/memory/manager-l1-generator.ts` — DELETE (replaced by extractive)
- `src/memory/internal.ts` — remove generateL0Abstract, generateFileL0
- `src/memory/latent-factors.ts` — add chunk→factor projection helper
- `src/memory/hybrid.ts` — update types (remove l0Abstract/l1Overview)
- `src/memory/chunk-diversity.ts` — update DiverseChunk type
- `src/memory/types.ts` — update MemorySearchResult

Context & injection:

- `src/agents/dynamic-context.ts` — remove progressive loading, simplify to L1 injection
- `src/agents/pi-embedded-runner/run/attempt.ts` — adapt injection format

Tools & consumers:

- `src/agents/tools/memory-tool.ts` — search returns L1 summaries
- `src/agents/memory-search.ts` — remove maxResults, candidateMultiplier from config
- `src/orchestration/orchestrator-memory.ts` — adapt to new search results
- `skills/novel-writer/ts/novel-memory.ts` — adapt SQL and types
- `skills/novel-writer/ts/context.ts` — adapt context params

Config:

- `src/config/types.tools.ts` — remove deprecated fields
- `src/config/zod-schema.agent-runtime.ts` — remove deprecated fields
- `src/config/schema.ts` — remove deprecated labels/descriptions
