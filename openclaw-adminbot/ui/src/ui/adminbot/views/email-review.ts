import { html, nothing } from "lit";
import type {
  AdminBotEmailReviewItem,
  AdminBotEmailReviewPaperflowCandidate,
  AdminBotEmailReviewResolution,
  AdminBotResolvedEmailReviewItem,
} from "../auth/session.ts";

export type EmailReviewProps = {
  reviews: AdminBotEmailReviewItem[];
  candidates: AdminBotEmailReviewPaperflowCandidate[];
  recentResolutions: AdminBotResolvedEmailReviewItem[];
  busyActionId: string | null;
  onResolve: (messageId: string, resolution: AdminBotEmailReviewResolution) => void;
};

export function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}

function formatReviewTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function categoryLabel(category: string): string {
  return category.replaceAll("_", " ");
}

function resolutionLabel(review: AdminBotResolvedEmailReviewItem): string {
  if (review.resolution === "dismissed") {
    return "Dismissed — no paper changed";
  }
  const target = [review.paper_title, review.stage_label].filter(Boolean).join(" — ");
  return target ? `Attached to ${target}` : "Attached as paper evidence";
}

function renderRecentResolution(review: AdminBotResolvedEmailReviewItem) {
  return html`
    <article class="email-review-history__item">
      <div class="email-review-history__message">
        <strong>${review.subject?.trim() || "No subject"}</strong>
        <span>${review.sender}</span>
      </div>
      <div class="email-review-history__decision">
        <strong>${resolutionLabel(review)}</strong>
        <span>
          Reviewed by ${review.resolved_by_name ?? review.resolved_by} ·
          ${formatReviewTime(review.resolved_at)}
        </span>
      </div>
      <a
        class="btn btn--sm"
        href=${gmailThreadUrl(review.thread_id)}
        target="_blank"
        rel="noopener noreferrer"
        >Open in Gmail</a
      >
    </article>
  `;
}

function submitAttachment(event: Event, props: EmailReviewProps, review: AdminBotEmailReviewItem) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const value = new FormData(form).get("paperflowTarget");
  // Number("") is zero: an untouched placeholder must never attach the first paper.
  if (typeof value !== "string" || !value.trim()) {
    return;
  }
  const selected = Number(value);
  const candidate = Number.isInteger(selected) ? props.candidates[selected] : undefined;
  if (!candidate) {
    return;
  }
  props.onResolve(review.message_id, {
    kind: "paperflow_evidence",
    paper_id: candidate.paper_id,
    stage: candidate.stage,
  });
}

function renderReview(props: EmailReviewProps, review: AdminBotEmailReviewItem) {
  const busy = props.busyActionId === `email-review:${review.message_id}`;
  return html`
    <article class="email-review" data-testid=${`email-review-${review.message_id}`}>
      <header class="email-review__header">
        <div>
          <span class="pill email-review__status">Needs review</span>
          <h4>${review.subject?.trim() || "No subject"}</h4>
        </div>
        <a
          class="btn btn--sm"
          href=${gmailThreadUrl(review.thread_id)}
          target="_blank"
          rel="noopener noreferrer"
          >Open in Gmail</a
        >
      </header>
      <dl class="email-review__facts">
        <div>
          <dt>From</dt>
          <dd>${review.sender}</dd>
        </div>
        <div>
          <dt>Classified as</dt>
          <dd>${categoryLabel(review.category)}</dd>
        </div>
        <div>
          <dt>Received</dt>
          <dd>${formatReviewTime(review.received_at ?? review.updated_at)}</dd>
        </div>
      </dl>
      <div class="email-review__reason">
        <strong>Why AdminBot stopped</strong>
        <span
          >${review.reason ??
          "The automation could not safely decide what this email changes."}</span
        >
      </div>
      <form
        class="email-review__resolution"
        @submit=${(event: Event) => submitAttachment(event, props, review)}
      >
        <label>
          <span>Attach to the open stage for</span>
          <select
            name="paperflowTarget"
            required
            ?disabled=${busy || props.candidates.length === 0}
          >
            <option value="" disabled selected>Choose a paper and stage</option>
            ${props.candidates.map(
              (candidate, index) => html`
                <option value=${String(index)}>
                  ${candidate.title} —
                  ${candidate.stage_label}${candidate.venue ? ` · ${candidate.venue}` : ""}
                </option>
              `,
            )}
          </select>
        </label>
        ${props.candidates.length === 0
          ? html`<p class="email-review__no-targets">
              No paper currently has an open venue stage.
            </p>`
          : nothing}
        <div class="email-review__actions">
          <button
            class="btn btn--sm primary"
            type="submit"
            ?disabled=${busy || props.candidates.length === 0}
          >
            ${busy ? "Resolving…" : "Attach and stop reminder"}
          </button>
          <button
            class="btn btn--sm"
            type="button"
            ?disabled=${busy}
            @click=${() => props.onResolve(review.message_id, { kind: "dismissed" })}
          >
            Not paper evidence
          </button>
        </div>
      </form>
    </article>
  `;
}

export function renderAdminBotEmailReview(props: EmailReviewProps) {
  return html`
    <section class="email-review-queue" data-testid="email-review-queue">
      <div class="email-review-queue__heading">
        <div>
          <h3>Emails needing review</h3>
          <p>
            AdminBot held these messages instead of guessing. Attach valid venue evidence to stop
            that paper's reminder, or dismiss mail that changes nothing.
          </p>
        </div>
        ${props.reviews.length
          ? html`<span class="email-review-queue__count">${props.reviews.length}</span>`
          : nothing}
      </div>
      ${props.reviews.length
        ? html`<div class="email-review-list">
            ${props.reviews.map((review) => renderReview(props, review))}
          </div>`
        : html`<div class="adminbot-empty">
            <div>
              <strong>No emails need review</strong>
              <span>Messages AdminBot cannot safely match will appear here.</span>
            </div>
          </div>`}
      <p class="email-review-queue__gmail-note">
        Resolving a card changes AdminBot's evidence ledger, not the original Gmail message or its
        labels.
      </p>
      ${props.recentResolutions.length
        ? html`
            <details class="email-review-history" data-testid="email-review-history">
              <summary>Recently reviewed (${props.recentResolutions.length})</summary>
              <p>The 20 most recent decisions are kept here for verification.</p>
              <div class="email-review-history__list">
                ${props.recentResolutions.map(renderRecentResolution)}
              </div>
            </details>
          `
        : nothing}
    </section>
  `;
}
