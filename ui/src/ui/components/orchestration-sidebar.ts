// ui/src/ui/components/orchestration-sidebar.ts — Sidebar for orchestration list + quick nav

import { html, nothing } from "lit";
import type { OrchestrationListItem } from "../controllers/orchestration.ts";
import { formatRelativeTimestamp } from "../format.ts";

export type OrchestrationSidebarProps = {
  orchestrations: OrchestrationListItem[];
  activeId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onBackToChat: () => void;
};

function statusBadge(status: string) {
  const cls = `orch-sidebar__badge orch-sidebar__badge--${status}`;
  const labels: Record<string, string> = {
    planning: "Planning",
    dispatching: "Dispatching",
    running: "Running",
    acceptance: "Testing",
    fixing: "Fixing",
    completed: "Done",
    failed: "Failed",
  };
  return html`<span class="${cls}">${labels[status] ?? status}</span>`;
}

export function renderOrchestrationSidebar(props: OrchestrationSidebarProps) {
  const { orchestrations, activeId, loading, error, onSelect, onRefresh, onBackToChat } = props;

  return html`
    <div class="orch-sidebar">
      <div class="orch-sidebar__header">
        <span class="orch-sidebar__title">Orchestrations</span>
        <button class="orch-sidebar__btn" @click=${onRefresh} title="Refresh" ?disabled=${loading}>
          ↻
        </button>
      </div>
      ${error ? html`<div class="orch-sidebar__error">${error}</div>` : nothing}
      <div class="orch-sidebar__list">
        ${
          orchestrations.length === 0 && !loading
            ? html`
                <div class="orch-sidebar__empty">No orchestrations yet.</div>
              `
            : nothing
        }
        ${orchestrations.map(
          (orch) => html`
            <button
              class="orch-sidebar__item ${orch.id === activeId ? "orch-sidebar__item--active" : ""}"
              @click=${() => onSelect(orch.id)}
            >
              <div class="orch-sidebar__item-top">
                ${statusBadge(orch.status)}
                <span class="orch-sidebar__item-time">${formatRelativeTimestamp(orch.updatedAtMs)}</span>
              </div>
              <div class="orch-sidebar__item-prompt">${orch.userPrompt}</div>
              <div class="orch-sidebar__item-meta">
                ${orch.subtaskCount} tasks · cycle ${orch.fixCycle}/${orch.maxFixCycles}
              </div>
            </button>
          `,
        )}
      </div>
      <div class="orch-sidebar__footer">
        <button class="orch-sidebar__back-btn" @click=${onBackToChat}>
          ← Back to Chat
        </button>
      </div>
    </div>
  `;
}
