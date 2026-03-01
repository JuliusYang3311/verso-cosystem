# CLAUDE.md — Verso Multi-Agent Orchestration System

## Project Overview

Verso is a self-evolving personal AI assistant platform with multi-channel messaging support (Telegram, Discord, Slack, WhatsApp, Feishu). TypeScript ESM, Node.js >= 22.12.0, pnpm monorepo.

## Current Task: Multi-Agent Orchestration System

Build a multi-agent collaboration system where an Orchestrator daemon runs an Orchestrator agent that decomposes complex tasks into subtasks, dispatches them to parallel Worker agents, runs acceptance tests, and loops on failures.

## Architecture Design

### Key Decisions

1. **Daemon Mode**: Orchestrator runs as a detached background daemon (similar to Evolver), not occupying gateway sessions
2. **Multi-Agent Architecture**: Daemon runs multiple agents:
   - **Orchestrator Agent**: Main agent that uses `orchestrate` tool for task decomposition and verification
   - **Worker Agents**: Parallel agents that execute subtasks
3. **Empty Mission Workspace**: Each orchestration starts with an empty isolated workspace (`.verso-missions/<orchId>/`), workers build from scratch
4. **Shared Dynamic Memory**: Orchestrator and workers share a temporary memory instance for the duration of the task
5. **Resource Cleanup**: All memory, sandbox, and session resources are released after completion
6. **Gateway Events**: Completion notifications pushed to main agent session via gateway events

### Complete Workflow

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. User sends complex task to Main Agent                           │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. Main Agent decides task requires orchestration                  │
│    - Calls orchestrator tool (action: submit)                      │
│    - Request written to queue                                       │
│    - Daemon auto-starts if not running                             │
│    - Returns orchestrationId immediately                            │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. Main Agent notifies user                                        │
│    "Orchestration task abc123 submitted, processing in background" │
└─────────────────────────────────────────────────────────────────────┘

                    ┌────────────────────────┐
                    │  Orchestrator Daemon   │
                    │  (Detached Process)    │
                    └───────────┬────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. Daemon picks up request from queue                              │
│    a. Create empty mission workspace (.verso-missions/<orchId>/)   │
│    b. Initialize shared memory (orchestrator + workers)            │
│    c. Broadcast orchestration.started event                        │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 5. Daemon runs Orchestrator Agent                                  │
│    - Session key: agent:<agentId>:orch:<orchId>                    │
│    - Has access to orchestrate tool                                │
│    - Works in mission workspace                                    │
│    - Uses shared memory                                            │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 6. Orchestrator Agent: create-plan                                 │
│    - Calls orchestrate tool (action: create-plan)                  │
│    - LLM decomposes task into subtasks                             │
│    - Determines verifyCmd based on project type                    │
│    - Creates plan with acceptance criteria                         │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 7. Orchestrator Agent: dispatch                                    │
│    - Calls orchestrate tool (action: dispatch)                     │
│    - Worker pool spawns parallel workers                           │
│    - Each worker:                                                  │
│      • Session key: agent:<agentId>:orch:<orchId>:w:<subtaskId>   │
│      • Works in tmpdir sandbox (copy of mission workspace)         │
│      • Has access to shared memory (MEMORY_DIR env var)            │
│      • Executes subtask independently                              │
│      • Changes copied back to mission workspace                    │
│    - Workers run in parallel (up to maxWorkers)                    │
│    - Blocks until all workers complete                             │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 8. Orchestrator Agent: run-acceptance                              │
│    - Calls orchestrate tool (action: run-acceptance)               │
│    - Runs mechanical verification (verifyCmd)                      │
│    - LLM evaluates acceptance criteria for each subtask            │
│    - Returns pass/fail verdicts                                    │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                    ┌────────┴────────┐
                    │                 │
                    ▼                 ▼
            ┌───────────────┐  ┌──────────────┐
            │  Tests Pass   │  │  Tests Fail  │
            └───────┬───────┘  └──────┬───────┘
                    │                 │
                    │                 ▼
                    │         ┌──────────────────────────────────┐
                    │         │ Check fix cycle count            │
                    │         │ If < maxFixCycles (3):           │
                    │         │   - create-fix-tasks             │
                    │         │   - dispatch fix workers         │
                    │         │   - run-acceptance again         │
                    │         │ If >= maxFixCycles:              │
                    │         │   - Mark as failed               │
                    │         └──────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 9. Orchestrator Agent: complete                                    │
