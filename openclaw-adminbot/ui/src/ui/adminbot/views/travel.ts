// Control UI view for the Travel tab: where the signed-in professor has been, read off their own
// sign-in log.
//
// The page is arranged around the two questions it exists to answer, in the order they get asked.
// Trips first, because that is the reimbursement question -- "which weeks was I away, and where" --
// and it is a short list somebody copies into a form. The full timeline second, because that is the
// planning question, and it is long.
//
// The honesty rule this screen is built around: a login log is evidence of presence, never of
// absence. Every date here is an *observation*, and the gap between two stays is unobserved rather
// than travelled. The provenance line at the bottom is not a footnote -- a timeline built from a
// handful of located logins looks exactly like a timeline built from hundreds, and the reader has
// to be able to tell which one they are looking at before they file anything against it.
import { html, nothing, LitElement } from "lit";
import { property } from "lit/decorators.js";
import type { TravelHistoryRow, TravelStayRow } from "../auth/session.ts";
import type { TravelRange } from "../controllers/travel.ts";

const RANGE_LABELS: Record<TravelRange, string> = {
  "12m": "Last 12 months",
  "24m": "Last 24 months",
  all: "All time",
};

/** Same threshold as `tripsFrom` in the service. See that function for why one sighting is not a trip. */
function isTrip(stay: TravelStayRow): boolean {
  return stay.away && (stay.login_count > 1 || stay.observed_days > 0);
}

function placeLabel(stay: { city?: string; country?: string }): string {
  if (stay.city && stay.country) {
    return `${stay.city}, ${stay.country}`;
  }
  return stay.city ?? stay.country ?? "Unknown";
}

