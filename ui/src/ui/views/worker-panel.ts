// ui/src/ui/views/worker-panel.ts — Worker detail panel showing selected worker output

import { html, nothing } from "lit";
import type { OrchestrationSubtask } from "../controllers/orchestration.ts";
import { formatRelativeTimestamp, formatMs } from "../format.ts";

export type WorkerPanelProps = {
  subtask: OrchestrationSubtask | null;
};

export function renderWorkerPanel(props: WorkerPanelProps) {
  const { subtask } = props;
  if (!subtask) {
    return html`
      <div class="orch-worker orch-worker--empty">
        <p>Select a task card to view worker details.</p>
      </div>
    `;
  }

  const duration =
    subtask.startedAtMs && subtask.completedAtMs
      ? formatMs(subtask.completedAtMs - subtask.startedAtMs)
      : subtask.startedAtMs
        ? "running..."
        : "—";

  return html`
    <div class="orch-worker">
      <div class="orch-worker__header">
        <span class="orch-worker__status orch-worker__status--${subtask.status}">
          ${subtask.status.toUpperCase()}
        </span>
        <span class="orch-worker__title">${subtask.title}</span>
        <span class="orch-worker__duration">${duration}</span>
      </div>

      <div class="orch-worker__section">
        <div class="orch-worker__label">Description</div>
        <div class="orch-worker__text">${subtask.description}</div>
      </div>

      <div class="orch-worker__section">
        <div class="orch-worker__label">Acceptance Criteria</div>
        <ul class="orch-worker__criteria">
          ${subtask.acceptanceCriteria.map(
            (c) => html`<li class="orch-worker__criterion">${c}</li>`,
          )}
        </ul>
      </div>

      ${
        subtask.dependsOn && subtask.dependsOn.length > 0
          ? html`
            <div class="orch-worker__section">
              <div class="orch-worker__label">Depends On</div>
              <div class="orch-worker__mono">${subtask.dependsOn.join(", ")}</div>
            </div>
          `
          : nothing
      }

      ${
        subtask.resultSummary
          ? html`
            <div class="orch-worker__section">
              <div class="orch-worker__label">Result</div>
              <div class="orch-worker__text">${subtask.resultSummary}</div>
            </div>
          `
          : nothing
      }

      ${
        subtask.error
          ? html`
            <div class="orch-worker__section orch-worker__section--error">
              <div class="orch-worker__label">Error</div>
              <div class="orch-worker__text">${subtask.error}</div>
            </div>
          `
          : nothing
      }

      <div class="orch-worker__footer">
        <span>Created ${formatRelativeTimestamp(subtask.createdAtMs)}</span>
        ${
          subtask.startedAtMs
            ? html`<span>· Started ${formatRelativeTimestamp(subtask.startedAtMs)}</span>`
            : nothing
        }
        ${
          subtask.completedAtMs
            ? html`<span>· Finished ${formatRelativeTimestamp(subtask.completedAtMs)}</span>`
            : nothing
        }
        <span>· Retries: ${subtask.retryCount}</span>
      </div>
    </div>
  `;
}
