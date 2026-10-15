// The lab-wide author nudge: one button that previews, and a preview that sends.
//
// No composer and no recipient picker beyond the ticks: the service walks every live paper, finds
// the artifacts whose upstream evidence is already in, and composes the message to whoever the slot
// registry says owes each one. Admin-only because it messages the whole lab: it lives on Active
// Papers, the page about the whole lab, and is handed to it only in admin mode. `canNudge` hides
// the affordance; the service re-checks.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import { icons } from "../../icons.ts";
import type { PaperNudgeBatch, PaperSlotOverviewRow } from "../api/paper-admin.ts";

export type PaperNudgeProps = {
  /** What each paper still owes; the button counts the papers it would chase. */
  overview: PaperSlotOverviewRow[];
  canNudge: boolean;
  /** The preview, or null when it is closed. Opening it sends nothing. */
  nudgeBatches: PaperNudgeBatch[] | null;
  nudgeLoading: boolean;
  nudgeSelected: string[];
  nudging: boolean;
  /** What the last run did, or why it failed. */
  notice: string | null;
  onReviewNudges: () => void;
  onToggleNudgeRecipient: (memberId: string) => void;
  onNudgeAuthors: () => void;
};

/**
 * Opens the preview. Disabled at zero rather than hidden: a button that vanishes when the lab is
 * caught up gives no way to tell "everything is in" from "this feature is gone".
 */
export function renderNudgeButton(props: PaperNudgeProps) {
  if (!props.canNudge) {
    return nothing;
  }
  const outstanding = props.overview.filter(
    (row) => !row.dormant && !row.closed && row.missing_slots.length > 0,
  ).length;
  const open = props.nudgeBatches !== null;
  return html`
    <button
      type="button"
      class="btn btn--sm"
      data-testid="my-work-review-nudges"
      ?disabled=${props.nudgeLoading || outstanding === 0}
      aria-expanded=${open ? "true" : "false"}
      @click=${props.onReviewNudges}
    >
      <span aria-hidden="true">${icons.send}</span>
      ${props.nudgeLoading
        ? t("paperSlots.nudgeLoading")
        : open
          ? t("paperSlots.nudgeClose")
          : t("paperSlots.nudgeReview", { count: String(outstanding) })}
    </button>
  `;
}

/**
 * The batches, verbatim, before anything goes out: a person pressing a button should see the words
 * that will arrive under their name, and be able to leave somebody out of this round without
 * waiving anything. Somebody with no Slack id is shown unticked and unticking rather than hidden.
 */
export function renderNudgePreview(props: PaperNudgeProps) {
  const batches = props.nudgeBatches;
  // Gated on its own rather than trusting the button: this names every member who owes something
  // and quotes the message that would go to them.
  if (!props.canNudge || !batches) {
    return nothing;
  }
  if (batches.length === 0) {
    return html`<p class="nudge-preview__empty" data-testid="my-work-nudge-preview">
      ${t("paperSlots.nudgedNone")}
    </p>`;
  }
  const selected = batches.filter(
    (batch) => batch.deliverable && props.nudgeSelected.includes(batch.member_id),
  );
  return html`
    <section class="nudge-preview" data-testid="my-work-nudge-preview">
      <p class="nudge-preview__lede">
        ${t("paperSlots.nudgePreviewLede", { count: String(batches.length) })}
      </p>
      <ul class="nudge-preview__list">
        ${batches.map(
          (batch) => html`
            <li class="nudge-preview__item ${batch.deliverable ? "" : "is-unreachable"}">
              <label class="nudge-preview__head">
                <input
                  type="checkbox"
                  ?checked=${props.nudgeSelected.includes(batch.member_id)}
                  ?disabled=${!batch.deliverable}
                  data-testid=${`nudge-pick-${batch.member_id}`}
                  @change=${() => props.onToggleNudgeRecipient(batch.member_id)}
                />
                <span class="nudge-preview__name">${batch.member_name}</span>
                <span class="nudge-preview__count">
                  ${t("paperSlots.nudgeItems", {
                    items: String(batch.item_count),
                    papers: String(batch.paper_count),
                  })}
                </span>
                ${batch.deliverable
                  ? nothing
                  : html`<span class="nudge-preview__unreachable"
                      >${t("paperSlots.nudgeUnreachable")}</span
                    >`}
              </label>
              <pre class="nudge-preview__message">${batch.message}</pre>
            </li>
          `,
        )}
      </ul>
      <div class="nudge-preview__actions">
        <button
          type="button"
          class="btn primary"
          data-testid="my-work-nudge-authors"
          ?disabled=${props.nudging || selected.length === 0}
          @click=${props.onNudgeAuthors}
        >
          ${props.nudging
            ? t("paperSlots.nudging")
            : t("paperSlots.nudgeSend", { count: String(selected.length) })}
        </button>
        <span class="nudge-preview__hint">${t("paperSlots.nudgeHint")}</span>
      </div>
    </section>
  `;
}

/**
 * The nudge as one section of Active Papers: what it does, the button, what the last run did, and
 * the preview once it is open. Nothing at all for anyone who may not chase the lab.
 */
export function renderPaperNudge(props: PaperNudgeProps) {
  if (!props.canNudge) {
    return nothing;
  }
  return html`<div class="paper-nudge" data-testid="paper-nudge">
    <p class="muted">
      Messages every author who owes an artifact whose upstream evidence is already in, across every
      live paper. Nothing is sent until you review the messages and press Send.
    </p>
    <div>${renderNudgeButton(props)}</div>
    ${props.notice
      ? html`<p class="my-work__notice-line" role="status">${props.notice}</p>`
      : nothing}
    ${renderNudgePreview(props)}
  </div>`;
}
