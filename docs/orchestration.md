# Verso Multi-Agent Orchestration System

## Overview

The Verso Orchestration System enables complex, multi-step software development tasks to be automatically decomposed and executed by parallel AI agents. An Orchestrator agent breaks down tasks into subtasks, dispatches Worker agents to execute them in parallel, runs acceptance tests, and automatically fixes issues through iterative cycles.

## Key Features

- **Automatic Task Decomposition**: Complex tasks are intelligently broken down into manageable subtasks
- **Parallel Execution**: Multiple Worker agents execute subtasks concurrently
- **Acceptance Testing**: Automated verification with both mechanical tests and LLM-based criteria evaluation
- **Self-Healing**: Automatic fix cycles when tests fail (up to 3 cycles by default)
- **Isolated Workspaces**: Each orchestration runs in its own isolated environment
- **Shared Memory**: Orchestrator and Workers share a temporary memory system for context
- **Background Execution**: Runs as a daemon without blocking your main agent session

## Architecture

```
User → Main Agent → Orchestrator Tool → Daemon Queue
                                           ↓
                                    Orchestrator Daemon
                                           ↓
                                    Orchestrator Agent
                                      ↙    ↓    ↘
                                Worker  Worker  Worker
                                      ↘    ↓    ↙
                                    Acceptance Tests
                                           ↓
                                    Output Directory
```

### Components

1. **Main Agent**: Your primary AI assistant that decides when to use orchestration
2. **Orchestrator Daemon**: Background process that manages orchestration tasks
3. **Orchestrator Agent**: Decomposes tasks, coordinates workers, runs acceptance tests
4. **Worker Agents**: Execute individual subtasks in parallel
5. **Mission Workspace**: Isolated directory where workers build the project (`.verso-missions/<orchId>/`)
6. **Shared Memory**: Temporary memory system shared between orchestrator and workers
7. **Output Directory**: Final project location (`.verso-output/<orchId>/`)

## When to Use Orchestration

The Main Agent automatically decides when to use orchestration based on task complexity. Orchestration is ideal for:

### ✅ Good Use Cases

- **Multi-file projects**: Building complete applications from scratch
- **Complex features**: Features requiring multiple components (backend + frontend + tests)
- **Parallel work**: Tasks with independent subtasks that can run simultaneously
- **Quality-critical work**: Projects requiring automated testing and verification

Examples:

- "Build a REST API with Express, PostgreSQL, and authentication"
- "Create a React dashboard with charts, tables, and real-time updates"
- "Implement a CLI tool with multiple commands and comprehensive tests"

### ❌ Not Suitable For

- **Single-file changes**: Simple edits or bug fixes
- **Quick prototypes**: Throwaway code or experiments
- **Exploratory work**: Research or investigation tasks
- **Simple questions**: Information requests or explanations

## Workflow

### 1. Task Submission

```
User: "Build a todo app with React frontend and Express backend"
Main Agent: "I've started orchestration task abc123 to build your todo app.
             I'll notify you when it's complete."
```

The Main Agent calls the `orchestrator` tool which:

- Enqueues the request
- Auto-starts the daemon if not running
- Returns immediately with an orchestration ID

### 2. Planning Phase

The Orchestrator Agent:

- Analyzes the task requirements
- Decomposes into subtasks (e.g., "Setup Express server", "Create React app", "Add API routes")
- Determines acceptance criteria for each subtask
- Identifies project-specific verification commands (e.g., `npm test`, `npm run build`)

### 3. Execution Phase

Worker agents execute subtasks in parallel:

- Each worker gets its own sandbox (copy of mission workspace)
- Workers have access to shared memory for context
- Changes are copied back to mission workspace after completion
- Up to 4 workers run concurrently (configurable)

### 4. Acceptance Phase

Two-stage verification:

1. **Mechanical Verification**: Runs project-specific commands (tests, build, lint)
2. **LLM Evaluation**: Checks if acceptance criteria are met for each subtask

### 5. Fix Cycles (if needed)

