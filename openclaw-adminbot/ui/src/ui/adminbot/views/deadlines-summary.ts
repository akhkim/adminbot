// The two closest major conference deadlines, shown at the top of the profile page.
//
// The full board (views/deadlines.ts) is 107 entries behind a tab someone has to decide to open.
// The two deadlines a member is actually working toward should not need that decision, so they sit
// on the page everyone lands on. Two is the whole point: a summary long enough to scroll is just
// the board again, and the board is one click away for anyone who wants the rest.
//
// Selection and countdown formatting come from data/deadline-time.ts, shared with the board, so the
// two surfaces can never disagree about what is next or how long is left.
import { html, nothing, LitElement } from "lit";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../external-link.ts";
import { icons } from "../../icons.ts";
import {
  aoeDateLabel,
  countdownLabel,
  upcomingMajorDeadlines,
  urgencyOf,
  type DeadlineEntry,
} from "../data/deadline-time.ts";

const SUMMARY_LIMIT = 2;

function renderEntry(entry: DeadlineEntry, now: number) {
  const { venue, instant } = entry;
  return html`
    <li
      class="deadline-summary__row"
      data-urgency=${urgencyOf(instant, now)}
      data-testid=${`deadline-summary-${venue.id}`}
    >
      <span class="deadline-summary__countdown">${countdownLabel(instant - now)}</span>
      <span class="deadline-summary__body">
        <span class="deadline-summary__name">${venue.name}</span>
        <span class="deadline-summary__date">
          ${aoeDateLabel(venue.deadline_aoe)} ${t("deadlineSummary.aoe")}
        </span>
      </span>
      ${venue.link
        ? html`<a
            class="deadline-summary__link"
            href=${venue.link}
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            aria-label=${t("deadlineSummary.venueLink", { name: venue.name })}
            >${icons.externalLink}</a
          >`
        : nothing}
    </li>
  `;
}

// Custom element so the countdown owns a 1s timer and re-renders itself, matching the board. Light
// DOM (createRenderRoot returns this) lets the app's theme variables cascade into the rows.
class AdminbotDeadlineSummary extends LitElement {
  private timer: number | undefined;

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.timer = window.setInterval(() => this.requestUpdate(), 1000);
  }

  override disconnectedCallback(): void {
    if (this.timer !== undefined) {
      window.clearInterval(this.timer);
      this.timer = undefined;
    }
    super.disconnectedCallback();
  }

  // Set by renderDeadlineSummary so the "see all" button can route without this element needing to
  // know how navigation works.
  public onOpenBoard: (() => void) | undefined;

  protected override render() {
    const now = Date.now();
    const entries = upcomingMajorDeadlines(now, SUMMARY_LIMIT);
    return html`
      <section class="deadline-summary" data-testid="profile-deadline-summary">
        <h2 class="deadline-summary__title">${t("deadlineSummary.title")}</h2>
        ${entries.length
          ? html`<ul class="deadline-summary__list">
              ${entries.map((entry) => renderEntry(entry, now))}
            </ul>`
          : html`<p class="deadline-summary__empty">${t("deadlineSummary.empty")}</p>`}
        <button
          type="button"
          class="btn deadline-summary__action"
          @click=${() => this.onOpenBoard?.()}
        >
          ${t("deadlineSummary.open")}
        </button>
      </section>
    `;
  }
}

if (!customElements.get("adminbot-deadline-summary")) {
  customElements.define("adminbot-deadline-summary", AdminbotDeadlineSummary);
}

export function renderDeadlineSummary(state: AppViewState) {
  return html`<adminbot-deadline-summary
    .onOpenBoard=${() => state.setTab("adminbotDeadlines")}
  ></adminbot-deadline-summary>`;
}
