# CLAUDE.md — Verso Multi-Agent Orchestration Plan

## Project Overview

Verso is a self-evolving personal AI assistant platform with multi-channel messaging support (Telegram, Discord, Slack, WhatsApp, Feishu). TypeScript ESM, Node.js >= 22.12.0, pnpm monorepo.

## Current Task: Multi-Agent Orchestration System

Build a multi-agent collaboration system where an Orchestrator agent decomposes complex tasks into subtasks, dispatches them to parallel Worker agents, runs acceptance tests, and loops on failures.

### Key Decisions

- Workers share the orchestrator's workspace (same directory, no worktree isolation)
- Auto-trigger: agent automatically decides whether to use orchestration based on task complexity
- Full UI redesign: orchestration-centric layout, not just a new tab

### Architecture

```
User sends task → Agent decides complexity
  simple → execute directly (unchanged)
  complex → orchestrate tool:
    1. create-plan → subtasks with acceptance criteria
    2. dispatch → spawn parallel workers (shared workspace)
    3. poll-status → wait for workers
    4. run-acceptance → verify cmd + LLM criteria check
    5. pass → notify user / fail → create fix tasks → re-dispatch (max 3 cycles)
```

### Data Model (src/orchestration/types.ts)

- `Orchestration`: id, userPrompt, status (planning|dispatching|running|acceptance|fixing|completed|failed), plan (subtasks[]), fixTasks[], acceptanceResults[], maxFixCycles
- `Subtask`: id, title, description, acceptanceCriteria[], status, workerSessionKey, dependsOn[], retryCount
- `AcceptanceResult`: passed, verdicts[] (per-subtask pass/fail), summary
- `FixTask`: id, sourceSubtaskId, description, status

### State Machine

```
Orchestration: planning → dispatching → running → acceptance → completed
                                                      │ (fail)
                                                    fixing → running → acceptance → ...
                                                      │ (max cycles)       │ (pass)
                                                    failed              completed

Subtask: pending → running → completed | failed → retry → pending | cancelled
```

### Implementation Phases

**Phase 1: Core Data Layer**

- `src/orchestration/types.ts` — data models
- `src/orchestration/store.ts` — JSON persistence (~/.verso/orchestrations/<id>.json)

**Phase 2: Orchestrator Tools**

- `src/orchestration/orchestrator-tools.ts` — single `orchestrate` tool with actions: create-plan, dispatch, check-status, run-acceptance, create-fix-tasks, complete, abort
- `src/orchestration/orchestrator-prompt.ts` — system prompt fragment for orchestration awareness
- `src/orchestration/worker-prompt.ts` — worker extraSystemPrompt template
- `src/orchestration/acceptance.ts` — verify cmd + LLM criteria evaluation
- `src/orchestration/events.ts` — gateway event broadcasting

**Phase 3: Auto-Trigger**

- `src/orchestration/auto-detect.ts` — LLM-based complexity judgment (prompt heuristics, not code rules)

**Phase 4: Gateway Integration**

- `src/gateway/server-methods/orchestration.ts` — RPC: orchestration.list/.get/.create/.abort/.retry
- Modify `src/gateway/server-methods-list.ts` — add methods + events
- Modify `src/gateway/server-methods.ts` — register handlers

**Phase 5: Agent Runtime Wiring**

- Modify `src/agents/verso-tools.ts` — register orchestrate tool
- Modify `src/config/types.agents.ts` — add orchestration config to AgentConfig

**Phase 6: UI Redesign**

- `ui/src/ui/layouts/orchestration-layout.ts` — new top-level layout (sidebar + main)
- `ui/src/ui/views/orchestration-board.ts` — kanban task board
- `ui/src/ui/views/worker-panel.ts` — live worker streaming
- `ui/src/ui/components/task-card.ts` — subtask cards
- `ui/src/ui/components/acceptance-panel.ts` — acceptance results
- `ui/src/ui/components/orchestration-sidebar.ts` — chat input + orch list + nav
- `ui/src/ui/controllers/orchestration.ts` — gateway RPC calls
- `ui/src/ui/styles/orchestration.css` — styles
- Modify: `app.ts`, `app-render.ts`, `app-events.ts`, `navigation.ts`

### Key Patterns to Reuse

- `runAgentStep` + `callGateway("agent")` from `src/agents/tools/agent-step.ts`
- `setCommandLaneConcurrency` from `src/process/command-queue.ts` for parallel workers
- `spawnedBy` + `extraSystemPrompt` on `RunEmbeddedPiAgentParams`
- Evolver's verify/rollback pattern from `src/evolver/runner.ts`
- Cron job state machine from `src/cron/service.ts`
- Worker session keys: `agent:<agentId>:orch:<orchId>:w:<subtaskId>` (transient)
- Dynamic lanes: `orch:<orchId>` with configurable concurrency

### File Summary

| Category | New    | Modified   |
| -------- | ------ | ---------- |
| Core     | 7      | 2          |
| Gateway  | 1      | 2          |
| UI       | 8      | 4          |
| Total    | 17 new | 8 modified |

~2,800 lines of new code.

## Build & Test

```bash
pnpm build          # tsdown build
pnpm test           # parallel vitest (998 files, 6768 tests)
pnpm lint           # oxlint --type-aware
pnpm check          # tsgo + lint + format
```

## Key Directories

- `src/orchestration/` — NEW: orchestration system
- `src/agents/` — agent runtime, tools, dynamic context
- `src/gateway/` — HTTP/WS gateway server
- `src/evolver/` — self-evolution engine (GEP)
- `src/memory/` — vector memory (sqlite-vec)
- `src/process/` — command queue, lanes
- `ui/src/ui/` — Lit web components UI
- `skills/` — 65+ markdown skill files
- `extensions/` — 22 plugin extensions