│    - Calls orchestrate tool (action: complete)                     │
│    - Copies mission workspace to output directory                  │
│    - Default: ./.verso-output/<orchId>/                            │
│    - Or user-specified path                                        │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 10. Daemon cleanup                                                 │
│     - Close shared memory manager                                  │
│     - Delete memory directory                                      │
│     - Delete mission workspace (if failed)                         │
│     - Dispose all worker sessions                                  │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 11. Daemon broadcasts gateway event                                │
│     - orchestration.completed (with outputPath)                    │
│     - OR orchestration.failed (with error)                         │
│     - Event pushed to main agent session                           │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 12. Main Agent receives event                                      │
│     - Notifies user with result                                    │
│     - "Orchestration abc123 completed! Project: ./my-app/"         │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Model (src/orchestration/types.ts)

```typescript
type Orchestration = {
  id: string;
  userPrompt: string;
  status: OrchestrationStatus; // planning|dispatching|running|acceptance|fixing|completed|failed
  orchestratorSessionKey: string;
  agentId: string;
  workspaceDir: string; // Mission workspace (.verso-missions/<orchId>/)
  sourceWorkspaceDir: string; // Original workspace
  plan?: OrchestrationPlan;
  fixTasks: FixTask[];
  acceptanceResults: AcceptanceResult[];
  maxFixCycles: number;
  currentFixCycle: number;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  error?: string;
};

type OrchestrationPlan = {
  summary: string;
  subtasks: Subtask[];
  verifyCmd?: string; // Project-specific verification command
};

type Subtask = {
  id: string; // t1, t2, t3, ...
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: TaskStatus; // pending|running|completed|failed|cancelled
  workerSessionKey?: string; // agent:<agentId>:orch:<orchId>:w:<subtaskId>
  runId?: string;
  dependsOn?: string[]; // IDs of tasks this depends on
  resultSummary?: string;
  error?: string;
  retryCount: number;
  createdAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
};

type AcceptanceResult = {
  passed: boolean;
  verdicts: AcceptanceVerdict[]; // Per-subtask pass/fail
  summary: string;
  testedAtMs: number;
};

type FixTask = {
  id: string; // fix-c1-1, fix-c1-2, ... (cycle-index)
  sourceSubtaskId: string;
  description: string;
  status: TaskStatus;
  workerSessionKey?: string;
  runId?: string;
  error?: string;
  createdAtMs: number;
  completedAtMs?: number;
};
```

### State Machine

```
Orchestration Status:
  planning → dispatching → running → acceptance → completed
                                        │ (fail)
                                      fixing → running → acceptance → ...
                                        │ (max cycles)     │ (pass)
                                      failed            completed

Subtask Status:
  pending → running → completed
              │
              └─→ failed → (retry) → pending
                    │
                    └─→ cancelled
```

### Memory Management

#### Shared Memory Architecture

```
Orchestration Memory Lifecycle:

1. Init (daemon-runner.ts):
   - Create memory dir: .verso-missions/<orchId>/memory/
   - Create MemoryIndexManager with unique agent ID: orch:<orchId>:<agentId>
   - Set env vars: MEMORY_DIR, VERSO_MEMORY_DIR

2. Orchestrator Agent:
   - Inherits memory env vars from daemon
   - Can store/retrieve context during task decomposition

3. Worker Agents (worker-runner.ts):
   - Save original MEMORY_DIR env vars
   - Set to shared memory dir before creating session
   - Worker can access shared memory during execution
   - Restore original env vars after cleanup

4. Cleanup (daemon-runner.ts finally block):
   - Close MemoryIndexManager (releases DB connections)
   - Delete memory directory recursively
   - All memory data is ephemeral, not persisted
```