If acceptance fails:

1. Orchestrator creates fix tasks for failed subtasks
2. Workers execute fixes
3. Acceptance tests run again
4. Repeats up to 3 cycles (configurable)

If max cycles exceeded, orchestration fails with detailed error report.

### 6. Completion

On success:

- Mission workspace copied to output directory (`.verso-output/<orchId>/`)
- Main Agent receives completion event
- User is notified with output path

On failure:

- Mission workspace cleaned up
- Error details saved in orchestration record
- User is notified with failure reason

## Configuration

### Agent Configuration

Edit your `config.json`:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "orchestration": {
          "enabled": true,
          "maxWorkers": 4,
          "maxFixCycles": 3,
          "maxOrchestrations": 2,
          "verifyCmd": ""
        }
      }
    ]
  }
}
```

**Options:**

- `enabled`: Enable/disable orchestration (default: `true`)
- `maxWorkers`: Maximum parallel workers (default: `4`)
- `maxFixCycles`: Maximum fix retry cycles (default: `3`)
- `maxOrchestrations`: Maximum concurrent orchestrations (default: `2`)
- `verifyCmd`: Default verification command (default: `""` = LLM-only)

### Environment Variables

```bash
# Daemon configuration
ORCHESTRATOR_WORKSPACE=/path/to/workspace
ORCHESTRATOR_AGENT_ID=main
ORCHESTRATOR_MAX_WORKERS=4
ORCHESTRATOR_MAX_FIX_CYCLES=3
ORCHESTRATOR_MAX_ORCHESTRATIONS=2
ORCHESTRATOR_VERIFY_CMD=""

# Model override (optional)
ORCHESTRATOR_MODEL=anthropic/claude-sonnet-4-20250514
```

## Memory System

Each orchestration has an isolated memory system with full feature parity to the main agent:

### Features

- **Embedding-based search**: Vector similarity search
- **Latent factors**: Semantic clustering
- **MMR (Maximal Marginal Relevance)**: Diverse result selection
- **Three-layer memory**: L0 (recent), L1 (important), chunks (all)
- **Hybrid search**: Vector + BM25 text search
- **File watching**: Auto-ingests `MEMORY.md` files

### Memory Sources

1. **Session History**: Chat messages between orchestrator and workers
2. **Memory Documents**: Optional `MEMORY.md` files created by agents

### Lifecycle

```
Init → Create isolated MemoryIndexManager
     → SQLite DB: .verso-missions/<orchId>/memory/memory.sqlite
     → Watch for MEMORY.md files
     → Shared via MEMORY_DIR env var
     ↓
Execution → Orchestrator and workers use shared memory
          → Optional: agents create MEMORY.md for notes
          → Auto-ingested via file watcher
     ↓
Cleanup → Close memory manager (releases DB, watchers)
        → Delete entire memory directory
        → No impact on main agent's memory
```

## Monitoring

### Check Daemon Status

```bash
# Check if daemon is running
ps aux | grep orchestrator-daemon

# View daemon logs
tail -f ~/.verso/logs/orchestrator-daemon.log
```

### List Orchestrations

Via Main Agent:

```
User: "Show my orchestrations"
Main Agent: [Lists recent orchestrations with status]
```

Via Gateway API:

```bash
curl -X POST http://localhost:18989/rpc \
  -H "Content-Type: application/json" \
  -d '{"method": "orchestration.list", "params": {}}'
```

### Get Orchestration Details

```bash
curl -X POST http://localhost:18989/rpc \
  -H "Content-Type: application/json" \
  -d '{"method": "orchestration.get", "params": {"id": "abc123"}}'
```

## Management

### Abort Running Orchestration

Via Main Agent:

```
User: "Abort orchestration abc123"
```

Via Gateway API:

```bash
curl -X POST http://localhost:18989/rpc \
  -H "Content-Type: application/json" \
  -d '{"method": "orchestration.abort", "params": {"id": "abc123"}}'
