// The per-paper controls that are not about the work itself: hiding a paper from your own list,
// its edit history, and deleting a paper filed by mistake.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import { EMPTY_RECENT_EDITS, recentEditsKey } from "../controllers/recent-edits.ts";
import { readHiddenPapers, toggleHiddenPaper } from "../hidden-papers.ts";
import { renderRecentEdits } from "../views/recent-edits.ts";
import type { PaperWorkspaceProps } from "./workspace.ts";

/**
 * One click, no confirm, nothing written to the paper: hiding is this viewer's own preference, kept
 * in the browser, and the worst it can do is take a row off their own list -- which the overview's
 * "show all" line undoes. Delete is kept apart, behind a confirm that names the title.
 */
export function renderHideButton(
  props: PaperWorkspaceProps,
  paper: AdminBotPaperRecord,
  testId = `my-work-hide-${paper.id}`,
) {
  const hidden = readHiddenPapers(props.memberId).has(paper.id);
  return html`<button
    type="button"
    class="btn btn--sm my-work-item__hide"
    data-testid=${testId}
    title=${t("myWork.hidden.hideTitle")}
    aria-label=${t("myWork.hidden.hideTitle")}
    aria-pressed=${hidden ? "true" : "false"}
    @click=${() => {
      toggleHiddenPaper(props.memberId, paper.id);
      props.onRerender?.();
    }}
  >
    ${hidden ? "Unhide" : t("myWork.hidden.hide")}
  </button>`;
}

/** Who moved this paper, and when. Shut until opened; opening it is what fetches it. */
export function renderPaperRecentEdits(
  state: AppViewState,
  props: PaperWorkspaceProps,
  paper: AdminBotPaperRecord,
) {
  return renderRecentEdits({
    ...(state.adminBotRecentEdits?.[recentEditsKey("paper", paper.id)] ?? EMPTY_RECENT_EDITS),
    subject: "paper",
    onOpen: () => props.onLoadRecentEdits?.("paper", paper.id),
  });
}

/**
 * Removing a paper filed by mistake, last on the page and behind a confirm naming the title:
 * deleting takes the evidence, the drafts, the weekly updates and the conference rows with it.
 * A plain confirm() is the one prompt a page cannot style into looking harmless.
 */
export function renderDeletePaper(paper: AdminBotPaperRecord, props: PaperWorkspaceProps) {
  if (!props.onDeletePaper) {
    return nothing;
  }
  return html`
    <p class="my-work-item__danger">
      <button
        class="btn btn--sm danger"
        type="button"
        data-testid=${`delete-paper-${paper.id}`}
        @click=${() => {
          if (globalThis.confirm?.(t("myWork.delete.confirm", { title: paper.title }))) {
            props.onDeletePaper?.(paper);
          }
        }}
      >
        ${t("myWork.delete.action")}
      </button>
      <span class="muted">${t("myWork.delete.hint")}</span>
    </p>
  `;
}
