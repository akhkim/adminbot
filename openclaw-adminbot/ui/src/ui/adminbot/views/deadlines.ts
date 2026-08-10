// Control UI view renders the AdminBot deadline tracker (Output 0 tab).
// Self-contained: reads the bundled DEADLINE_VENUES snapshot and lists upcoming
// conference/workshop deadlines with AoE-correct dates and a LIVE per-second
// countdown (days + HH:MM:SS) that ticks in place. The standalone board served
// at GET /deadlines uses the same data (see docs/tools/adminbot-deadlines.md).
//
// The board answers "how much time do I have" before "what conferences exist", so it leads with
// the single nearest deadline and then groups everything else under the date it is due.
//
// Grouping by date rather than by row is what this dataset actually wants. A whole workshop track
// shares one submission date -- sixty NeurIPS workshops land on the same instant -- so a flat list
// printed the same countdown sixty times down the page and made an enormous single-day cluster
// look like sixty unrelated obligations. The countdown belongs to the date; the rows underneath
// only have to say what differs. (Grouping by month was tried first and segmented nothing: 103 of
// the 106 bundled venues fall inside one month.)
//
// Styling lives in styles/layout.css with the rest of the app. It used to be an inline <style>
// block naming --surface, --text-muted and a set of hardcoded hexes, none of which exist in this
// design system -- so every rule fell through to its fallback and the tab rendered in a different
// blue-grey theme than the product around it.
import { html, nothing, LitElement } from "lit";
import { DEADLINE_VENUES, type DeadlineVenue } from "../data/deadlines.ts";

const MS_DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// AoE (UTC-12): a wall-clock deadline maps to its UTC instant + 12h.
function aoeInstantMs(aoe: string): number {
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/u.exec(aoe);
  if (!m) {
    return Number.NaN;
  }
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s) + 12 * 3600 * 1000;
}

// Display the AoE calendar date (not the +12h-shifted UTC date).
function aoeDateLabel(aoe: string): string {
  const m = /(\d{4})-(\d{2})-(\d{2})/u.exec(aoe);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : "";
}