#### Memory Isolation

- Each orchestration has its own isolated memory instance
- Memory is NOT shared across different orchestrations
- Memory is NOT shared with main agent
- Memory is completely cleaned up after orchestration completes

### File Structure

```
src/orchestration/
├── types.ts                      # Data models, state machine
├── store.ts                      # JSON persistence, workspace management
├── orchestrator.ts               # Daemon management (start/stop/status)
├── daemon-runner.ts              # Daemon loop, queue processing, agent execution
├── daemon-entry.ts               # Daemon process entry point
├── orchestrator-trigger-tool.ts  # Main agent tool for submitting requests
├── orchestrator-tools.ts         # Orchestrate tool (for orchestrator agent)
├── orchestrator-prompt.ts        # Orchestrator agent system prompt
├── orchestrator-memory.ts        # Shared memory management
├── orchestrator-llm.ts           # LLM interface (deprecated, using agent now)
├── worker-runner.ts              # Worker pool, parallel execution
├── worker-prompt.ts              # Worker agent system prompt
├── acceptance.ts                 # Acceptance testing (verify + LLM eval)
├── events.ts                     # Gateway event broadcasting
└── auto-detect.ts                # Complexity hints (optional)
```

### Implementation Status

#### ✅ Phase 1: Core Data Layer

- `types.ts` — Data models, state machine
- `store.ts` — JSON persistence, mission workspace management

#### ✅ Phase 2: Daemon Infrastructure

- `orchestrator.ts` — Daemon management (start/stop/status)
- `daemon-runner.ts` — Daemon loop, queue processing, orchestrator agent execution
- `daemon-entry.ts` — Daemon process entry point
- `orchestrator-trigger-tool.ts` — Main agent tool

#### ✅ Phase 3: Memory Management

- `orchestrator-memory.ts` — Shared memory creation/cleanup
- `worker-runner.ts` — Memory env var management in workers

#### ✅ Phase 4: Orchestrator Agent

- Uses existing `orchestrator-tools.ts` (orchestrate tool)
- Uses existing `orchestrator-prompt.ts` (system prompt)
- Daemon runs agent via `runAgentStep`

#### ✅ Phase 5: Worker Execution

- `worker-runner.ts` — Worker pool with task claiming pattern
- `worker-prompt.ts` — Worker system prompt
- Parallel execution with shared memory

#### ✅ Phase 6: Acceptance Testing

- ✅ `acceptance.ts` — Mechanical verification + LLM evaluation
- ✅ Integrated with orchestrator agent workflow via `run-acceptance` action
- ✅ Orchestrator Agent determines acceptance criteria during `create-plan`
- ✅ Two-stage verification: mechanical (verifyCmd) + LLM-based criteria evaluation
- ✅ Automatic fix cycle: create-fix-tasks → dispatch → run-acceptance (max 3 cycles)

#### ✅ Phase 7: Gateway Integration

- ✅ `events.ts` — Event broadcasting with chat.inject for notifications
- ✅ Gateway RPC methods (orchestration.list/.get/.abort/.delete/.retry/.broadcast)
- ✅ Event types registered (orchestration.started/.completed/.failed/.updated/.subtask)
- ✅ Event routing to main agent session via chat.inject

#### ✅ Phase 8: Main Agent Integration

- ✅ Tool registration in `verso-tools.ts`
- ✅ Tool description in `system-prompt.ts`
- ✅ System prompt guidance on when to use orchestration
- ✅ Event handler for completion notifications (via chat.inject)

#### ✅ Phase 9: UI

