// ui/src/ui/components/acceptance-panel.ts — Acceptance results display

import { html, nothing } from "lit";
import type { OrchestrationAcceptanceResult } from "../controllers/orchestration.ts";
import { formatRelativeTimestamp } from "../format.ts";

export type AcceptancePanelProps = {
  results: OrchestrationAcceptanceResult[];
  currentFixCycle: number;
  maxFixCycles: number;
};

export function renderAcceptancePanel(props: AcceptancePanelProps) {
  const { results, currentFixCycle, maxFixCycles } = props;
  if (results.length === 0) {
    return html`
      <div class="orch-acceptance orch-acceptance--empty">No acceptance tests run yet.</div>
    `;
  }

  return html`
    <div class="orch-acceptance">
      <div class="orch-acceptance__header">
        <span class="orch-acceptance__title">Acceptance Results</span>
        <span class="orch-acceptance__cycle">Fix cycle ${currentFixCycle} / ${maxFixCycles}</span>
      </div>
      ${results.map((result, idx) => {
        const isLatest = idx === results.length - 1;
        return html`
          <details class="orch-acceptance__run ${isLatest ? "orch-acceptance__run--latest" : ""}" ?open=${isLatest}>
            <summary class="orch-acceptance__run-header">
              <span class="orch-acceptance__run-badge ${result.passed ? "orch-acceptance__run-badge--pass" : "orch-acceptance__run-badge--fail"}">
                ${result.passed ? "PASS" : "FAIL"}
              </span>
              <span class="orch-acceptance__run-time">${formatRelativeTimestamp(result.testedAtMs)}</span>
              <span class="orch-acceptance__run-summary">${result.summary.slice(0, 100)}</span>
            </summary>
            <div class="orch-acceptance__verdicts">
              ${result.verdicts.map(
                (v) => html`
                  <div class="orch-acceptance__verdict ${v.passed ? "orch-acceptance__verdict--pass" : "orch-acceptance__verdict--fail"}">
                    <span class="orch-acceptance__verdict-icon">${v.passed ? "✓" : "✗"}</span>
                    <span class="orch-acceptance__verdict-task">${v.subtaskId}</span>
                    ${
                      v.reason
                        ? html`<span class="orch-acceptance__verdict-reason">${v.reason}</span>`
                        : nothing
                    }
                  </div>
                `,
              )}
            </div>
          </details>
        `;
      })}
    </div>
  `;
}
