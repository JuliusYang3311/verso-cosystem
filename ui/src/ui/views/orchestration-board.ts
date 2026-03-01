// ui/src/ui/views/orchestration-board.ts — Main orchestration detail view with task board

import { html, nothing } from "lit";
import type { OrchestrationDetail, OrchestrationSubtask } from "../controllers/orchestration.ts";
import { renderAcceptancePanel } from "../components/acceptance-panel.ts";
import { renderTaskCard } from "../components/task-card.ts";
import { formatRelativeTimestamp, formatMs } from "../format.ts";
import { renderWorkerPanel } from "./worker-panel.ts";

export type OrchestrationBoardProps = {
  orchestration: OrchestrationDetail | null;
  loading: boolean;
  selectedSubtaskId: string | null;
  busy: boolean;
  error: string | null;
  onSelectSubtask: (id: string) => void;
  onAbort: (id: string) => void;
  onRetry: (id: string) => void;
  onDelete: (id: string) => void;
  onRefresh: (id: string) => void;
};

const STATUS_LABELS: Record<string, string> = {
  planning: "Planning",
  dispatching: "Dispatching",
  running: "Running",
  acceptance: "Acceptance Testing",
  fixing: "Fixing",
  completed: "Completed",
  failed: "Failed",
};

function groupSubtasks(subtasks: OrchestrationSubtask[]) {
  const groups: Record<string, OrchestrationSubtask[]> = {
    pending: [],
    running: [],
    completed: [],
    failed: [],
  };
  for (const st of subtasks) {
    const key = st.status === "cancelled" ? "failed" : st.status;
    (groups[key] ?? groups.pending).push(st);
  }
  return groups;
}

function renderColumn(
  label: string,
  tasks: OrchestrationSubtask[],
  selectedId: string | null,
  onSelect: (id: string) => void,
) {
  return html`
    <div class="orch-board__column">
      <div class="orch-board__column-header">
        <span class="orch-board__column-label">${label}</span>
        <span class="orch-board__column-count">${tasks.length}</span>
      </div>
      <div class="orch-board__column-cards">
        ${tasks.map((st) =>
          renderTaskCard({
            subtask: st,
            selected: st.id === selectedId,
            onSelect,
          }),
        )}
      </div>
    </div>
  `;
}

export function renderOrchestrationBoard(props: OrchestrationBoardProps) {
  const {
    orchestration: orch,
    loading,
    selectedSubtaskId,
    busy,
    error,
    onSelectSubtask,
    onAbort,
    onRetry,
    onDelete,
    onRefresh,
  } = props;

  if (loading && !orch) {
    return html`
      <div class="orch-board orch-board--loading">Loading orchestration...</div>
    `;
  }

  if (!orch) {
    return html`
      <div class="orch-board orch-board--empty">
        <p>Select an orchestration from the sidebar, or start a complex task in chat to trigger one.</p>
      </div>
    `;
  }

  const subtasks = orch.plan?.subtasks ?? [];
  const groups = groupSubtasks(subtasks);
  const selectedSubtask = subtasks.find((s) => s.id === selectedSubtaskId) ?? null;
  const isTerminal = orch.status === "completed" || orch.status === "failed";
  const duration = orch.completedAtMs
    ? formatMs(orch.completedAtMs - orch.createdAtMs)
    : formatMs(Date.now() - orch.createdAtMs);

  return html`
    <div class="orch-board">
      <!-- Header -->
      <div class="orch-board__header">
        <div class="orch-board__header-top">
          <span class="orch-board__status orch-board__status--${orch.status}">
            ${STATUS_LABELS[orch.status] ?? orch.status}
          </span>
          <span class="orch-board__timing">
            ${duration} · Started ${formatRelativeTimestamp(orch.createdAtMs)}
          </span>
          <div class="orch-board__actions">
            <button class="orch-board__btn" @click=${() => onRefresh(orch.id)} ?disabled=${busy} title="Refresh">
              ↻
            </button>
            ${
              !isTerminal
                ? html`<button class="orch-board__btn orch-board__btn--danger" @click=${() => onAbort(orch.id)} ?disabled=${busy}>
                  Abort
                </button>`
                : nothing
            }
            ${
              orch.status === "failed"
                ? html`<button class="orch-board__btn orch-board__btn--primary" @click=${() => onRetry(orch.id)} ?disabled=${busy}>
                  Retry
                </button>`
                : nothing
            }
            ${
              isTerminal
                ? html`<button class="orch-board__btn orch-board__btn--danger" @click=${() => onDelete(orch.id)} ?disabled=${busy}>
                  Delete
                </button>`
                : nothing
            }
          </div>
        </div>
        <div class="orch-board__prompt">${orch.userPrompt}</div>
        ${
          orch.plan?.summary
            ? html`<div class="orch-board__summary">${orch.plan.summary}</div>`
            : nothing
        }
        ${orch.error ? html`<div class="orch-board__error">${orch.error}</div>` : nothing}
        ${error ? html`<div class="orch-board__error">${error}</div>` : nothing}
      </div>

      <!-- Task Board (Kanban) -->
      <div class="orch-board__kanban">
        ${renderColumn("Pending", groups.pending, selectedSubtaskId, onSelectSubtask)}
        ${renderColumn("Running", groups.running, selectedSubtaskId, onSelectSubtask)}
        ${renderColumn("Completed", groups.completed, selectedSubtaskId, onSelectSubtask)}
        ${renderColumn("Failed", groups.failed, selectedSubtaskId, onSelectSubtask)}
      </div>

      <!-- Worker Detail -->
      ${renderWorkerPanel({ subtask: selectedSubtask })}

      <!-- Acceptance Results -->
      ${
        orch.acceptanceResults.length > 0
          ? renderAcceptancePanel({
              results: orch.acceptanceResults,
              currentFixCycle: orch.currentFixCycle,
              maxFixCycles: orch.maxFixCycles,
            })
          : nothing
      }

      <!-- Fix Tasks -->
      ${
        orch.fixTasks.length > 0
          ? html`
            <div class="orch-board__fix-tasks">
              <div class="orch-board__fix-title">Fix Tasks (Cycle ${orch.currentFixCycle})</div>
              ${orch.fixTasks.map(
                (ft) => html`
                  <div class="orch-board__fix-item orch-board__fix-item--${ft.status}">
                    <span class="orch-board__fix-status">${ft.status}</span>
                    <span class="orch-board__fix-desc">${ft.description}</span>
                    ${ft.error ? html`<span class="orch-board__fix-error">${ft.error}</span>` : nothing}
                  </div>
                `,
              )}
            </div>
          `
          : nothing
      }
    </div>
  `;
}
