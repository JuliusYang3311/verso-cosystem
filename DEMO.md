# Verso Multi-Agent Orchestration Demo

## 🎯 Demo Scenario: Build a Full-Stack Blog Application

This demo shows how Verso's multi-agent orchestration can build a complete application from scratch in parallel.

### Command

```
Create a blog application with:
- React + TypeScript frontend with Vite
- Express + TypeScript backend with REST API
- PostgreSQL database schema
- Docker Compose setup
- Full CRUD operations for posts
- User authentication
```

### What Happens

1. **Orchestrator Agent** decomposes the task into 6 parallel subtasks:
   - `t1`: Frontend setup (React + Vite + TypeScript)
   - `t2`: Backend setup (Express + TypeScript + API routes)
   - `t3`: Database schema (PostgreSQL migrations)
   - `t4`: Docker Compose configuration
   - `t5`: Authentication middleware
   - `t6`: Integration tests

2. **Worker Agents** execute in parallel:
   - Each worker gets an isolated sandbox
   - Workers share the mission workspace
   - Changes are merged back after completion

3. **Acceptance Testing**:
   - Mechanical: `npm run lint && npm test` in both frontend and backend
   - LLM evaluation: Checks each acceptance criterion
   - Verifies node_modules exists, scripts work, tests pass

4. **Auto-Fix Cycles** (if needed):
   - If tests fail, orchestrator creates targeted fix tasks
   - Fix workers address specific issues
   - Repeats until all tests pass (max 30 cycles)

5. **Output**:
   - Complete project copied to `./blog-app/`
   - Ready to run with `docker-compose up`

### Performance

- **Sequential execution**: ~30-40 minutes
- **Parallel execution with Verso**: ~8-12 minutes
- **Speedup**: 3-4x faster

### Key Features Demonstrated

✅ **True Parallelism** - Workers run simultaneously, not sequentially
✅ **Automatic Retry** - Failed tasks are automatically fixed
✅ **Strict Validation** - Both mechanical and LLM-based acceptance testing
✅ **Resource Efficient** - In-memory sessions, no gateway pollution
✅ **Production Ready** - Generates working, tested code

## 🚀 Try It Yourself

```bash
# Start Verso
pnpm verso gateway run

# In the UI, send the orchestration command
# Watch the orchestration board for real-time progress
# Check the output directory when complete
```

## 📊 Comparison with Other Tools

| Feature                 | Verso | AutoGPT | CrewAI | LangGraph |
| ----------------------- | ----- | ------- | ------ | --------- |
| True Parallel Execution | ✅    | ❌      | ⚠️     | ⚠️        |
| Automatic Fix Cycles    | ✅    | ❌      | ❌     | ❌        |
| Dual Acceptance Testing | ✅    | ❌      | ❌     | ❌        |
| Empty Workspace Design  | ✅    | ❌      | ❌     | ❌        |
| In-Memory Sessions      | ✅    | N/A     | N/A    | N/A       |
| Real-time UI            | ✅    | ⚠️      | ❌     | ❌        |

## 🎥 Video Demo

[Coming soon - link to YouTube demo]

## 📝 Blog Post

[Coming soon - link to detailed technical writeup]
