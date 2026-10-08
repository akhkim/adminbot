import { html, nothing } from "lit";
import {
  paperFeedbackSlots,
  parsePaperFeedback,
} from "../../../../../extensions/adminbot/src/contracts/paper-feedback.js";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import type { MyWorkProps } from "./my-work.ts";

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
export function renderPaperPiReview(
  paper: Pick<AdminBotPaperRecord, "id" | "title" | "authors" | "artifacts">,
  props: MyWorkProps,
) {
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