```

### Delete Orchestration

```bash
curl -X POST http://localhost:18989/rpc \
  -H "Content-Type: application/json" \
  -d '{"method": "orchestration.delete", "params": {"id": "abc123"}}'
```

### Retry Failed Orchestration

```bash
curl -X POST http://localhost:18989/rpc \
  -H "Content-Type: application/json" \
  -d '{"method": "orchestration.retry", "params": {"id": "abc123"}}'
```

## File Structure

```
.verso-missions/
└── <orchId>/                    # Mission workspace (temporary)
    ├── memory/                  # Shared memory
    │   ├── memory.sqlite        # Isolated SQLite DB
    │   └── MEMORY.md            # Optional agent notes
    └── [project files]          # Built by workers

.verso-output/
└── <orchId>/                    # Output directory (permanent)
    └── [completed project]      # Copied from mission workspace

~/.verso/
├── state/
│   ├── orchestrations/          # Orchestration records
│   │   └── <orchId>.json
│   └── orchestrator-queue.json  # Pending requests
└── logs/
    └── orchestrator-daemon.log  # Daemon logs
```

## Troubleshooting

### Daemon Not Starting

1. Check logs: `tail -f ~/.verso/logs/orchestrator-daemon.log`
2. Verify configuration: `cat ~/.verso/config.json`
3. Check for port conflicts
4. Ensure Node.js >= 22.12.0

### Orchestration Stuck

1. Check daemon status: `ps aux | grep orchestrator-daemon`
2. View orchestration details: `orchestration.get` API
3. Check worker logs in mission workspace
4. Abort if needed: `orchestration.abort` API

### Workers Failing

Common causes:

- **Dependency issues**: Workers start with empty workspace, may need to install dependencies
- **Memory issues**: Increase `maxWorkers` limit or reduce concurrent orchestrations
- **Timeout**: Complex subtasks may need more time
- **API rate limits**: Too many parallel API calls

Solutions:

- Check worker error messages in orchestration record
- Review acceptance test results
- Adjust `maxWorkers` and `maxFixCycles` in config
- Use `verifyCmd` for faster mechanical verification

### Memory Issues

If memory cleanup fails:

```bash
# Manual cleanup
rm -rf .verso-missions/<orchId>/memory
```

If SQLite DB is locked:

```bash
# Find and kill processes using the DB
lsof | grep memory.sqlite
kill <pid>
```

## Best Practices

### Task Descriptions

✅ **Good**: Clear, specific, with context

```
"Build a REST API for a blog platform with:
- User authentication (JWT)
- CRUD endpoints for posts and comments
- PostgreSQL database
- Express.js framework
- Comprehensive tests"
```

❌ **Bad**: Vague, ambiguous

```
"Make an API"
```

### Acceptance Criteria

The Orchestrator automatically determines acceptance criteria, but you can guide it:

```
"Build a React dashboard with:
- Real-time data updates (WebSocket)
- Charts using Chart.js
- Responsive design
- Must pass: npm test, npm run build, npm run lint"
```

### Verification Commands

For faster feedback, specify verification commands:

```json
{
  "orchestration": {
    "verifyCmd": "npm test && npm run build && npm run lint"
  }
}
```

### Resource Management

- Limit concurrent orchestrations to avoid resource exhaustion
- Use appropriate `maxWorkers` based on your system (default: 4)
- Monitor memory usage during large orchestrations
- Clean up failed orchestrations regularly

## API Reference

### Gateway RPC Methods

#### `orchestration.list`

List orchestrations with optional filtering.

**Request:**

```json
{
  "method": "orchestration.list",
  "params": {
    "status": "running", // optional: filter by status
    "limit": 50 // optional: max results (default: 50)
  }
}
```

**Response:**

```json
{
  "success": true,
  "result": {
    "orchestrations": [
      {
        "id": "abc123",
        "userPrompt": "Build a todo app...",
        "status": "running",
        "subtaskCount": 5,
        "fixCycle": 0,
        "maxFixCycles": 3,
        "createdAtMs": 1234567890,
        "updatedAtMs": 1234567900
      }
    ]
  }
}
```

#### `orchestration.get`

Get detailed orchestration information.

**Request:**

```json
{
  "method": "orchestration.get",
  "params": {
    "id": "abc123"
  }
}
```

**Response:**

```json
{
  "success": true,
  "result": {
    "orchestration": {
      "id": "abc123",
      "userPrompt": "Build a todo app",
      "status": "completed",
      "plan": {
        "summary": "Create todo app with React and Express",
        "subtasks": [...]
      },
      "acceptanceResults": [...],
      "completedAtMs": 1234567999
    }
  }
}
```

#### `orchestration.abort`

Abort a running orchestration.

**Request:**

```json
{
  "method": "orchestration.abort",
  "params": {
    "id": "abc123"
  }
}
```

#### `orchestration.delete`

Delete an orchestration record.

**Request:**

```json
{
  "method": "orchestration.delete",
  "params": {
    "id": "abc123"
  }
}
```

#### `orchestration.retry`

Get instructions to retry a failed orchestration.

**Request:**

```json
{
  "method": "orchestration.retry",
  "params": {
    "id": "abc123"
  }
}
```

### Gateway Events

The system broadcasts real-time events:

- `orchestration.started`: Orchestration begins
- `orchestration.completed`: Orchestration succeeds
- `orchestration.failed`: Orchestration fails
- `orchestration.updated`: Status update
- `orchestration.subtask`: Subtask status change

## Examples

### Example 1: REST API

**User Request:**

```
"Build a REST API for a bookstore with Express, PostgreSQL, and JWT auth"
```

**Orchestrator Plan:**

```
Subtasks:
1. Setup Express server with middleware
2. Configure PostgreSQL connection
3. Implement JWT authentication
4. Create book CRUD endpoints
5. Add user management endpoints
6. Write integration tests
7. Add API documentation

