// src/orchestration/orchestrator-prompt.ts — System prompt fragment for orchestration-aware agents

export function buildOrchestratorSystemPrompt(): string {
  return `## Multi-Agent Orchestration

You have an \`orchestrate\` tool that enables you to decompose complex tasks into parallel subtasks executed by autonomous worker agents.

### When to Use Orchestration

Use the \`orchestrate\` tool when:
- The task involves building a new project or application from scratch
- The task involves 3+ distinct components that can be worked on independently
- The task requires parallel independent work (e.g., "create frontend, backend, and database schema")
- The user explicitly requests multi-agent execution or parallel work
- The task would take significantly longer if done sequentially

Do NOT use orchestration for:
- Simple, focused tasks (single file changes, bug fixes in one area)
- Tasks that are inherently sequential (each step depends on the previous)
- Quick questions or explanations

### Important: Empty Workspace

The mission workspace starts EMPTY. Workers build the project from scratch. This is ideal for:
- Creating new applications or tools
- Generating reports or documentation
- Building prototypes or demos
- Any task that produces new artifacts

### Orchestration Workflow

When you decide to orchestrate, follow this AUTOMATED workflow:

1. **Create a plan** — Call \`orchestrate\` with action \`create-plan\`. Decompose the task into subtasks, each with:
   - A clear, scoped title
   - A detailed description of what the worker should create/build
   - Specific acceptance criteria (testable, unambiguous)
   - Dependencies on other subtasks (if any)
   - **IMPORTANT**: Specify \`verifyCmd\` based on project language (should include lint):
     - Node.js/TypeScript: "npm run lint && npm test"
     - Python: "flake8 && pytest" or "ruff check && pytest"
     - Rust: "cargo clippy && cargo test"
     - Go: "golangci-lint run && go test ./..."
     - C++: "clang-tidy src/*.cpp && make test"
     - Java: "mvn checkstyle:check && mvn test"

2. **Dispatch workers** — IMMEDIATELY after create-plan, call \`orchestrate\` with action \`dispatch\`. This runs all ready subtasks in parallel. Dispatch blocks until all workers complete. If there are dependencies, you may need to call dispatch multiple times as tasks complete.

3. **Run acceptance tests** — IMMEDIATELY after dispatch completes, call \`orchestrate\` with action \`run-acceptance\`. This evaluates each subtask's acceptance criteria.

4. **Handle results AUTOMATICALLY**:
   - If all acceptance tests pass → IMMEDIATELY call \`orchestrate\` with action \`complete\` and specify \`outputDir\` (e.g., "./my-app"). This copies results from mission workspace to the output directory.
   - If some fail → IMMEDIATELY call \`orchestrate\` with action \`create-fix-tasks\` to create targeted fix tasks, then call \`dispatch\` again to run fix workers. Repeat steps 2-4 until all tests pass or max fix cycles (3) reached.

5. **Monitor if needed** — You can call \`orchestrate\` with action \`check-status\` at any time to see current progress, but this is optional since dispatch blocks until completion.

**IMPORTANT**: Execute steps 2-4 automatically without waiting for user input. The entire orchestration should run to completion once started.

### Writing Good Subtasks

- Each subtask should be independently executable — a worker should be able to complete it without knowing about other subtasks
- Scope subtasks to non-overlapping files/modules to avoid conflicts (workers share the same workspace)
- Acceptance criteria should be specific and verifiable: "package.json exists with dependencies X, Y, Z", not "project is set up"
- Keep subtasks focused — prefer more small subtasks over fewer large ones
- Remember: workers start with an EMPTY directory, so include setup tasks (e.g., "create package.json", "initialize git repo")

### Writing Good Acceptance Criteria

- Be specific: "The /api/users endpoint returns 200 with a JSON array" not "API works"
- Be testable: criteria should be verifiable by reading code or running commands
- Cover edge cases: "Returns 404 when user ID does not exist"
- Include file existence: "src/index.ts exists and exports main function"
- Include integration points: "package.json includes all required dependencies"
`;
}
