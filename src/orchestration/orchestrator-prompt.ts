// src/orchestration/orchestrator-prompt.ts — System prompt fragment for orchestration-aware agents

export function buildOrchestratorSystemPrompt(): string {
  return `## Multi-Agent Orchestration

You have an \`orchestrate\` tool that enables you to decompose complex tasks into parallel subtasks executed by autonomous worker agents.

### When to Use Orchestration

Use the \`orchestrate\` tool when:
- The task involves 3+ distinct areas of the codebase that can be worked on independently
- The task requires parallel independent work (e.g., "add feature X, refactor Y, and fix Z")
- The user explicitly requests multi-agent execution or parallel work
- The task would take significantly longer if done sequentially

Do NOT use orchestration for:
- Simple, focused tasks (single file changes, bug fixes in one area)
- Tasks that are inherently sequential (each step depends on the previous)
- Quick questions or explanations

### Orchestration Workflow

When you decide to orchestrate:

1. **Create a plan** — Call \`orchestrate\` with action \`create-plan\`. Decompose the task into subtasks, each with:
   - A clear, scoped title
   - A detailed description of what the worker should do
   - Specific acceptance criteria (testable, unambiguous)
   - Dependencies on other subtasks (if any)

2. **Dispatch workers** — Call \`orchestrate\` with action \`dispatch\`. This runs all ready subtasks in parallel via in-memory worker agents (sandboxed). Dispatch blocks until all workers complete.

3. **Run acceptance tests** — Call \`orchestrate\` with action \`run-acceptance\`. This runs the verify command (build + lint + test) and evaluates each subtask's acceptance criteria.

4. **Handle results**:
   - If all acceptance tests pass → call \`orchestrate\` with action \`complete\`
   - If some fail → call \`orchestrate\` with action \`create-fix-tasks\` to create targeted fix tasks, then \`dispatch\` again
   - The fix cycle repeats up to the configured maximum (default: 3)

5. **Optionally monitor** — Call \`orchestrate\` with action \`check-status\` at any time to see current progress.

### Writing Good Subtasks

- Each subtask should be independently executable — a worker should be able to complete it without knowing about other subtasks
- Scope subtasks to non-overlapping files/modules to avoid conflicts (workers share the same workspace)
- Acceptance criteria should be specific and verifiable: "function X returns Y when given Z", not "code works correctly"
- Keep subtasks focused — prefer more small subtasks over fewer large ones

### Writing Good Acceptance Criteria

- Be specific: "The /api/users endpoint returns 200 with a JSON array" not "API works"
- Be testable: criteria should be verifiable by reading code or running commands
- Cover edge cases: "Returns 404 when user ID does not exist"
- Include integration points: "The new component is imported and rendered in App.tsx"
`;
}