// The AoE calendar day a deadline belongs to, as a grouping key.
function aoeDayKey(aoe: string): string {
  const m = /(\d{4})-(\d{2})-(\d{2})/u.exec(aoe);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

function dayHeading(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  return `${MONTHS_LONG[month - 1]} ${day}, ${year}`;
}

// Four bands rather than a gradient: a countdown is read as "can I still start this", and that
// question has a small number of distinct answers. Named for the token each one resolves to, so
// urgency is a design-system color and not a hex chosen per component.
type Urgency = "critical" | "soon" | "planned" | "distant";

function urgencyOf(days: number): Urgency {
  if (days <= 3) {
    return "critical";
  }
  if (days <= 7) {
    return "soon";
  }
  if (days <= 30) {
    return "planned";
  }
  return "distant";
}

const pad = (n: number): string => String(n).padStart(2, "0");

// Remaining time as "Nd HH:MM:SS" (AoE deadlines can be same-day, so we always show
// hours:minutes:seconds instead of collapsing a due-today item to "0d"). Inside the last day the
// leading "0d" is dropped: it reads as a zero quantity when what it actually means is "today".
function countdownLabel(ms: number): string {
  const left = Math.max(ms, 0);
  const d = Math.floor(left / MS_DAY);
  const h = Math.floor(left / 3_600_000) % 24;
  const m = Math.floor(left / 60_000) % 60;
  const s = Math.floor(left / 1000) % 60;
  const clock = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return d > 0 ? `${d}d ${clock}` : clock;
}

type Row = { venue: DeadlineVenue; instant: number; days: number; urgency: Urgency };

// Facts every venue in a band happens to agree on. A hundred workshops from one track share their
// group, their deadline kind and their notification date, so printing those on all hundred rows
// says nothing a reader can act on and buries the venue name, which is the only part that varies.
type SharedFacts = {
  label?: string;
  group?: string;
  notification?: string;
};

type DayGroup = {
  key: string;
  heading: string;
  instant: number;
  urgency: Urgency;
  shared: SharedFacts;
  rows: Row[];
};

// A value only when every row has it and they all agree, and only worth hoisting when there is
// more than one row to hoist it out of.
function sharedOf(rows: Row[], pick: (venue: DeadlineVenue) => string | undefined) {
  if (rows.length < 2) {
    return undefined;
  }
  const first = pick(rows[0].venue)?.trim();
  if (!first) {
    return undefined;
  }
  return rows.every((row) => pick(row.venue)?.trim() === first) ? first : undefined;
}

function groupByDay(rows: Row[]): DayGroup[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = aoeDayKey(row.venue.deadline_aoe);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  // Rows arrive sorted by instant, so insertion order is already chronological. Every row in a
  // group shares the day, so the first one's instant and urgency speak for the whole group.
  return [...groups].map(([key, groupRows]) => ({
    key,
    heading: dayHeading(key),
    instant: groupRows[0].instant,
    urgency: groupRows[0].urgency,
    shared: {
      label: sharedOf(groupRows, (venue) => venue.deadline_label),
      group: sharedOf(groupRows, (venue) =>
        venue.venue_type === "workshop" ? venue.venue_group : undefined,
      ),
      notification: sharedOf(groupRows, (venue) => venue.notification_aoe),
    },
    rows: groupRows,
  }));
}

// The external link needs a name a screen reader can announce; the bare arrow it used to be
// announced as "link" and nothing else, a hundred times down the page.
function renderVenueLink(venue: DeadlineVenue) {
  if (!venue.link) {
    return nothing;
  }
  return html`
    <a
      class="deadline-row__link"
      href=${venue.link}
      target="_blank"
      rel="noopener noreferrer"
      aria-label=${`${venue.name} — official site`}
      title="Official site"
      >↗</a
    >
  `;
}

// Facts the dataset already carried and the old list dropped: which deadline this is (a
// commitment and a submission for the same venue are different dates people miss), and when the
// answer comes back.
function renderVenueMeta(venue: DeadlineVenue, shared: SharedFacts) {
  const parts: unknown[] = [];
  if (venue.venue_type === "workshop" && venue.venue_group && !shared.group) {
    parts.push(html`<span class="deadline-row__note">${venue.venue_group}</span>`);
  }
  if (venue.notification_aoe && !shared.notification) {
    parts.push(
      html`<span class="deadline-row__note"
        >notified ${aoeDateLabel(venue.notification_aoe)}</span
      >`,
    );
  }
  if (!parts.length) {
    return nothing;
  }
  return html`<span class="deadline-row__meta">${parts}</span>`;
}

// The band's own subtitle: whatever the whole day has in common, said once.
function renderSharedFacts(shared: SharedFacts) {
  const parts: string[] = [];
  if (shared.group) {
    parts.push(shared.group);
  }
  if (shared.label) {
    parts.push(shared.label);
  }
  if (shared.notification) {
    parts.push(`notified ${aoeDateLabel(shared.notification)}`);
  }
  if (!parts.length) {
    return nothing;
  }
  return html`<p class="deadlines__day-shared">${parts.join(" · ")}</p>`;
}

// Custom element so the countdown owns a 1s timer and re-renders itself; a plain
// render function cannot manage the tick lifecycle. Light DOM (createRenderRoot
// returns this) lets the app's theme CSS variables cascade into the rows.
class AdminbotDeadlinesView extends LitElement {
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

  // No countdown and no date here: the band above the group owns both, and every row under it
  // shares them exactly.
  private renderRow(row: Row, shared: SharedFacts) {
    const { venue } = row;
    return html`
      <li class="deadline-row">
        <span class="deadline-row__body">
          <span class="deadline-row__name">
            ${venue.name}
            ${venue.deadline_label && !shared.label
              ? html`<span class="deadline-row__label">${venue.deadline_label}</span>`
              : nothing}
          </span>
          ${renderVenueMeta(venue, shared)}
        </span>
        ${renderVenueLink(venue)}
      </li>
    `;
  }

  // The one deadline the clock is actually running on. It is pulled out of the list below rather
  // than repeated in it -- a board that shows its most urgent item twice is asking the reader to
  // work out whether they are the same thing.
  private renderLead(row: Row) {
    const { venue, instant, urgency } = row;
    return html`
      <section class="deadline-lead" data-urgency=${urgency}>
        <p class="deadline-lead__eyebrow">Next deadline</p>
        <p class="deadline-lead__countdown">${countdownLabel(instant - Date.now())}</p>
        <p class="deadline-lead__name">
          ${venue.name}
          ${venue.deadline_label
            ? html`<span class="deadline-row__label">${venue.deadline_label}</span>`
            : nothing}
        </p>
        <p class="deadline-lead__date">
          ${aoeDateLabel(venue.deadline_aoe)}
          AoE${venue.notification_aoe ? ` · notified ${aoeDateLabel(venue.notification_aoe)}` : ""}
        </p>
        ${renderVenueLink(venue)}
      </section>
    `;
  }

  override render() {
    const now = Date.now();
    const rows: Row[] = DEADLINE_VENUES.map((venue) => {
      const instant = aoeInstantMs(venue.deadline_aoe);
      const days = Math.floor((instant - now) / MS_DAY);
      return { venue, instant, days, urgency: urgencyOf(days) };
    })
      .filter((r) => Number.isFinite(r.instant) && r.instant > now)
      .toSorted((a, b) => a.instant - b.instant);

    if (!rows.length) {
      return html`
        <section class="deadlines">
          <p class="deadlines__empty">
            No upcoming deadlines in the bundled dataset. It is a point-in-time snapshot, so this
            most likely means it needs regenerating rather than that the field has gone quiet.
          </p>
        </section>
      `;
    }

    const [lead, ...rest] = rows;
    return html`
      <section class="deadlines">
        ${this.renderLead(lead)}
        <p class="deadlines__intro">
          Times are AoE (UTC&#8209;12) and countdowns tick live. ${rows.length} upcoming across
          ${groupByDay(rows).length} dates.
        </p>
        ${groupByDay(rest).map(
          (group) => html`
            <div class="deadlines__day" data-urgency=${group.urgency}>
              <h3 class="deadlines__day-head">
                <span class="deadlines__day-countdown"
                  >${countdownLabel(group.instant - Date.now())}</span
                >
                <span class="deadlines__day-name">${group.heading} AoE</span>
                <span class="deadlines__day-count">
                  ${group.rows.length} ${group.rows.length === 1 ? "venue" : "venues"}
                </span>
              </h3>
              ${renderSharedFacts(group.shared)}
              <ul class="deadlines__list">
                ${group.rows.map((row) => this.renderRow(row, group.shared))}
              </ul>
            </div>
          `,
        )}
      </section>
    `;
  }
}

if (!customElements.get("adminbot-deadlines-view")) {
  customElements.define("adminbot-deadlines-view", AdminbotDeadlinesView);
}

export function renderDeadlines() {
  return html`<adminbot-deadlines-view></adminbot-deadlines-view>`;
}
