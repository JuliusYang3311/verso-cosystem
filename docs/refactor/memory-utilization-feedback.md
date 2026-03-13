# Memory Utilization Feedback Loop — Design Document

## Problem Statement

Verso's memory system injects retrieved chunks into LLM context, but has no way to measure whether the LLM actually **uses** them. This creates two failure modes:

1. **Over-injection**: Too many chunks injected, most ignored → attention dilution, wasted token budget
2. **Under-compression**: L1 snippets lose critical detail → LLM calls `memory_get` for L2 → extra latency

The core insight: the optimization target is not "maximize information in context" but **"maximize LLM utilization efficiency of injected information"**.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────┐
│  Dynamic Context Extension (Layer 1)                           │
│  context event → search → filter → inject <memory-context>     │
│  *** store lastInjectedChunks on runtime ***                   │
└──────────────────────────┬─────────────────────────────────────┘
                           ↓
                      LLM processes
                           ↓
┌──────────────────────────┴─────────────────────────────────────┐
│  Subscription Handler (existing)                               │
│  collects: assistantTexts, toolMetas                            │
└──────────────────────────┬─────────────────────────────────────┘
                           ↓
┌──────────────────────────┴─────────────────────────────────────┐
│  Post-Turn Attribution (attempt.ts, new)                       │
│                                                                │
│  For each injected chunk:                                      │
│    1. memory_get(chunkId) in toolMetas?  → l1_miss             │
│    2. snippet phrases in assistantText?  → utilized            │
│    3. user_correction detected?          → misleading          │
│    4. none of above?                     → ignored             │
│                                                                │
│  Write to chunk_utilization table                              │
│  Emit session-level aggregation to feedback.jsonl              │
└──────────────────────────┬─────────────────────────────────────┘
                           ↓
         ┌─────────────────┴─────────────────┐
         ↓                                   ↓
┌────────────────────┐          ┌─────────────────────────────┐
│  Real-time Feedback │          │  Offline Feedback (Evolver) │
│  (next LLM call)   │          │                             │
│                     │          │  signals.ts: new memory_*   │
│  A. Threshold adapt │          │  genes.json: memory genes   │
│  B. Ranking prior   │          │  memoryGraph: causal edges  │
│  C. L1/L2 selection │          │  context_params.json: tune  │
└────────────────────┘          └─────────────────────────────┘
```

---

## Design Constraint

**The evolver can only write workspace asset files** (`context_params.json`, `factor-space.json`, `genes.json`, `capsules.json`). It cannot modify Verso source code.

Therefore the design splits into:

- **Source code infrastructure** (developer, one-time): makes utilization observable, exposes tunable parameters
- **Runtime adaptation** (evolver, continuous): tunes parameters based on observed signals

---

## Phase 1: State Infrastructure

### 1.1 Extend DynamicContextRuntime

**File**: `src/agents/pi-extensions/dynamic-context/runtime.ts`

Add `lastInjectedChunks` to track what was injected in the current turn:

```typescript
export type InjectedChunkRecord = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  factorIds: string[]; // all contributing factors
};

