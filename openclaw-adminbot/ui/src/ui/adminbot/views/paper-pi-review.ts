import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import {
  paperFeedbackSlots,
  parsePaperFeedback,
} from "../../../../../extensions/adminbot/src/contracts/paper-feedback.js";
import { t } from "../../../i18n/index.ts";
import type { PaperCycle } from "../api/papers.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";

/** What the review reads and writes: the paper's evidence cycle and the slot save path. */
export type PaperPiReviewProps = {
  slots: Record<string, PaperCycle>;
  slotsBusyId: string | null;
  slotsError: string | null;
  onLoadSlots?: (paperId: string) => void;
  onSaveSlot: (
    paperId: string,
    slot: string,
    input: { value_text?: string; done?: boolean },
  ) => void;
};

function manuscriptLink(url: string | undefined, label: string) {
  if (!url) {
    return nothing;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return nothing;
    }
    return html`<a class="btn" href=${parsed.href} target="_blank" rel="noopener noreferrer"
      >${label}</a
    >`;
  } catch {
    return nothing;
  }
}

function formatDeadline(value: string) {
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** A PI decision, not the author's entire publication checklist. */
export function renderPaperPiReview(paper: AdminBotPaperRecord, props: PaperPiReviewProps) {
  const cycle = props.slots[paper.id];
  if (!cycle) {
    return props.slotsError
      ? html`<p role="alert">${props.slotsError}</p>
          <button class="btn" @click=${() => props.onLoadSlots?.(paper.id)}>Retry</button>`
      : html`<p role="status">Loading paper review…</p>`;
  }
  const busy = props.slotsBusyId === paper.id;
  const approval = cycle.slots.find((row) => row.slot === "pi_approval");
  const url = (slot: string) => cycle.slots.find((row) => row.slot === slot)?.url;
  return html`<section data-testid="paper-pi-review">
    ${props.slotsError ? html`<p role="alert">${props.slotsError}</p>` : nothing}
    <p class="muted">${paper.authors.join(", ")}</p>
    <p>
      ${manuscriptLink(
        url("overleaf_edit") ||
          url("overleaf_view") ||
          paper.artifacts?.overleaf_edit_url ||
          paper.artifacts?.overleaf_view_url,
        "Open Overleaf",
      )}
      ${manuscriptLink(url("drive_pdf_arxiv") || paper.artifacts?.google_drive_pdf_url, "Read PDF")}
    </p>
    ${Object.entries(paperFeedbackSlots).map(([slot, label]) => {
      const row = cycle.slots.find((entry) => entry.slot === slot);
      const request = row?.status === "provided" ? parsePaperFeedback(row.value_text ?? "") : null;
      if (!request) {
        return nothing;
      }
      return html`<section class="card">
        <h4>${label}</h4>
        <p>${request.reason}</p>
        ${manuscriptLink(request.url, "Open manuscript")}
        <p class="muted">
          Feedback by:
          ${request.soft_deadline ? formatDeadline(request.soft_deadline) : "Not specified"}<br />Submission
          cutoff: ${request.hard_deadline ? formatDeadline(request.hard_deadline) : "Not specified"}
        </p>
        ${request.reviewed
          ? html`<p role="status">Feedback completed</p>
              <p style="white-space: pre-wrap">${request.review_note}</p>`
          : html`<form
              @submit=${(event: SubmitEvent) => {
                event.preventDefault();
                const value = new FormData(event.currentTarget as HTMLFormElement).get("feedback");
                const note = typeof value === "string" ? value : "";
                props.onSaveSlot(paper.id, slot, {
                  value_text: JSON.stringify({ ...request, reviewed: true, review_note: note }),
                });
              }}
            >
              <label
                >Feedback (optional)<textarea
                  class="input"
                  name="feedback"
                  maxlength="4000"
                  ?disabled=${busy}
                ></textarea>
              </label>
              <p class="muted">Completing feedback does not approve publication.</p>
              <button class="btn btn--primary" type="submit" ?disabled=${busy}>
                ${busy ? "Saving…" : "Mark feedback done"}
              </button>
            </form>`}
      </section>`;
    })}
    <section class="card">
      <h4>Publication approval</h4>
      <p>
        Approve only when this version is ready to be posted publicly. This does not submit it to
        arXiv.
      </p>
      ${approval?.status === "provided"
        ? html`<p role="status">Publication approved</p>`
        : html`<button
            class="btn btn--primary"
            ?disabled=${busy}
            @click=${() => props.onSaveSlot(paper.id, "pi_approval", { done: true })}
          >
            Approve publication
          </button>`}
    </section>
  </section>`;
}

/**
 * `showModal()` rather than the `open` attribute, for the focus trap, Escape and the backdrop.
 * Guarded because jsdom implements neither `showModal` nor `close`.
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

function closeDialog(dialog: HTMLDialogElement | null | undefined) {
  if (typeof dialog?.close === "function") {
    dialog.close();
  } else {
    dialog?.dispatchEvent(new Event("close"));
  }
}

/** The PI's focused review of one paper, opened from the professor desk's review queue. */
export function renderPaperPiReviewDialog(params: {
  paper: AdminBotPaperRecord;
  props: PaperPiReviewProps;
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
          closeDialog(event.currentTarget as HTMLDialogElement);
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
            @click=${(event: Event) =>
              closeDialog((event.currentTarget as HTMLElement).closest("dialog"))}
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
