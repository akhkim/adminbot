// The two closest major conference deadlines, shown at the top of the profile page.
//
// The full board (views/deadlines.ts) is 107 entries behind a tab someone has to decide to open.
// The two deadlines a member is actually working toward should not need that decision, so they sit
// on the page everyone lands on. Two is the whole point: a summary long enough to scroll is just
// the board again, and the board is one click away for anyone who wants the rest.
//
// Selection and countdown formatting come from data/deadline-time.ts, shared with the board, so the
// two surfaces can never disagree about what is next or how long is left.
import { html, LitElement } from "lit";
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

// One deadline row, in the same shape the work summary uses: a truncating label and a mono value
// on the right. The venue name is the link rather than a separate icon button -- the icon had no
// styles of its own and rendered at the SVG's natural size, which dwarfed the row.
function renderEntry(entry: DeadlineEntry, now: number) {
  const { venue, instant } = entry;
  const label = venue.link
    ? html`<a
        class="dashboard-summary__row-link"
        href=${venue.link}
        target=${EXTERNAL_LINK_TARGET}
        rel=${buildExternalLinkRel()}
        >${venue.name}<span class="dashboard-summary__row-link-icon" aria-hidden="true"
          >${icons.externalLink}</span
        ></a
      >`
    : venue.name;
  return html`
    <li
      class="dashboard-summary__row dashboard-summary__row--paper"
      data-urgency=${urgencyOf(instant, now)}
      data-testid=${`deadline-summary-${venue.id}`}
    >
      <span class="dashboard-summary__row-label" title=${venue.name}>${label}</span>
      <span class="dashboard-summary__row-value">${countdownLabel(instant - now)}</span>
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
    const next = entries[0];
    // Same anatomy as the Needs You and My Projects & Papers cards: label, one headline number,
    // a supporting line, the rows, then the action. The headline is the soonest countdown, which
    // is the one figure worth reading at a glance.
    return html`
      <article class="dashboard-summary" data-testid="profile-deadline-summary">
        <h3 class="dashboard-summary__title">
          <span class="dashboard-summary__icon" aria-hidden="true">${icons.loader}</span>
          ${t("deadlineSummary.title")}
        </h3>
        ${next
          ? html`
              <p class="dashboard-summary__headline">${countdownLabel(next.instant - now)}</p>
              <p class="dashboard-summary__detail">
                ${next.venue.name} · ${aoeDateLabel(next.venue.deadline_aoe)}
                ${t("deadlineSummary.aoe")}
              </p>
              <ul class="dashboard-summary__list">
                ${entries.map((entry) => renderEntry(entry, now))}
              </ul>
            `
          : html`<p class="dashboard-summary__detail">${t("deadlineSummary.empty")}</p>`}
        <button
          type="button"
          class="btn dashboard-summary__action"
          @click=${() => this.onOpenBoard?.()}
        >
          ${t("deadlineSummary.open")}
        </button>
      </article>
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