export type DynamicContextRuntime = {
  memoryManager: MemorySearchManager | null;
  config?: VersoConfig;
  contextLimit?: number;
  lastInjectedChunks: InjectedChunkRecord[]; // new
};
```

Initialize as `[]` in session-factory.ts when creating the runtime.

### 1.2 Record Injected Chunks in Extension

**File**: `src/agents/pi-extensions/dynamic-context/extension.ts`

After building `<memory-context>`, write the injected list to runtime:

```typescript
runtime.lastInjectedChunks = result.retrievedChunks.map((c) => ({
  id: c.id ?? "",
  path: c.path,
  startLine: c.startLine,
  endLine: c.endLine,
  snippet: c.snippet,
  score: c.score,
  factorIds: (c.factorsUsed ?? []).map((f) => f.id),
}));
```

### 1.3 New SQL Table: chunk_utilization

**File**: `src/memory/memory-schema.ts`

```sql
CREATE TABLE IF NOT EXISTS chunk_utilization (
  chunk_id    TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  event       TEXT NOT NULL,
  factor_ids  TEXT NOT NULL DEFAULT '[]',
  query_hash  TEXT,
  score       REAL,
  timestamp   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunk_util_chunk
  ON chunk_utilization(chunk_id);
CREATE INDEX IF NOT EXISTS idx_chunk_util_session
  ON chunk_utilization(session_id, timestamp);
```

**Event types**: `injected`, `utilized`, `ignored`, `l1_miss`, `misleading`

No primary key constraint — same chunk can be injected multiple times in one session (multi-turn conversations).

### 1.4 New Module: utilization.ts

**File**: `src/memory/utilization.ts` (new)

Exports:

| Function                                              | Purpose                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `recordUtilization(db, events[])`                     | Batch insert utilization events                                                    |
| `getChunkUtilizationStats(db, chunkId)`               | Per-chunk aggregate: `{ injectCount, utilizeCount, l1MissCount, utilizationRate }` |
| `getSessionUtilizationRate(db, sessionId, windowMs?)` | Session-level aggregate rate                                                       |
| `getRecentUtilizationSummary(db, windowMs?)`          | Cross-session aggregate for evolver signals                                        |
| `detectUtilization(snippet, output)`                  | Phrase-matching attribution (≥20 char substring)                                   |

---

## Phase 2: Signal Collection

### 2.1 Post-Turn Attribution Hook

**File**: `src/agents/pi-embedded-runner/run/attempt.ts`

Insert after the existing `indexSessionTurn` call site (~line 1000). All required data is already available at this point:

| Data            | Source                       | Already available          |
| --------------- | ---------------------------- | -------------------------- |
| Injected chunks | `runtime.lastInjectedChunks` | After Phase 1.2            |
| Tool calls      | `toolMetasNormalized`        | Yes (subscription handler) |
| LLM output      | `assistantTexts.join("")`    | Yes                        |
| Session ID      | `sessionIdUsed`              | Yes                        |

**Attribution priority** (per injected chunk):

```
1. chunk.id in memory_get tool calls?      → l1_miss    (precise, explicit)
2. chunk.snippet phrases in assistantText? → utilized   (fuzzy, statistical)
3. user_correction detected this turn?     → misleading (correlative)
4. none                                    → ignored
```

Each chunk produces exactly one event (plus the always-emitted `injected` event).

### 2.2 Attribution Function

`detectUtilization(snippet, output)` — intentionally simple:

- Extract phrases ≥20 chars from snippet (regex: `/[\p{L}\p{N}][^\n]{18,}/gu`)
- If any phrase appears in output → `true`
- No semantic matching, no embedding comparison
- Designed for statistical accuracy over many samples, not per-instance precision

### 2.3 memory_search as Signal

When LLM calls `memory_search` explicitly (via tool), it means dynamic injection didn't cover its needs. Record this in the same session's utilization data as a `retrieval_gap` signal (not per-chunk, but per-session).

**File**: `src/agents/tools/memory-tool.ts` — in `memory_search` execute handler.

---

## Phase 3: Feedback Flow into Retrieval Pipeline

**Key principle**: Utilization feedback flows back into the retrieval pipeline's existing parameters, not via post-hoc truncation.

### 3.1 Dynamic Threshold Adaptation

**File**: `src/agents/pi-extensions/dynamic-context/extension.ts` or `src/agents/dynamic-context.ts`

Instead of hardcoding a max-chunks cutoff, adjust the **threshold** based on utilization rate:

```typescript
const sessionUtilRate = getSessionUtilizationRate(db, sessionId, windowMs);
const effectiveThreshold = computeAdaptiveThreshold(
  contextParams.baseThreshold,
  sessionUtilRate,
  contextParams.utilizationThresholdBoost,
);
```

Formula:

```
effectiveThreshold = baseThreshold + (1 - utilizationRate) × thresholdBoost
```

- `utilizationRate = 0.3` (low) → threshold increases, fewer chunks pass
- `utilizationRate = 0.8` (high) → threshold barely changes, current behavior
- `utilizationRate = null` (cold start) → use `baseThreshold` unchanged

This is continuous, has no magic numbers, and works inside the existing filter pipeline rather than truncating results.

### 3.2 Ranking Prior

**File**: `src/memory/manager.ts` — in `search()`, before returning results

Apply a soft score adjustment based on historical utilization:

```typescript
function applyUtilizationPrior(db, results, strength) {
  return results.map((r) => {
    const stats = getChunkUtilizationStats(db, r.id);
    if (!stats || stats.injectCount < minSamples) return r;
    const multiplier = 1.0 + strength * (stats.utilizationRate - 0.5);
    return { ...r, score: r.score * multiplier };
  });
}
```

- `strength` is evolver-tunable via `utilizationPriorStrength`
- Adjustment range: `[1 - strength/2, 1 + strength/2]`
- `minSamples` (default 3): cold-start guard, skip chunks with insufficient data
- Utilization prior is **multiplicative on relevance score**, never overrides semantic relevance

### 3.3 L1/L2 Adaptive Selection

**File**: `src/agents/pi-extensions/dynamic-context/extension.ts` — snippet assembly

Per-chunk decision based on historical L1 miss rate:

```typescript
const stats = getChunkUtilizationStats(db, chunk.id);
const useL2 =
  stats &&
  stats.injectCount >= minSamples &&
  stats.l1MissCount / stats.injectCount > l1MissRateThreshold;
```

If `useL2`:

- Call `runtime.memoryManager.readChunk(chunk.id)` to get full text
- Respect `l2BudgetRatio` (max fraction of retrieval budget for L2 text)
- Fallback to L1 if L2 read fails or budget exceeded

### 3.4 Per-Source Time Decay

**File**: `src/agents/dynamic-context.ts` — `filterRetrievedChunks`

Currently `timeDecayLambda` is global. Split by source:

```typescript
const lambda =
  chunk.source === "sessions"
    ? (params.sessionTimeDecayLambda ?? params.timeDecayLambda)
    : (params.memoryTimeDecayLambda ?? params.timeDecayLambda);
```

Session transcripts decay faster (conversations age quickly), memory files decay slower (documentation is durable).

---

## Phase 4: Evolver Integration

### 4.1 Extended ContextParams

**File**: `src/agents/dynamic-context.ts`

New evolver-tunable parameters:

| Parameter                   | Type      | Default | Description                                    |
| --------------------------- | --------- | ------- | ---------------------------------------------- |
| `utilizationPriorEnabled`   | `boolean` | `true`  | Enable/disable ranking prior                   |
| `utilizationPriorStrength`  | `number`  | `0.3`   | Adjustment magnitude [0, 1]                    |
| `utilizationMinSamples`     | `number`  | `3`     | Min observations before applying prior         |
| `utilizationThresholdBoost` | `number`  | `0.1`   | Max threshold increase when utilization is low |
| `l1MissRateThreshold`       | `number`  | `0.5`   | L1 miss rate above which chunk is served as L2 |
| `l2BudgetRatio`             | `number`  | `0.3`   | Max fraction of retrieval budget for L2 text   |
| `sessionTimeDecayLambda`    | `number`  | `0.02`  | Time decay for session source chunks           |
| `memoryTimeDecayLambda`     | `number`  | `0.005` | Time decay for memory source chunks            |
| `queryMaxChars`             | `number`  | `500`   | Search query extraction length                 |
| `querySourceMessages`       | `number`  | `1`     | Number of recent messages to derive query from |

### 4.2 New Evolver Signals

**File**: `src/evolver/gep/signals.ts`

| Signal                    | Trigger Condition                                      | Category    |
| ------------------------- | ------------------------------------------------------ | ----------- |
| `memory_low_utilization`  | Avg utilization rate < 0.3 over last 3+ sessions       | Opportunity |
| `memory_high_utilization` | Avg utilization rate > 0.8 over last 3+ sessions       | Stability   |
| `memory_high_l1_miss`     | Avg L1 miss rate > 0.4 over last 3+ sessions           | Repair      |
| `memory_noise_dominant`   | Ignored ratio > 0.7 over last 3+ sessions              | Opportunity |
| `memory_retrieval_gap`    | LLM called memory_search explicitly > 3 times recently | Opportunity |

These signals are extracted from `feedback.jsonl` entries with signal type `memory_session_utilization`.

### 4.3 Session-End Aggregation

**File**: `src/agents/pi-embedded-runner/run/attempt.ts`

At session close (or periodically), write an aggregated feedback entry:

```typescript
recordFeedback({
  type: "implicit",
  signal: "memory_session_utilization",
  session_id: sessionId,
  details: {
    injected_count: N,
    utilized_count: M,
    ignored_count: K,
    l1_miss_count: J,
    misleading_count: L,
    utilization_rate: M / N,
    l1_miss_rate: J / N,
    retrieval_gaps: G,         // memory_search tool calls
    avg_score_utilized: ...,
    avg_score_ignored: ...,
  },
  context_params_snapshot: currentParams,
});
```

The `context_params_snapshot` enables causal attribution: "under these parameters, this utilization rate was observed."

### 4.4 GEP Prompt Update

**File**: `src/evolver/gep/prompt.ts`

Update Section XI (Tunable Parameters) to include all new parameters with descriptions and valid ranges. The sandbox agent needs to know these levers exist.

---

## Phase 5: Gene Definitions

**File**: workspace asset `evolver/assets/gep/genes.json`

### gene_memory_reduce_noise

```json
{
  "type": "Gene",
  "id": "gene_memory_reduce_noise",
  "category": "optimize",
  "signals_match": ["memory_low_utilization", "memory_noise_dominant"],
  "strategy": [
    "Read recent memory_session_utilization feedback entries from feedback.jsonl",
    "Compare utilization rates across different context_params_snapshot values",
    "If utilization_rate < 0.3: increase baseThreshold by 0.03-0.05",
    "If noise_ratio > 0.7: increase utilizationThresholdBoost by 0.02",
    "Write updated context_params.json"
  ],
  "constraints": { "max_files": 1, "forbidden_paths": ["src/"] },
  "validation": ["pnpm vitest run src/memory", "pnpm vitest run src/agents/dynamic-context"]
}
```

### gene_memory_l1_upgrade

```json
{
  "type": "Gene",
  "id": "gene_memory_l1_upgrade",
  "category": "repair",
  "signals_match": ["memory_high_l1_miss"],
  "strategy": [
    "Read recent memory_session_utilization feedback entries",
    "If avg l1_miss_rate > 0.4: lower l1MissRateThreshold by 0.05-0.1",
    "If l2BudgetRatio < 0.4: raise to 0.4",
    "Write updated context_params.json"
  ],
  "constraints": { "max_files": 1 },
  "validation": ["pnpm vitest run src/memory"]
}
```

### gene_memory_decay_tune

```json
{
  "type": "Gene",
  "id": "gene_memory_decay_tune",
  "category": "optimize",
  "signals_match": ["memory_low_utilization", "memory_retrieval_gap"],
  "strategy": [
    "Analyze feedback: compare avg_score_utilized vs avg_score_ignored",
    "If session chunks are mostly ignored: increase sessionTimeDecayLambda",
    "If memory chunks are mostly utilized: decrease memoryTimeDecayLambda",
    "Write updated context_params.json"
  ],
  "constraints": { "max_files": 1 },
  "validation": ["pnpm vitest run src/agents/dynamic-context"]
}
```

---

## Legacy Code Cleanup (alongside implementation)

| Item                                               | File                        | Action                                           |
| -------------------------------------------------- | --------------------------- | ------------------------------------------------ |
| `l0_abstract`, `l1_overview`, `l1_status` (chunks) | `memory-schema.ts:103-105`  | Remove `ensureColumn` calls                      |
| `l0_abstract`, `l0_embedding` (files)              | `memory-schema.ts:106-107`  | Remove `ensureColumn` calls                      |
| `searchVectorFiles()`                              | `manager-search.ts:369-412` | Delete function                                  |
| `searchKeywordFiles()`                             | `manager-search.ts:417-456` | Delete function                                  |
| `files_fts` write path                             | `manager.ts:1861-1870`      | Delete dead writes                               |
| File-level L0/embedding generation                 | `manager.ts:1829-1891`      | Delete dead computation                          |
| `filesFts` field in manager                        | `manager.ts`                | Remove field and all refs                        |
| `_params` unused parameter                         | `dynamic-context.ts:302`    | Remove underscore, use or drop                   |
| `emitThresholdFeedback()` + types                  | `dimension-hooks.ts`        | Delete dead feature                              |
| `loggingDimensionHooks`                            | `dimension-hooks.ts`        | Keep only in test, unexport                      |
| `noopDimensionHooks`                               | `dimension-hooks.ts`        | Keep only in test, unexport                      |
| `getDimensionHooks` / `registerDimensionHooks`     | `dimension-hooks.ts`        | Keep only in test, unexport                      |
| `detectImplicitFeedback()` system                  | `feedback-collector.ts`     | Revive: integrate into attempt.ts post-turn hook |
| `recordExplicitFeedback()`                         | `feedback-collector.ts`     | Keep (will be used by future UI)                 |
| `aggregateFeedbackSignals()`                       | `feedback-collector.ts`     | Revive: used by new memory signals in signals.ts |

---

## Complete Parameter Reference

### Existing (already evolver-tunable)

| Parameter                   | Current Default | Controls                                    |
| --------------------------- | --------------- | ------------------------------------------- |
| `baseThreshold`             | `0.72`          | Min similarity score for chunk inclusion    |
| `thresholdFloor`            | `0.5`           | Fallback threshold when nothing passes base |
| `timeDecayLambda`           | `0.01`          | Global time decay rate (hours⁻¹)            |
| `recentRatioBase`           | `0.4`           | Budget split: recent messages vs retrieval  |
| `recentRatioMin`            | `0.2`           | Min recent ratio bound                      |
| `recentRatioMax`            | `0.7`           | Max recent ratio bound                      |
| `hybridVectorWeight`        | `0.7`           | Vector vs keyword blend                     |
| `hybridMinScore`            | `0.01`          | Hybrid search floor                         |
| `mmrLambda`                 | `0.6`           | MMR relevance vs diversity                  |
| `redundancyThreshold`       | `0.95`          | Write-side dedup similarity                 |
| `progressiveLoadingEnabled` | `true`          | Progressive chunk loading                   |
| `latentFactorEnabled`       | `true`          | Multi-factor search                         |
| `factorActivationThreshold` | `0.35`          | Factor softmax gate                         |
| `factorMmrLambda`           | `0.7`           | Factor selection diversity                  |

### New (this design)

| Parameter                   | Default | Controls                                     |
| --------------------------- | ------- | -------------------------------------------- |
| `utilizationPriorEnabled`   | `true`  | Enable utilization-based ranking adjustment  |
| `utilizationPriorStrength`  | `0.3`   | Magnitude of ranking adjustment [0,1]        |
| `utilizationMinSamples`     | `3`     | Min observations before applying prior       |
| `utilizationThresholdBoost` | `0.1`   | Max threshold increase under low utilization |
| `l1MissRateThreshold`       | `0.5`   | L1→L2 upgrade trigger                        |
| `l2BudgetRatio`             | `0.3`   | Max retrieval budget fraction for L2         |
| `sessionTimeDecayLambda`    | `0.02`  | Session-specific decay rate                  |
| `memoryTimeDecayLambda`     | `0.005` | Memory-specific decay rate                   |
| `queryMaxChars`             | `500`   | Search query truncation length               |
| `querySourceMessages`       | `1`     | Messages used for query derivation           |

---

## Complete Signal Reference

### Existing (evolver already processes)

| Signal                   | Source                | Category        |
| ------------------------ | --------------------- | --------------- |
| `log_error`              | Session transcript    | Defensive       |
| `errsig:*`               | Error normalization   | Defensive       |
| `user_feature_request`   | User message analysis | Opportunity     |
| `user_correction`        | User message analysis | Robustness      |
| `stable_success_plateau` | Evolution history     | Opportunity     |
| Factor hit/miss          | `dimension-hooks.ts`  | Online learning |

### New (this design)

| Signal                    | Source                          | Trigger                              | Category    |
| ------------------------- | ------------------------------- | ------------------------------------ | ----------- |
| `memory_low_utilization`  | `feedback.jsonl` aggregation    | Avg rate < 0.3 over 3+ sessions      | Opportunity |
| `memory_high_utilization` | `feedback.jsonl` aggregation    | Avg rate > 0.8 over 3+ sessions      | Stability   |
| `memory_high_l1_miss`     | `feedback.jsonl` aggregation    | Avg L1 miss > 0.4 over 3+ sessions   | Repair      |
| `memory_noise_dominant`   | `feedback.jsonl` aggregation    | Ignored ratio > 0.7 over 3+ sessions | Opportunity |
| `memory_retrieval_gap`    | `memory_search` tool call count | > 3 explicit searches recently       | Opportunity |

---

## Utilization Events

| Event        | Meaning                                        | Signal Source           |
| ------------ | ---------------------------------------------- | ----------------------- |
| `injected`   | Chunk was placed in `<memory-context>`         | Extension context event |
| `utilized`   | LLM output contains phrases from chunk snippet | Post-turn attribution   |
| `ignored`    | Chunk injected but no evidence of use          | Post-turn attribution   |
| `l1_miss`    | LLM called `memory_get(chunkId)` for full text | Tool call interception  |
| `misleading` | Chunk injected, then user corrected LLM        | Feedback correlation    |

---

## Implementation Order

```
Phase 0: Legacy cleanup
  → Remove dead code, clean interfaces
  → Zero behavioral change, pure cleanup

Phase 1: State infrastructure
  → Runtime type extension
  → SQL schema addition
  → utilization.ts module
  → Zero behavioral change, only new tables/types

Phase 2: Signal collection
  → Post-turn attribution hook in attempt.ts
  → Record to chunk_utilization table
  → Session-end aggregation to feedback.jsonl
  → Zero behavioral change, only writes data

  *** Deploy, observe 1-2 weeks ***

Phase 3: Feedback flow
  → Adaptive threshold (continuous, no magic numbers)
  → Ranking prior (soft, multiplicative)
  → L1/L2 selection (per-chunk, data-driven)
  → Per-source time decay
  → Behavioral change: retrieval quality improves

Phase 4: Evolver integration
  → New context params exposed
  → New signal types in signals.ts
  → GEP prompt updated
  → Evolver can now self-optimize memory parameters

Phase 5: Gene definitions
  → Workspace assets, evolver-maintainable
  → Evolver begins autonomous optimization
```

---

## File Change Summary

| File                                                    | Phase | Change                                             |
| ------------------------------------------------------- | ----- | -------------------------------------------------- |
| `src/memory/memory-schema.ts`                           | 0+1   | Remove legacy columns, add chunk_utilization table |
| `src/memory/manager.ts`                                 | 0+3   | Remove dead file-level code, add utilization prior |
| `src/memory/manager-search.ts`                          | 0     | Remove dead file search functions                  |
| `src/memory/utilization.ts`                             | 1     | **New file**: record/query utilization data        |
| `src/memory/types.ts`                                   | 1     | Add utilization types                              |
| `src/agents/pi-extensions/dynamic-context/runtime.ts`   | 1     | Extend runtime type                                |
| `src/agents/pi-extensions/dynamic-context/extension.ts` | 1+3   | Record injected chunks, adaptive threshold, L1/L2  |
| `src/agents/session-factory.ts`                         | 1     | Initialize lastInjectedChunks                      |
| `src/agents/dynamic-context.ts`                         | 3+4   | Per-source decay, new ContextParams fields         |
| `src/agents/pi-embedded-runner/run/attempt.ts`          | 2     | Post-turn attribution hook                         |
| `src/agents/tools/memory-tool.ts`                       | 2     | Record memory_search as retrieval gap              |
| `src/evolver/dimension-hooks.ts`                        | 0     | Remove dead threshold feedback system              |
| `src/evolver/gep/signals.ts`                            | 4     | New memory signal types                            |
| `src/evolver/gep/feedback-collector.ts`                 | 0+2   | Revive detectImplicitFeedback integration          |
| `src/evolver/gep/prompt.ts`                             | 4     | Update tunable params documentation                |
| `evolver/assets/gep/genes.json`                         | 5     | New memory optimization genes                      |
