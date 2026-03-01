// ui/src/ui/components/task-card.ts — Subtask card for the orchestration board

import { html, nothing } from "lit";
import type { OrchestrationSubtask } from "../controllers/orchestration.ts";
import { formatRelativeTimestamp } from "../format.ts";

export type TaskCardProps = {
  subtask: OrchestrationSubtask;
  selected: boolean;
  onSelect: (id: string) => void;
};

function statusIcon(status: OrchestrationSubtask["status"]) {
  switch (status) {
    case "running":
      return html`
        <span class="orch-status-icon orch-status-icon--running" title="Running">⟳</span>
      `;
    case "completed":
      return html`
        <span class="orch-status-icon orch-status-icon--completed" title="Completed">✓</span>
      `;
    case "failed":
      return html`
        <span class="orch-status-icon orch-status-icon--failed" title="Failed">✗</span>
      `;
    case "cancelled":
      return html`
        <span class="orch-status-icon orch-status-icon--cancelled" title="Cancelled">—</span>
      `;
    default:
      return html`
        <span class="orch-status-icon orch-status-icon--pending" title="Pending">○</span>
      `;
  }
}

export function renderTaskCard(props: TaskCardProps) {
  const { subtask, selected, onSelect } = props;
  const criteriaCount = subtask.acceptanceCriteria.length;
  const timeLabel = subtask.startedAtMs
    ? formatRelativeTimestamp(subtask.startedAtMs)
    : formatRelativeTimestamp(subtask.createdAtMs);

  return html`
    <button
      class="orch-task-card ${selected ? "orch-task-card--selected" : ""} orch-task-card--${subtask.status}"
      @click=${() => onSelect(subtask.id)}
      title="${subtask.description}"
    >
      <div class="orch-task-card__header">
        ${statusIcon(subtask.status)}
        <span class="orch-task-card__title">${subtask.title}</span>
      </div>
      <div class="orch-task-card__meta">
        <span class="orch-task-card__criteria">${criteriaCount} criteria</span>
        <span class="orch-task-card__time">${timeLabel}</span>
      </div>
      ${subtask.error ? html`<div class="orch-task-card__error">${subtask.error}</div>` : nothing}
      ${
        subtask.resultSummary
          ? html`<div class="orch-task-card__result">${subtask.resultSummary.slice(0, 120)}</div>`
          : nothing
      }
    </button>
  `;
}
