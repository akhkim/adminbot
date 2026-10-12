// The lab-wide author nudge: one button that previews, and a preview that sends.
//
// No composer and no recipient picker beyond the ticks: the service walks every live paper, finds
// the artifacts whose upstream evidence is already in, and composes the message to whoever the slot
// registry says owes each one. Admin-only because it messages the whole lab; `canNudge` hides the
// affordance and the service re-checks.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import { icons } from "../../icons.ts";
import type { PaperWorkspaceProps } from "./workspace.ts";

/**
 * Opens the preview. Disabled at zero rather than hidden: a button that vanishes when the lab is
 * caught up gives no way to tell "everything is in" from "this feature is gone".
 */
export function renderNudgeButton(props: PaperWorkspaceProps) {
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
export function renderNudgePreview(props: PaperWorkspaceProps) {
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
                    papers: String(batch.paper_titles.length),
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
 * The nudge as a panel of its own, for a project page an administrator opens. It chases every
 * paper in the lab, not just this one, and says so, along with what the last run did.
 */
export function renderNudgePanel(props: PaperWorkspaceProps) {
  if (!props.canNudge) {
    return nothing;
  }
  return html`<section class="project__panel" data-testid="project-nudge-panel">
    <h3>Chase authors (whole lab)</h3>
    <p class="muted">
      Messages every author who owes an artifact whose upstream evidence is already in, across every
      live paper -- not only this one. Nothing is sent until you review the messages.
    </p>
    <div>${renderNudgeButton(props)}</div>
    ${props.slotsNotice
      ? html`<p class="my-work__notice-line" role="status">${props.slotsNotice}</p>`
      : nothing}
    ${renderNudgePreview(props)}
  </section>`;
}