function shortDate(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * "3 Mar – 9 Mar 2026", or a single date when the stay was seen once.
 *
 * The en dash is doing real work: a stay is a span between two observations, and writing it as a
 * range with a hyphen invites reading it as an itinerary with a departure date on the right.
 */
function spanLabel(stay: TravelStayRow): string {
  return stay.first_seen === stay.last_seen
    ? shortDate(stay.first_seen)
    : `${shortDate(stay.first_seen)} – ${shortDate(stay.last_seen)}`;
}

function daysLabel(stay: TravelStayRow): string {
  if (stay.observed_days === 0) {
    return "same day";
  }
  return `${stay.observed_days} day${stay.observed_days === 1 ? "" : "s"}`;
}

/**
 * The trip list as CSV, for pasting into a reimbursement form.
 *
 * Headed "observed" rather than "from"/"to" for the same reason the spans are drawn with a dash:
 * the columns are the first and last sign-in seen from that city, and a form that says "departure"
 * would be putting a word on this data that it does not support.
 */
function tripsCsv(history: TravelHistoryRow): string {
  const rows = history.stays.filter(isTrip);
  const escape = (value: string) =>
    /[",\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return [
    "place,country,first_observed,last_observed,observed_days,sign_ins",
    ...rows.map((stay) =>
      [
        escape(stay.city ?? ""),
        escape(stay.country ?? ""),
        stay.first_seen.slice(0, 10),
        stay.last_seen.slice(0, 10),
        String(stay.observed_days),
        String(stay.login_count),
      ].join(","),
    ),
  ].join("\n");
}

class AdminbotTravelView extends LitElement {
  @property({ attribute: false }) history: TravelHistoryRow | null = null;
  @property({ attribute: false }) range: TravelRange = "12m";
  @property({ type: Boolean }) loading = false;
  @property({ attribute: false }) error: string | null = null;
  @property({ attribute: false }) onRangeChange: (range: TravelRange) => void = () => {};

  private copied = false;

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  private copyTrips(): void {
    if (!this.history) {
      return;
    }
    void navigator.clipboard?.writeText(tripsCsv(this.history));
    this.copied = true;
    this.requestUpdate();
    setTimeout(() => {
      this.copied = false;
      this.requestUpdate();
    }, 2000);
  }

  private renderRanges() {
    return html`
      <div class="tv-ranges" role="tablist">
        ${(Object.keys(RANGE_LABELS) as TravelRange[]).map((range) => {
          const selected = this.range === range;
          return html`
            <button
              class=${`tv-range ${selected ? "is-active" : ""}`}
              role="tab"
              aria-selected=${selected ? "true" : "false"}
              @click=${() => this.onRangeChange(range)}
            >
              ${RANGE_LABELS[range]}
            </button>
          `;
        })}
      </div>
    `;
  }

  /** Home base, countries touched, days away. The three numbers a year gets summarized by. */
  private renderSummary(history: TravelHistoryRow) {
    const trips = history.stays.filter(isTrip);
    const countries = new Set(
      history.stays
        .map((stay) => stay.country)
        .filter((country): country is string => Boolean(country)),
    );
    const daysAway = trips.reduce((total, stay) => total + stay.observed_days, 0);
    const home = history.home_city
      ? placeLabel({ city: history.home_city, country: history.home_country })
      : null;
    return html`
      <div class="tv-summary">
        <div class="tv-stat">
          <span class="tv-stat-value">${home ?? "—"}</span>
          <span class="tv-stat-label">Home base</span>
        </div>
        <div class="tv-stat">
          <span class="tv-stat-value">${trips.length}</span>
          <span class="tv-stat-label">Trip${trips.length === 1 ? "" : "s"}</span>
        </div>
        <div class="tv-stat">
          <span class="tv-stat-value">${daysAway}</span>
          <span class="tv-stat-label">Days observed away</span>
        </div>
        <div class="tv-stat">
          <span class="tv-stat-value">${countries.size}</span>
          <span class="tv-stat-label">Countries</span>
        </div>
      </div>
      ${home
        ? nothing
        : html`<p class="tv-note">
            Not enough places in this window to say where home is, so no stay is marked as travel.
            Widen the range, or wait for more sign-ins.
          </p>`}
    `;
  }

  private renderTrips(history: TravelHistoryRow) {
    const trips = history.stays.filter(isTrip);
    if (trips.length === 0) {
      return html`
        <section class="tv-block">
          <h3 class="tv-heading">Trips</h3>
          <p class="tv-empty">No travel away from ${history.home_city ?? "home"} in this window.</p>
        </section>
      `;
    }
    return html`
      <section class="tv-block">
        <div class="tv-block-head">
          <h3 class="tv-heading">Trips</h3>
          <button class="tv-copy" @click=${() => this.copyTrips()}>
            ${this.copied ? "Copied" : "Copy as CSV"}
          </button>
        </div>
        <table class="tv-table">
          <thead>
            <tr>
              <th>Place</th>
              <th>Observed</th>
              <th class="tv-num">Span</th>
              <th class="tv-num">Sign-ins</th>
            </tr>
          </thead>
          <tbody>
            ${trips.map(
              (stay) => html`
                <tr>
                  <td>${placeLabel(stay)}</td>
                  <td>${spanLabel(stay)}</td>
                  <td class="tv-num">${daysLabel(stay)}</td>
                  <td class="tv-num">${stay.login_count}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
        <p class="tv-note">
          These are the first and last sign-ins seen from each place, so a real trip started before
          the first date and ended after the last. Treat the spans as a floor, not as an itinerary.
        </p>
      </section>
    `;
  }

  private renderTimeline(history: TravelHistoryRow) {
    return html`
      <section class="tv-block">
        <h3 class="tv-heading">Timeline</h3>
        <ol class="tv-timeline">
          ${history.stays.map(
            (stay) => html`
              <li class=${`tv-stay ${stay.away ? "is-away" : "is-home"}`}>
                <span class="tv-stay-dot" aria-hidden="true"></span>
                <div class="tv-stay-body">
                  <span class="tv-stay-place">
                    ${placeLabel(stay)}
                    ${stay.away ? nothing : html`<span class="tv-badge">home</span>`}
                  </span>
                  <span class="tv-stay-meta">
                    ${spanLabel(stay)} · ${daysLabel(stay)} · ${stay.login_count}
                    sign-in${stay.login_count === 1 ? "" : "s"}
                    ${stay.timezone ? html` · ${stay.timezone}` : nothing}
                  </span>
                </div>
              </li>
            `,
          )}
        </ol>
      </section>
    `;
  }

  /**
   * How much of the log this timeline is actually built from.
   *
   * Placed last and drawn plainly, but never conditional on the number being bad: a reader who only
   * sees a coverage warning when something is wrong learns to assume its absence means nothing.
   */
  private renderProvenance(history: TravelHistoryRow) {
    const located = history.login_count - history.unlocated_login_count;
    return html`
      <p class="tv-prov">
        Built from ${located} of ${history.login_count}
        sign-in${history.login_count === 1 ? "" : "s"} in this window, located by the IP address
        each one came from.
        ${history.unlocated_login_count > 0
          ? html`The other ${history.unlocated_login_count} could not be placed — a private network,
            a lookup that timed out, or a sign-in recorded before this page existed.`
          : nothing}
        Nothing here reads your stated location or your calendar, and an inferred city is a guess
        about a network, not a record of where you slept.
      </p>
    `;
  }

  protected override render() {
    const history = this.history;
    return html`
      <style>
        .travel-view {
          display: flex;
          flex-direction: column;
          gap: 18px;
        }
        .tv-ranges {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .tv-range {
          border: 1px solid var(--border, #d6deeb);
          background: transparent;
          color: var(--text-muted, #66799a);
          border-radius: 999px;
          padding: 5px 13px;
          font-size: 13px;
          cursor: pointer;
        }
        .tv-range.is-active {
          background: var(--accent, #4f8cff);
          border-color: var(--accent, #4f8cff);
          color: #fff;
        }
        .tv-summary {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          gap: 12px;
        }
        .tv-stat {
          display: flex;
          flex-direction: column;
          gap: 3px;
          padding: 12px 14px;
          border: 1px solid var(--border, #d6deeb);
          border-radius: 10px;
        }
        .tv-stat-value {
          font-size: 20px;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
        }
        .tv-stat-label {
          font-size: 12px;
          color: var(--text-muted, #66799a);
        }
        .tv-block {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .tv-block-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .tv-heading {
          margin: 0;
          font-size: 15px;
        }
        .tv-copy {
          border: 1px solid var(--border, #d6deeb);
          background: transparent;
          color: inherit;
          border-radius: 7px;
          padding: 5px 11px;
          font-size: 12px;
          cursor: pointer;
        }
        .tv-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }
        .tv-table th,
        .tv-table td {
          text-align: left;
          padding: 7px 9px;
          border-bottom: 1px solid var(--border, #d6deeb);
        }
        .tv-table th {
          font-weight: 600;
          color: var(--text-muted, #66799a);
          font-size: 12px;
        }
        .tv-num {
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
        .tv-timeline {
          list-style: none;
          margin: 0;
          padding: 0 0 0 4px;
          display: flex;
          flex-direction: column;
        }
        .tv-stay {
          display: flex;
          gap: 12px;
          padding: 0 0 14px 0;
          position: relative;
        }
        /* The connecting rail. Drawn behind the dots and stopped on the last row so the timeline
           does not trail off past its own end. */
        .tv-stay:not(:last-child)::before {
          content: "";
          position: absolute;
          left: 4px;
          top: 12px;
          bottom: 0;
          width: 1px;
          background: var(--border, #d6deeb);
        }
        .tv-stay-dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          margin-top: 4px;
          flex: none;
          background: var(--text-muted, #66799a);
        }
        .tv-stay.is-away .tv-stay-dot {
          background: var(--accent, #4f8cff);
        }
        .tv-stay-body {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .tv-stay-place {
          font-weight: 600;
          font-size: 14px;
        }
        .tv-badge {
          margin-left: 6px;
          font-size: 11px;
          font-weight: 500;
          color: var(--text-muted, #66799a);
          border: 1px solid var(--border, #d6deeb);
          border-radius: 999px;
          padding: 1px 7px;
        }
        .tv-stay-meta {
          font-size: 12px;
          color: var(--text-muted, #66799a);
        }
        .tv-note,
        .tv-prov,
        .tv-empty {
          margin: 0;
          font-size: 12px;
          color: var(--text-muted, #66799a);
          line-height: 1.55;
        }
        .tv-error {
          margin: 0;
          font-size: 13px;
          color: var(--danger, #d2544b);
        }
      </style>
      <section class="travel-view">
        <p class="tv-note">
          Your own travel, worked out from where each of your sign-ins came from. Nobody else's
          record is reachable from this page.
        </p>
        ${this.renderRanges()} ${this.error ? html`<p class="tv-error">${this.error}</p>` : nothing}
        ${!history && this.loading
          ? html`<p class="tv-empty">Reading your sign-in log…</p>`
          : nothing}
        ${history && history.stays.length === 0
          ? html`<p class="tv-empty">
              No sign-in in this window could be placed, so there is no timeline to draw yet.
            </p>`
          : nothing}
        ${history && history.stays.length > 0
          ? html`
              ${this.renderSummary(history)} ${this.renderTrips(history)}
              ${this.renderTimeline(history)}
            `
          : nothing}
        ${history ? this.renderProvenance(history) : nothing}
      </section>
    `;
  }
}

if (!customElements.get("adminbot-travel-view")) {
  customElements.define("adminbot-travel-view", AdminbotTravelView);
}

export function renderTravel(props: {
  history: TravelHistoryRow | null;
  range: TravelRange;
  loading: boolean;
  error: string | null;
  onRangeChange: (range: TravelRange) => void;
}) {
  return html`<adminbot-travel-view
    .history=${props.history}
    .range=${props.range}
    .loading=${props.loading}
    .error=${props.error}
    .onRangeChange=${props.onRangeChange}
  ></adminbot-travel-view>`;
}