Verify: npm test && npm run build
```

**Output:**

```
.verso-output/abc123/
├── src/
│   ├── server.js
│   ├── auth/
│   ├── routes/
│   └── models/
├── tests/
├── package.json
└── README.md
```

### Example 2: React Dashboard

**User Request:**

```
"Create a React dashboard with charts, tables, and real-time updates"
```

**Orchestrator Plan:**

```
Subtasks:
1. Setup React app with TypeScript
2. Implement layout and navigation
3. Add Chart.js integration
4. Create data table component
5. Setup WebSocket for real-time updates
6. Add responsive styling
7. Write component tests

Verify: npm test && npm run build
```

**Output:**

```
.verso-output/def456/
├── src/
│   ├── components/
│   ├── hooks/
│   ├── services/
│   └── App.tsx
├── tests/
├── package.json
└── README.md
```

## FAQ

**Q: How long does orchestration take?**
A: Depends on task complexity. Simple projects: 5-10 minutes. Complex projects: 20-30 minutes.

**Q: Can I use orchestration for existing projects?**
A: Orchestration starts with an empty workspace. For existing projects, use the main agent directly.

**Q: What happens if my computer restarts?**
A: The daemon stops. Restart it manually or it will auto-start on next orchestration request. In-progress orchestrations are lost.

**Q: Can I customize the Orchestrator's behavior?**
A: Yes, via configuration (maxWorkers, maxFixCycles, verifyCmd) and by providing detailed task descriptions.

**Q: How much does orchestration cost?**
A: Costs depend on your LLM provider. Orchestration uses multiple agents, so costs are higher than single-agent tasks. Monitor your API usage.

**Q: Can I see what workers are doing in real-time?**
A: Yes, via the UI (port 18989) or by monitoring the mission workspace directory.

**Q: What if acceptance tests keep failing?**
A: After 3 fix cycles (default), orchestration fails. Review the error details and retry with a more specific task description or adjusted acceptance criteria.

## Support

- **Issues**: https://github.com/your-org/verso/issues
- **Documentation**: https://verso.dev/docs
- **Community**: https://discord.gg/verso
