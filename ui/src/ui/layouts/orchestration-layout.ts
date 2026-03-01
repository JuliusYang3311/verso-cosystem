// ui/src/ui/layouts/orchestration-layout.ts — Top-level orchestration layout

import { html } from "lit";
import type { OrchestrationListItem, OrchestrationDetail } from "../controllers/orchestration.ts";
import { renderOrchestrationSidebar } from "../components/orchestration-sidebar.ts";
import { renderOrchestrationBoard } from "../views/orchestration-board.ts";

export type OrchestrationLayoutProps = {
  orchestrations: OrchestrationListItem[];
  activeId: string | null;
  detail: OrchestrationDetail | null;
  detailLoading: boolean;
  listLoading: boolean;
  selectedSubtaskId: string | null;
  busy: boolean;
  error: string | null;
  onSelectOrchestration: (id: string) => void;
  onSelectSubtask: (id: string) => void;
  onRefreshList: () => void;
  onRefreshDetail: (id: string) => void;
  onAbort: (id: string) => void;
  onRetry: (id: string) => void;
  onDelete: (id: string) => void;
  onBackToChat: () => void;
};

export function renderOrchestrationLayout(props: OrchestrationLayoutProps) {
  return html`
    <div class="orch-layout">
      <aside class="orch-layout__sidebar">
        ${renderOrchestrationSidebar({
          orchestrations: props.orchestrations,
          activeId: props.activeId,
          loading: props.listLoading,
          error: props.error,
          onSelect: props.onSelectOrchestration,
          onRefresh: props.onRefreshList,
          onBackToChat: props.onBackToChat,
        })}
      </aside>
      <main class="orch-layout__main">
        ${renderOrchestrationBoard({
          orchestration: props.detail,
          loading: props.detailLoading,
          selectedSubtaskId: props.selectedSubtaskId,
          busy: props.busy,
          error: props.error,
          onSelectSubtask: props.onSelectSubtask,
          onAbort: props.onAbort,
          onRetry: props.onRetry,
          onDelete: props.onDelete,
          onRefresh: props.onRefreshDetail,
        })}
      </main>
    </div>
  `;
}