- ✅ Orchestration board (kanban view) - `ui/src/ui/views/orchestration-board.ts`
- ✅ Worker panels (live streaming) - `ui/src/ui/views/worker-panel.ts`
- ✅ Task cards - `ui/src/ui/components/task-card.ts`
- ✅ Acceptance results panel - `ui/src/ui/components/acceptance-panel.ts`
- ✅ Orchestration sidebar - `ui/src/ui/components/orchestration-sidebar.ts`
- ✅ Orchestration layout - `ui/src/ui/layouts/orchestration-layout.ts`
- ✅ Controller - `ui/src/ui/controllers/orchestration.ts`
- ✅ Styles - `ui/src/styles/orchestration.css`
- ✅ Navigation integration - Added "orchestration" tab
- ✅ Event handling - Real-time updates via gateway events

### Key Patterns Reused

1. **Evolver Patterns**:
   - Daemon management: `spawn()` with `detached: true`
   - Model/auth resolution: `resolveAgentModel()`
   - Tmpdir sandbox: `createTmpdirSandbox()`, `cleanupTmpdir()`
   - Git change detection: `git diff --name-only HEAD`

2. **Memory Patterns**:
   - Dynamic memory: `MemoryIndexManager.get()`
   - Unique agent ID per orchestration: `orch:<orchId>:<agentId>`
   - Env var propagation: `MEMORY_DIR`, `VERSO_MEMORY_DIR`

3. **Worker Patterns**:
   - In-memory sessions: `SessionManager.inMemory()`
   - Task claiming: `claimNext()` pattern
   - Parallel execution: `Promise.all()` with worker pool
   - Session keys: `agent:<agentId>:orch:<orchId>:w:<subtaskId>`

4. **Agent Patterns**:
   - Nested agents: `runAgentStep()` with `extraSystemPrompt`
   - Tool-based workflow: Orchestrator agent uses `orchestrate` tool
   - Dedicated lanes: `orch:<orchId>` for orchestration isolation

### Configuration

```typescript
// config.json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "orchestration": {
          "enabled": true,
          "maxWorkers": 4,           // Parallel worker limit
          "maxFixCycles": 3,         // Max retry cycles
          "maxOrchestrations": 2,    // Concurrent orchestration limit
          "verifyCmd": ""            // Default verification command (empty = LLM-only)
        }
      }
    ]
  }
}
```

### Environment Variables

```bash
# Daemon configuration
ORCHESTRATOR_WORKSPACE=/path/to/workspace
ORCHESTRATOR_AGENT_ID=main
ORCHESTRATOR_SESSION_KEY=agent:main
ORCHESTRATOR_MAX_WORKERS=4
ORCHESTRATOR_MAX_FIX_CYCLES=3
ORCHESTRATOR_MAX_ORCHESTRATIONS=2
ORCHESTRATOR_VERIFY_CMD=""

# Shared memory (set by daemon for orchestrator + workers)
MEMORY_DIR=/path/to/.verso-missions/<orchId>/memory
VERSO_MEMORY_DIR=/path/to/.verso-missions/<orchId>/memory
```

### Build & Test

```bash
pnpm build          # tsdown build
pnpm test           # parallel vitest
pnpm lint           # oxlint --type-aware
pnpm check          # tsgo + lint + format
```

### Next Steps

1. **Complete Gateway Integration**:
   - Implement event routing to main agent session
   - Add RPC methods (orchestration.list/.get/.abort)
   - Test event delivery

2. **Main Agent Guidance**:
   - Add system prompt section on when to use orchestration
   - Add event handler for completion notifications
   - Test end-to-end workflow

3. **Testing**:
   - Unit tests for daemon, memory, workers
   - Integration tests for full workflow
   - Test resource cleanup

4. **UI (Future)**:
   - Orchestration board
   - Live worker streaming
   - Task management interface

### Estimated Code Size

- Core: ~2,500 lines (implemented)
- Gateway: ~300 lines (pending)
- UI: ~2,000 lines (future)
- Total: ~4,800 lines
