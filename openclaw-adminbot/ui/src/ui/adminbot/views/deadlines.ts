// Control UI view renders the AdminBot deadline tracker (Output 0 tab).
// Self-contained: reads the bundled DEADLINE_VENUES snapshot and lists upcoming
// conference/workshop deadlines with AoE-correct dates and a LIVE per-second
// countdown (days + HH:MM:SS) that ticks in place. The standalone board served
// at GET /deadlines uses the same data (see docs/tools/adminbot-deadlines.md).
//
// One row per conference, expandable to the workshops running under it.
//
// The dataset is 105 entries and 99 of them are NeurIPS 2026 workshops sharing a single instant,
// so any flat rendering is really one obligation wearing ninety-nine rows. Collapsing to the
// conference makes the board its actual size -- five things -- and puts the workshop list behind
// one click by someone who has decided they care about that conference.
//
// Workshops are tied to their conference through venue_group, which the generator emits as
// "<conference> Workshops"; stripping that suffix is the whole join.
//
// Styling lives in styles/layout.css with the rest of the app. It used to be an inline <style>
// block naming --surface, --text-muted and a set of hardcoded hexes, none of which exist in this
// design system -- so every rule fell through to its fallback and the tab rendered in a different
// blue-grey theme than the product around it.
import { html, nothing, LitElement } from "lit";
import { icons } from "../../icons.ts";
// AoE parsing, the countdown format and the urgency bands are shared with the profile-page
// summary; see data/deadline-time.ts for why they live outside this view.
import {
  aoeDateLabel,
  aoeInstantMs,
  countdownLabel,
  urgencyOf,
  type DeadlineEntry as Entry,
} from "../data/deadline-time.ts";
import { DEADLINE_VENUES, type DeadlineVenue } from "../data/deadlines.ts";

/**
 * Whether submitting somewhere consumes the paper.
 *
 * The split the board is organised around, because it is the question a member is
 * actually asking when they scan these dates: an archival venue publishes the work
 * in proceedings, so it cannot then go to a second archival venue, while a workshop
 * leaves it free to be submitted onward. One date is a commitment and the other is
 * an opportunity, and a flat list of 120 entries says nothing about which is which.
 *
 * `rebuttal` is neither: it is work on a paper already submitted, not somewhere to
 * send a new one, so it is kept out of both columns rather than filed under the one
 * it least resembles.
 */
type Kind = "archival" | "nonArchival" | "other";

// Read off the field the collector stamps rather than re-derived here. The policy
// lives once, in scripts/adminbot_deadlines.py; a copy of the rule in the view is
// how the mandatory-profile-field lists drifted.
function kindOf(venue: DeadlineVenue): Kind {
  if (venue.venue_type === "rebuttal") {
    return "other";
  }
  return venue.archival ? "archival" : "nonArchival";
}

type Conference = {
  key: string;
  archival: Entry[];
  nonArchival: Entry[];
  other: Entry[];
  // Soonest instant anywhere under this conference, which is what the collapsed row counts down to.
  nextInstant: number;
  nextEntry: Entry;
};

export type DeadlineFilter = "all" | "archival" | "nonArchival";

// "NeurIPS 2026 Workshops" and "NeurIPS 2026" are the same conference. The generator emits no
// explicit parent id, so the suffix is the join; a group without it is already the conference.
function conferenceKeyOf(venue: DeadlineVenue): string {
  const group = (venue.venue_group ?? "").trim();
  return group.replace(/\s+workshops$/iu, "") || venue.name;
}

const byInstant = (a: Entry, b: Entry) => a.instant - b.instant;

export function buildConferences(now: number, filter: DeadlineFilter = "all"): Conference[] {
  const byKey = new Map<string, Record<Kind, Entry[]>>();
  for (const venue of DEADLINE_VENUES) {
    const instant = aoeInstantMs(venue.deadline_aoe);
    if (!Number.isFinite(instant) || instant <= now) {
      continue;
    }
    const kind = kindOf(venue);
    // A rebuttal is not a submission either way, so it stays visible under its
    // conference whichever column the reader has asked for -- filtering it out
    // would hide a date nobody chose to exclude.
    if (filter !== "all" && kind !== "other" && kind !== filter) {
      continue;
    }
    const key = conferenceKeyOf(venue);
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { archival: [], nonArchival: [], other: [] };
      byKey.set(key, bucket);
    }
    bucket[kind].push({ venue, instant });
  }

  return [...byKey]
    .map(([key, bucket]) => {
      const archival = bucket.archival.toSorted(byInstant);
      const nonArchival = bucket.nonArchival.toSorted(byInstant);
      const other = bucket.other.toSorted(byInstant);
      // Each list is sorted, so the soonest overall is whichever head comes first.
      const nextEntry = [archival[0], nonArchival[0], other[0]]
        .filter(Boolean)
        .toSorted(byInstant)[0];
      return { key, archival, nonArchival, other, nextInstant: nextEntry.instant, nextEntry };
    })
    // A conference left with nothing after filtering is not a conference to show.
    .filter((conference) => conference.nextEntry !== undefined)
    .toSorted((a, b) => a.nextInstant - b.nextInstant);
}

