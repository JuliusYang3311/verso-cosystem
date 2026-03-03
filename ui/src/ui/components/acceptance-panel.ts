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
              ${result.verdicts.map((v) => {
                const confidenceClass = v.confidence >= 70 ? "high" : "low";
                const confidenceLabel = v.confidence >= 70 ? "High confidence" : "Low confidence";
                return html`
                    <div class="orch-acceptance__verdict ${v.passed ? "orch-acceptance__verdict--pass" : "orch-acceptance__verdict--fail"}">
                      <span class="orch-acceptance__verdict-icon">${v.passed ? "✓" : "✗"}</span>
                      <span class="orch-acceptance__verdict-task">${v.subtaskId}</span>
                      <span class="orch-acceptance__verdict-confidence orch-acceptance__verdict-confidence--${confidenceClass}" title="${confidenceLabel}">
                        ${v.confidence}%
                      </span>
                      ${
                        v.reasoning
                          ? html`<span class="orch-acceptance__verdict-reason">${v.reasoning}</span>`
                          : nothing
                      }
                      ${
                        v.issues && v.issues.length > 0
                          ? html`
                            <div class="orch-acceptance__verdict-issues">
                              ${v.issues.map(
                                (issue) => html`
                                  <div class="orch-acceptance__issue orch-acceptance__issue--${issue.severity}">
                                    <span class="orch-acceptance__issue-severity">${issue.severity}</span>
                                    <span class="orch-acceptance__issue-confidence">${issue.confidence}%</span>
                                    <span class="orch-acceptance__issue-description">${issue.description}</span>
                                    ${issue.file ? html`<span class="orch-acceptance__issue-file">${issue.file}${issue.line ? `:${issue.line}` : ""}</span>` : nothing}
                                  </div>
                                `,
                              )}
                            </div>
                          `
                          : nothing
                      }
                    </div>
                  `;
              })}
            </div>
          </details>
        `;
      })}
    </div>
  `;
}
