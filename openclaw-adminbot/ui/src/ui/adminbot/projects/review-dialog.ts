// The head professor's review of one paper, opened from the PI review queue on My Desk or from an
// Active Papers row.
//
// A PI decision, not the author's checklist: the manuscript, the feedback each request asks for,
// and publication approval (views/paper-pi-review.ts). Everyone else opening a paper goes to its
// project page; the head professor gets this, because the page is a form for the authors.
import { html } from "lit";
import { ref } from "lit/directives/ref.js";
import { t } from "../../../i18n/index.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import { renderPaperPiReview } from "../views/paper-pi-review.ts";
import type { PaperWorkspaceProps } from "./workspace.ts";

export type ReviewPaper = Pick<AdminBotPaperRecord, "id" | "title" | "authors" | "artifacts">;

/**
 * Opens the dialog once it is in the document. `showModal()` rather than the `open` attribute:
 * only the modal form gives the focus trap, Escape and the backdrop. Guarded because jsdom does not
 * implement it, and a render helper that throws there takes down every test of the page.
 */
function showReviewDialog(element?: Element) {
  if (!(element instanceof HTMLDialogElement) || element.open) {
    return;
  }
  const open = () => {
    if (element.isConnected && !element.open && typeof element.showModal === "function") {
      element.showModal();
    }
  };
  if (element.isConnected) {
    open();
  } else {
    queueMicrotask(open);
  }
}

export function renderPaperReviewDialog(params: {
  paper: ReviewPaper;
  props: PaperWorkspaceProps;
  onClose: () => void;
}) {
  return html`
    <dialog
      class="paper-card-dialog paper-card-dialog--review"
      data-testid="paper-card-dialog"
      aria-label=${`Review ${params.paper.title}`}
      ${ref(showReviewDialog)}
      @click=${(event: Event) => {
        // The backdrop is the dialog itself; a click that lands on a child is not a dismissal.
        if (event.target === event.currentTarget) {
          (event.currentTarget as HTMLDialogElement).close();
        }
      }}
      @close=${params.onClose}
    >
      <div class="paper-card-dialog__panel">
        <div class="paper-card-dialog__header">
          <strong>${params.paper.title}</strong>
          <button
            class="btn btn--sm"
            type="button"
            data-testid="paper-card-dialog-close"
            @click=${(event: Event) => {
              const dialog = (event.currentTarget as HTMLElement).closest("dialog");
              // `close` is absent in jsdom. Without it the host never learns the dialog was
              // dismissed and the row stays lit.
              if (typeof dialog?.close === "function") {
                dialog.close();
              } else {
                dialog?.dispatchEvent(new Event("close"));
              }
            }}
          >
            ${t("common.close")}
          </button>
        </div>
        <div class="paper-card-dialog__body">
          ${renderPaperPiReview(params.paper, params.props)}
        </div>
      </div>
    </dialog>
  `;
}