// Facts every entry in a list happens to agree on. Ninety-nine workshops sharing one date and one
// notification date print those ninety-nine times unless they are hoisted, which buries the only
// part that varies: the workshop's name.
type SharedFacts = { date?: string; notification?: string };

function sharedOf(entries: Entry[], pick: (venue: DeadlineVenue) => string | undefined) {
  if (entries.length < 2) {
    return undefined;
  }
  const first = pick(entries[0].venue)?.trim();
  if (!first) {
    return undefined;
  }
  return entries.every((entry) => pick(entry.venue)?.trim() === first) ? first : undefined;
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

function renderLabel(venue: DeadlineVenue) {
  return venue.deadline_label
    ? html`<span class="deadline-row__label">${venue.deadline_label}</span>`
    : nothing;
}

// Which ARR route a date is, spelled out. The *ACL venues take papers two ways and
// only one of them is open to any given paper: `direct` starts a fresh review cycle,
// `commitment` attaches reviews the paper already has. Reading that off a
// deadline_label like "commitment" meant knowing the convention; the chip says it.
function renderRoute(venue: DeadlineVenue) {
  if (venue.submission_type !== "direct" && venue.submission_type !== "commitment") {
    return nothing;
  }
  const direct = venue.submission_type === "direct";
  return html`<span
    class="deadline-row__route"
    data-route=${venue.submission_type}
    title=${direct
      ? "Submit a new paper into this ARR cycle"
      : "Commit a paper that already has ARR reviews"}
    >${direct ? "direct" : "commitment"}</span
  >`;
}

// Custom element so the countdown owns a 1s timer and re-renders itself; a plain
// render function cannot manage the tick lifecycle. Light DOM (createRenderRoot
// returns this) lets the app's theme CSS variables cascade into the rows.
class AdminbotDeadlinesView extends LitElement {
  private timer: number | undefined;

  // Which conferences are open. Instance state rather than module-level, so a remount does not
  // inherit the previous board's disclosures. It survives the 1s re-render because the element
  // itself is not recreated.
  private readonly expanded = new Set<string>();

  // Which column the reader has asked for. Instance state for the same reason the
  // disclosures are: a remount should open on the whole board, not on whatever the
  // last visit narrowed it to.
  private filter: DeadlineFilter = "all";

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

  private setFilter(filter: DeadlineFilter): void {
    this.filter = filter;
    this.requestUpdate();
  }

  private renderFilter(counts: Record<DeadlineFilter, number>) {
    const options: Array<{ id: DeadlineFilter; label: string }> = [
      { id: "all", label: "All" },
      { id: "archival", label: "Archival" },
      { id: "nonArchival", label: "Non-archival" },
    ];
    return html`
      <div class="deadlines__filter" role="group" aria-label="Filter deadlines">
        ${options.map(
          (option) => html`
            <button
              type="button"
              class="btn btn--sm"
              data-testid=${`deadline-filter-${option.id}`}
              aria-pressed=${this.filter === option.id}
              ?disabled=${this.filter === option.id}
              @click=${() => this.setFilter(option.id)}
            >
              ${option.label}
              <span class="deadlines__filter-count">${counts[option.id]}</span>
            </button>
          `,
        )}
      </div>
    `;
  }

  private toggle(key: string): void {
    if (this.expanded.has(key)) {
      this.expanded.delete(key);
    } else {
      this.expanded.add(key);
    }
    this.requestUpdate();
  }

  // One deadline inside an opened conference. The date column disappears whenever the whole list
  // shares one date, which for a workshop track is the normal case.
  private renderEntry(entry: Entry, shared: SharedFacts, now: number) {
    const { venue, instant } = entry;
    return html`
      <li class="deadline-row" data-urgency=${urgencyOf(instant, now)}>
        <span class="deadline-row__countdown">${countdownLabel(instant - now)}</span>
        ${shared.date
          ? nothing
          : html`<span class="deadline-row__date">${aoeDateLabel(venue.deadline_aoe)}</span>`}
        <span class="deadline-row__body">
          <span class="deadline-row__name">${venue.name}${renderLabel(venue)}${renderRoute(venue)}</span>
          ${venue.notification_aoe && !shared.notification
            ? html`<span class="deadline-row__note"
                >notified ${aoeDateLabel(venue.notification_aoe)}</span
              >`
            : nothing}
        </span>
        ${renderVenueLink(venue)}
      </li>
    `;
  }

  private renderSection(title: string, entries: Entry[], now: number, hoist: boolean) {
    if (!entries.length) {
      return nothing;
    }
    const shared: SharedFacts = hoist
      ? {
          date: sharedOf(entries, (venue) => venue.deadline_aoe),
          notification: sharedOf(entries, (venue) => venue.notification_aoe),
        }
      : {};
    const sharedNote = [
      shared.date ? `all due ${aoeDateLabel(shared.date)} AoE` : "",
      shared.notification ? `notified ${aoeDateLabel(shared.notification)}` : "",
    ].filter(Boolean);
    return html`
      <div class="deadline-section">
        <p class="deadline-section__head">
          <span class="deadline-section__title">${title}</span>
          <span class="deadline-section__count">${entries.length}</span>
          ${sharedNote.length
            ? html`<span class="deadline-section__shared">${sharedNote.join(" · ")}</span>`
            : nothing}
        </p>
        <ul class="deadline-section__list">
          ${entries.map((entry) => this.renderEntry(entry, shared, now))}
        </ul>
      </div>
    `;
  }

  private renderConference(conference: Conference, now: number) {
    const { key, archival, nonArchival, other, nextInstant } = conference;
    const open = this.expanded.has(key);
    const panelId = `deadlines-panel-${key.replaceAll(/\W+/gu, "-").toLowerCase()}`;
    const counts = [
      archival.length ? `${archival.length} archival` : "",
      nonArchival.length ? `${nonArchival.length} non-archival` : "",
      other.length ? `${other.length} other` : "",
    ].filter(Boolean);
    return html`
      <li class="conference" data-urgency=${urgencyOf(nextInstant, now)} ?data-open=${open}>
        <button
          type="button"
          class="conference__summary"
          aria-expanded=${open ? "true" : "false"}
          aria-controls=${panelId}
          data-testid="conference-toggle"
          @click=${() => this.toggle(key)}
        >
          <span class="conference__chevron" aria-hidden="true">${icons.chevronRight}</span>
          <span class="conference__countdown">${countdownLabel(nextInstant - now)}</span>
          <span class="conference__name">${key}</span>
          <span class="conference__counts">${counts.join(" · ")}</span>
        </button>
        <div class="conference__panel" id=${panelId} ?hidden=${!open}>
          ${this.renderSection("Archival — publishing here consumes the paper", archival, now, false)}
          ${this.renderSection("Non-archival — the paper stays free", nonArchival, now, true)}
          ${this.renderSection("Other dates", other, now, false)}
        </div>
      </li>
    `;
  }

  // The single most urgent thing anywhere, stated once at full size. It is a shortcut, not an
  // index: the conference list below stays complete, so this deadline is still reachable inside
  // its own conference rather than removed from it.
  private renderLead(entry: Entry, now: number) {
    const { venue, instant } = entry;
    return html`
      <section class="deadline-lead" data-urgency=${urgencyOf(instant, now)}>
        <p class="deadline-lead__eyebrow">Next deadline</p>
        <p class="deadline-lead__countdown">${countdownLabel(instant - now)}</p>
        <p class="deadline-lead__name">${venue.name}${renderLabel(venue)}${renderRoute(venue)}</p>
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
    const conferences = buildConferences(now, this.filter);
    // Counted off the unfiltered board so the chips keep saying how much each column
    // holds while one of them is selected -- a count that changed with the filter
    // would only ever report the filter back to itself.
    const all = buildConferences(now, "all");
    const tally = (pick: (conference: Conference) => Entry[]) =>
      all.reduce((sum, conference) => sum + pick(conference).length, 0);
    const counts: Record<DeadlineFilter, number> = {
      all: tally((c) => [...c.archival, ...c.nonArchival, ...c.other]),
      archival: tally((c) => c.archival),
      nonArchival: tally((c) => c.nonArchival),
    };

    if (!all.length) {
      return html`
        <section class="deadlines">
          <p class="deadlines__empty">
            No upcoming deadlines in the bundled dataset. It is a point-in-time snapshot, so this
            most likely means it needs regenerating rather than that the field has gone quiet.
          </p>
        </section>
      `;
    }

    const total = counts[this.filter];
    return html`
      <section class="deadlines">
        ${conferences.length ? this.renderLead(conferences[0].nextEntry, now) : nothing}
        ${this.renderFilter(counts)}
        <p class="deadlines__intro">
          Times are AoE (UTC&#8209;12) and countdowns tick live. ${conferences.length}
          ${conferences.length === 1 ? "conference" : "conferences"}, ${total} deadlines. Archival
          venues publish the paper, so it cannot go to a second one; non-archival venues leave it
          free. Open a conference for its dates.
        </p>
        ${conferences.length
          ? html`<ul class="conferences">
              ${conferences.map((conference) => this.renderConference(conference, now))}
            </ul>`
          : html`<p class="deadlines__empty">Nothing upcoming in this column.</p>`}
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
