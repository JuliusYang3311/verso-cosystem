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

function specializationBadge(specialization: OrchestrationSubtask["specialization"]) {
  const badges = {
    "code-explorer": {
      icon: "🔍",
      label: "Explorer",
      title: "Code Explorer - Understand codebase",
    },
    "code-architect": {
      icon: "🏗️",
      label: "Architect",
      title: "Code Architect - Design architecture",
    },
    "code-implementer": {
      icon: "⚙️",
      label: "Implementer",
      title: "Code Implementer - Write code",
    },
    "code-reviewer": { icon: "👁️", label: "Reviewer", title: "Code Reviewer - Review quality" },
    researcher: { icon: "📚", label: "Researcher", title: "Researcher - Gather information" },
    generic: { icon: "📋", label: "Generic", title: "Generic worker" },
  };
  const badge = badges[specialization];
  return html`
    <span class="orch-specialization-badge orch-specialization-badge--${specialization}" title="${badge.title}">
      <span class="orch-specialization-badge__icon">${badge.icon}</span>
      <span class="orch-specialization-badge__label">${badge.label}</span>
    </span>
  `;
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
      <div class="orch-task-card__specialization">
        ${specializationBadge(subtask.specialization)}
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
