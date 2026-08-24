// Native Control UI rendering of Deadline Tracker Output 0.
//
// The service also exposes a self-contained version at GET /deadlines. Both surfaces read the
// generated deadline dataset and present the same board: next deadline, aggregate counts, venue
// filters, search, and card/table views. This renderer stays in the app's document flow so the
// containing Control UI pane owns one ordinary vertical scroll; there is no iframe or nested page.

import { html, nothing, LitElement } from "lit";
import { t } from "../../../i18n/index.ts";
import {
  aoeDateLabel,
  aoeDateTimeLabel,
  aoeInstantMs,
  countdownLabel,
  MS_DAY,
  urgencyOf,
  type Urgency,
} from "../data/deadline-time.ts";
import { DEADLINE_VENUES, type DeadlineVenue } from "../data/deadlines.ts";

export type DeadlineBoardEntry = { venue: DeadlineVenue; instant: number };
type DeadlineGroupKind = "archival" | "nonArchival" | "mixed" | "unknown" | "other";
export type DeadlineBoardGroup = {
  id: string;
  label: string;
  entries: DeadlineBoardEntry[];
  instant: number;
  sections: Record<DeadlineGroupKind, DeadlineBoardEntry[]>;
};
export type DeadlineBoardView = "cards" | "groups" | "table";
type DeadlineUrgency = Urgency | "passed";

export function buildDeadlineBoardEntries(): DeadlineBoardEntry[] {
  return DEADLINE_VENUES.map((venue) => ({ venue, instant: aoeInstantMs(venue.deadline_aoe) }))
    .filter((entry) => Number.isFinite(entry.instant))
    .toSorted(
      (left, right) =>
        left.instant - right.instant || left.venue.name.localeCompare(right.venue.name),
    );
}

export function filterDeadlineBoardEntries(
  entries: readonly DeadlineBoardEntry[],
  group: string,
  query: string,
): DeadlineBoardEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter(({ venue }) => {
    if (group && venue.venue_group !== group) {
      return false;
    }
    if (!needle) {
      return true;
    }
    return [venue.name, venue.venue_group, venue.entry_type, venue.deadline_label]
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle);
  });
}

export function groupDeadlineBoardEntries(
  entries: readonly DeadlineBoardEntry[],
): DeadlineBoardGroup[] {
  const groups = new Map<string, DeadlineBoardGroup>();
  for (const entry of entries) {
    const id = entry.venue.venue_group.trim();
    const kind: DeadlineGroupKind =
      entry.venue.entry_type === "rebuttal"
        ? "other"
        : entry.venue.archival_status === "archival"
          ? "archival"
          : entry.venue.archival_status === "non_archival"
            ? "nonArchival"
            : entry.venue.archival_status === "mixed"
              ? "mixed"
              : "unknown";
    const current = groups.get(id);
    if (current) {
      current.entries.push(entry);
      current.sections[kind].push(entry);
    } else {
      const sections: Record<DeadlineGroupKind, DeadlineBoardEntry[]> = {
        archival: [],
        nonArchival: [],
        mixed: [],
        unknown: [],
        other: [],
      };
      sections[kind].push(entry);
      groups.set(id, {
        id,
        label: id,
        entries: [entry],
        instant: entry.instant,
        sections,
      });
    }
  }
  return [...groups.values()];
}

function groupOptions(entries: readonly DeadlineBoardEntry[]) {
  const groups = new Map<string, { id: string; label: string; count: number }>();
  for (const entry of entries) {
    const current = groups.get(entry.venue.venue_group);
    if (current) {
      current.count += 1;
    } else {
      groups.set(entry.venue.venue_group, {
        id: entry.venue.venue_group,
        label: entry.venue.venue_group,
        count: 1,
      });
    }
  }
  return [...groups.values()];
}

export function workshopSourceLinks(venue: DeadlineVenue): {
  titleUrl: string;
  sourceUrl: string;
  sourceLabel: "Call for papers" | "Official site" | "";
  openReviewUrl: string;
} | null {
  if (venue.entry_type !== "workshop") {
    return null;
  }
  const cfpUrl = venue.cfp_url?.trim() || "";
  const homepageUrl = venue.homepage_url?.trim() || "";
  return {
    titleUrl: homepageUrl,
    sourceUrl: cfpUrl || homepageUrl,
    sourceLabel: cfpUrl ? "Call for papers" : homepageUrl ? "Official site" : "",
    openReviewUrl: venue.openreview_url?.trim() || "",
  };
}

function renderDeadlineTitle(venue: DeadlineVenue, label = venue.name) {
  const titleUrl = workshopSourceLinks(venue)?.titleUrl || venue.link?.trim();
  return titleUrl
    ? html`<a href=${titleUrl} target="_blank" rel="noopener noreferrer">${label}</a>`
    : label;
}

const ENTRY_TYPE_LABELS: Record<DeadlineVenue["entry_type"], string> = {
  main_conference: "Main conference",
  demo_track: "Demo track",
  workshop: "Workshop",
  arr_direct_submission: "ARR direct submission",
  arr_commitment: "ARR commitment",
  rebuttal: "Rebuttal",
  other: "Other",
};

function urgency(entry: DeadlineBoardEntry, now: number): DeadlineUrgency {
  return entry.instant <= now ? "passed" : urgencyOf(entry.instant, now);
}

function urgencyLabel(entry: DeadlineBoardEntry, now: number): string {
  const diff = entry.instant - now;
  if (diff <= 0) {
    return "passed";
  }
  const days = Math.floor(diff / MS_DAY);
  return days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} left`;
}

function capitalize(value: string): string {
  return value ? `${value[0].toLocaleUpperCase()}${value.slice(1)}` : "Deadline";
}

function groupRowTitle(venue: DeadlineVenue, conference: string) {
  const stage = capitalize(venue.deadline_label);
  const titleContext = venue.venue_group.trim().replace(/\s+workshops$/iu, "") || conference;
  let name = venue.name.trim();
  for (const affix of [` (${titleContext})`, ` [${titleContext}]`]) {
    if (name.endsWith(affix)) {
      name = name.slice(0, -affix.length).trim();
    }
  }
  for (const separator of [" — ", " – ", " - ", ": "]) {
    if (name.startsWith(`${titleContext}${separator}`)) {
      name = name.slice(titleContext.length + separator.length).trim();
    }
  }
  if (name.toLocaleLowerCase() === titleContext.toLocaleLowerCase()) {
    return { name: stage, stage: "" };
  }
  if (stage.toLocaleLowerCase() === "arr commitment") {
    name = name.replace(/\s*(?:\(ARR commitment\)|[-—–:]?\s*ARR commitment)$/iu, "").trim();
  }
  return { name: name || venue.name, stage };
}

function countdownParts(diff: number) {
  const left = Math.max(diff, 0);
  return {
    days: Math.floor(left / MS_DAY),
    hours: Math.floor(left / 3_600_000) % 24,
    minutes: Math.floor(left / 60_000) % 60,
    seconds: Math.floor(left / 1000) % 60,
  };
}

const pad = (value: number): string => String(value).padStart(2, "0");

function aoeDayKey(now: number): string {
  return new Date(now - 12 * 3_600_000).toISOString().slice(0, 10);
}

class AdminbotDeadlinesView extends LitElement {
  private timer: number | undefined;
  private readonly expandedGroups = new Set<string>();
  private now = Date.now();
  private activeGroup = "";
  private query = "";
  private view: DeadlineBoardView = "groups";

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.timer = window.setInterval(() => {
      this.now = Date.now();
      this.requestUpdate();
    }, 1000);
  }

  override disconnectedCallback(): void {
    if (this.timer !== undefined) {
      window.clearInterval(this.timer);
      this.timer = undefined;
    }
    super.disconnectedCallback();
  }

  private selectGroup(group: string): void {
    this.activeGroup = group;
    this.requestUpdate();
  }

  private setQuery(event: Event): void {
    this.query = (event.currentTarget as HTMLInputElement).value;
    this.requestUpdate();
  }

  private setView(view: DeadlineBoardView): void {
    this.view = view;
    this.requestUpdate();
  }

  private toggleGroup(group: string): void {
    if (this.expandedGroups.has(group)) {
      this.expandedGroups.delete(group);
    } else {
      this.expandedGroups.add(group);
    }
    this.requestUpdate();
  }

  private renderHero(entry: DeadlineBoardEntry | undefined) {
    if (!entry) {
      return html`
        <section class="deadline-board__hero">
          <p class="deadline-board__eyebrow">Next deadline</p>
          <h2 class="deadline-board__hero-name">Nothing matches this filter</h2>
        </section>
      `;
    }
    const parts = countdownParts(entry.instant - this.now);
    return html`
      <section class="deadline-board__hero" data-urgency=${urgency(entry, this.now)}>
        <p class="deadline-board__eyebrow">Next deadline · ${entry.venue.venue_group}</p>
        <h2 class="deadline-board__hero-name">${renderDeadlineTitle(entry.venue)}</h2>
        <p class="deadline-board__hero-meta">
          ${capitalize(entry.venue.deadline_label)} · ${aoeDateTimeLabel(entry.venue.deadline_aoe)}
          ·
          <span>${urgencyLabel(entry, this.now)}</span>
        </p>
        <div
          class="deadline-board__hero-countdown"
          aria-label=${countdownLabel(entry.instant - this.now)}
        >
          ${this.renderCountdownUnit(parts.days, "days")}
          <span aria-hidden="true">:</span>
          ${this.renderCountdownUnit(pad(parts.hours), "hrs")}
          <span aria-hidden="true">:</span>
          ${this.renderCountdownUnit(pad(parts.minutes), "min")}
          <span aria-hidden="true">:</span>
          ${this.renderCountdownUnit(pad(parts.seconds), "sec")}
        </div>
      </section>
    `;
  }

  private renderCountdownUnit(value: string | number, label: string) {
    return html`<span class="deadline-board__countdown-unit">
      <strong>${value}</strong><small>${label}</small>
    </span>`;
  }

  private renderStats(entries: readonly DeadlineBoardEntry[]) {
    const upcoming = entries.filter((entry) => entry.instant > this.now);
    const within = (days: number) =>
      upcoming.filter((entry) => entry.instant - this.now <= days * MS_DAY).length;
    const today = upcoming.filter(
      (entry) => entry.venue.deadline_aoe.slice(0, 10) === aoeDayKey(this.now),
    ).length;
    return html`
      <dl class="deadline-board__stats">
        <div>
          <dt>Matching deadlines</dt>
          <dd>${entries.length}</dd>
        </div>
        <div>
          <dt>Due today</dt>
          <dd data-urgency="critical">${today}</dd>
        </div>
        <div>
          <dt>Due within 7 days</dt>
          <dd data-urgency="soon">${within(7)}</dd>
        </div>
        <div>
          <dt>Due within 30 days</dt>
          <dd data-urgency="planned">${within(30)}</dd>
        </div>
      </dl>
    `;
  }

  private renderModes() {
    return html`
      <div class="deadline-board__modes">
        <div class="deadline-board__view" role="group" aria-label="View">
          <button
            type="button"
            aria-pressed=${String(this.view === "groups")}
            @click=${() => this.setView("groups")}
          >
            Groups
          </button>
          <button
            type="button"
            aria-pressed=${String(this.view === "cards")}
            @click=${() => this.setView("cards")}
          >
            Cards
          </button>
          <button
            type="button"
            aria-pressed=${String(this.view === "table")}
            @click=${() => this.setView("table")}
          >
            Table
          </button>
        </div>
      </div>
    `;
  }

  private renderControls(entries: readonly DeadlineBoardEntry[]) {
    return html`
      <div class="deadline-board__controls">
        <label class="deadline-board__search">
          <span class="sr-only">Search deadlines</span>
          <input
            type="search"
            placeholder="Search conferences & workshops…"
            .value=${this.query}
            @input=${this.setQuery}
          />
        </label>
        <div class="deadline-board__groups" role="group" aria-label="Filter by venue">
          <button
            type="button"
            aria-pressed=${String(!this.activeGroup)}
            data-testid="deadline-group-all"
            @click=${() => this.selectGroup("")}
          >
            All <span>${entries.length}</span>
          </button>
          ${groupOptions(entries).map(
            (group) => html`
              <button
                type="button"
                aria-pressed=${String(this.activeGroup === group.id)}
                data-testid=${`deadline-group-${group.id}`}
                @click=${() => this.selectGroup(group.id)}
              >
                ${group.label} <span>${group.count}</span>
              </button>
            `,
          )}
        </div>
      </div>
    `;
  }

  private renderArchivalGuide() {
    return html`
      <details class="deadline-board__guide">
        <summary>What archival status means</summary>
        <p>
          Workshop status follows its own CFP or an official parent policy. A workshop can offer
          archival, non-archival, or separate archival and non-archival routes.
        </p>
        <dl>
          <div>
            <dt>Archival</dt>
            <dd>counts as publishing; the same paper cannot generally be submitted elsewhere.</dd>
          </div>
          <div>
            <dt>Non-archival</dt>
            <dd>does not count as publishing; you can still submit the paper elsewhere.</dd>
          </div>
          <div>
            <dt>Archival + non-archival</dt>
            <dd>choose the CFP's non-archival route if the paper may be submitted elsewhere.</dd>
          </div>
          <div>
            <dt>Unknown</dt>
            <dd>check the call for papers before assuming another submission is allowed.</dd>
          </div>
        </dl>
      </details>
    `;
  }

  private renderCard(entry: DeadlineBoardEntry) {
    const { venue, instant } = entry;
    return html`
      <article
        class="deadline-card"
        data-entry-type=${venue.entry_type}
        data-urgency=${urgency(entry, this.now)}
      >
        <div class="deadline-card__topline">
          <span class="deadline-card__type">${ENTRY_TYPE_LABELS[venue.entry_type]}</span>
          <span class="deadline-card__urgency">${urgencyLabel(entry, this.now)}</span>
        </div>
        <h2 class="deadline-card__name">${renderDeadlineTitle(venue)}</h2>
        <p
          class="deadline-card__group"
          title=${`${venue.venue_group} · ${capitalize(venue.deadline_label)}`}
        >
          <span class="deadline-card__group-name">${venue.venue_group}</span>
          <span aria-hidden="true">·</span>
          <span class="deadline-card__stage">${capitalize(venue.deadline_label)}</span>
        </p>
        <time class="deadline-card__date" datetime=${venue.deadline_aoe}>
          ${aoeDateTimeLabel(venue.deadline_aoe)}
        </time>
        <p class="deadline-card__countdown">${countdownLabel(instant - this.now)}</p>
        ${venue.notification_aoe
          ? html`<p class="deadline-card__note">
              Accept/reject: ${aoeDateLabel(venue.notification_aoe)} AoE
            </p>`
          : nothing}
        ${this.renderSourceActions(venue)}
      </article>
    `;
  }

  private renderSourceActions(venue: DeadlineVenue) {
    const workshop = workshopSourceLinks(venue);
    if (!workshop) {
      return venue.link
        ? html`<span class="deadline-card__actions"
            ><a
              class="deadline-card__source deadline-card__source--button"
              href=${venue.link}
              target="_blank"
              rel="noopener noreferrer"
              aria-label=${`Official site for ${venue.name}`}
              >Official site ↗</a
            ></span
          >`
        : nothing;
    }
    return html`<span class="deadline-card__actions">
      ${workshop.sourceUrl
        ? html`<a
            class="deadline-card__source deadline-card__source--button"
            href=${workshop.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label=${`${workshop.sourceLabel} for ${venue.name}`}
            >${workshop.sourceLabel} ↗</a
          >`
        : html`<span class="deadline-card__missing">Call for papers not found yet</span>`}
      ${workshop.openReviewUrl
        ? html`<a
            class="deadline-card__source deadline-card__source--button"
            href=${workshop.openReviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label=${`OpenReview for ${venue.name}`}
            >OpenReview ↗</a
          >`
        : nothing}
    </span>`;
  }

  private renderTable(entries: readonly DeadlineBoardEntry[]) {
    return html`
      <div class="deadline-table-wrap">
        <table class="deadline-table">
          <thead>
            <tr>
              <th>Deadline (AoE)</th>
              <th>Countdown</th>
              <th>Item</th>
              <th>Type</th>
              <th>Venue</th>
              <th><span class="sr-only">Source</span></th>
            </tr>
          </thead>
          <tbody>
            ${entries.map(
              (entry) => html`
                <tr
                  data-entry-type=${entry.venue.entry_type}
                  data-urgency=${urgency(entry, this.now)}
                >
                  <td class="deadline-table__date">
                    ${aoeDateTimeLabel(entry.venue.deadline_aoe)}
                  </td>
                  <td class="deadline-table__countdown">
                    ${countdownLabel(entry.instant - this.now)}
                  </td>
                  <td class="deadline-table__name">${renderDeadlineTitle(entry.venue)}</td>
                  <td>
                    <span class="deadline-card__type"
                      >${ENTRY_TYPE_LABELS[entry.venue.entry_type]}</span
                    >
                  </td>
                  <td class="deadline-table__venue">${entry.venue.venue_group}</td>
                  <td>${this.renderSourceActions(entry.venue)}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderGroupRow(entry: DeadlineBoardEntry, conference: string) {
    const { venue, instant } = entry;
    const title = groupRowTitle(venue, conference);
    const detail = venue.notification_aoe
      ? `Accept/reject ${aoeDateLabel(venue.notification_aoe)} AoE`
      : "";
    const note = [title.stage, detail].filter(Boolean).join(" · ");
    return html`
      <div
        class="deadline-group__row"
        data-entry-type=${venue.entry_type}
        data-urgency=${urgency(entry, this.now)}
      >
        <span class="deadline-group__row-countdown">${countdownLabel(instant - this.now)}</span>
        <time class="deadline-group__row-date" datetime=${venue.deadline_aoe}>
          ${aoeDateTimeLabel(venue.deadline_aoe)}
        </time>
        <div class="deadline-group__row-main">
          <h3 class="deadline-group__row-name">${renderDeadlineTitle(venue, title.name)}</h3>
          <p class="deadline-group__row-note">
            ${note ? html`<span class="deadline-group__row-detail">${note}</span>` : nothing}
            <span class="deadline-card__labels"
              ><span class="deadline-card__type">${ENTRY_TYPE_LABELS[venue.entry_type]}</span></span
            >
          </p>
        </div>
        ${this.renderSourceActions(venue)}
      </div>
    `;
  }

  private renderGroupSection(
    label: string,
    entries: readonly DeadlineBoardEntry[],
    conference: string,
  ) {
    if (!entries.length) {
      return nothing;
    }
    return html`
      <section class="deadline-group__section">
        <p class="deadline-group__section-head">
          <strong>${label}</strong><span>${entries.length}</span>
        </p>
        ${entries.map((entry) => this.renderGroupRow(entry, conference))}
      </section>
    `;
  }

  private renderGroups(entries: readonly DeadlineBoardEntry[]) {
    return html`<div class="deadline-board__group-list">
      ${groupDeadlineBoardEntries(entries).map((group, index) => {
        const open = this.expandedGroups.has(group.id);
        const panelId = `deadline-group-panel-${index}`;
        const counts = [
          group.sections.archival.length ? `${group.sections.archival.length} archival` : "",
          group.sections.nonArchival.length
            ? `${group.sections.nonArchival.length} non-archival`
            : "",
          group.sections.mixed.length
            ? `${group.sections.mixed.length} archival + non-archival`
            : "",
          group.sections.unknown.length ? `${group.sections.unknown.length} unknown` : "",
          group.sections.other.length ? `${group.sections.other.length} other` : "",
        ].filter(Boolean);
        return html`
          <section
            class="deadline-group"
            data-count=${group.entries.length}
            data-urgency=${urgency(group.entries[0], this.now)}
            ?data-open=${open}
          >
            <button
              type="button"
              class="deadline-group__summary"
              aria-expanded=${String(open)}
              aria-controls=${panelId}
              @click=${() => this.toggleGroup(group.id)}
            >
              <span class="deadline-group__chevron" aria-hidden="true">›</span>
              <span class="deadline-group__summary-countdown"
                >${countdownLabel(group.instant - this.now)}</span
              >
              <span class="deadline-group__heading">
                <strong>${group.label}</strong>
                <small>${aoeDateTimeLabel(group.entries[0].venue.deadline_aoe)}</small>
              </span>
              <span class="deadline-group__count">${counts.join(" · ")}</span>
            </button>
            <div class="deadline-group__panel" id=${panelId} ?hidden=${!open}>
              ${this.renderGroupSection("Archival", group.sections.archival, group.label)}
              ${this.renderGroupSection("Non-archival", group.sections.nonArchival, group.label)}
              ${this.renderGroupSection(
                "Archival + non-archival",
                group.sections.mixed,
                group.label,
              )}
              ${this.renderGroupSection(
                "Archival status unknown",
                group.sections.unknown,
                group.label,
              )}
              ${this.renderGroupSection("Other dates", group.sections.other, group.label)}
            </div>
          </section>
        `;
      })}
    </div>`;
  }

  protected override render() {
    // Output 0 is the Upcoming tracker. D adds an explicit Past view; until then, expired rows stay
    // out of this surface exactly as they do on the standalone page.
    const entries = buildDeadlineBoardEntries().filter((entry) => entry.instant > this.now);
    const matching = filterDeadlineBoardEntries(entries, "", this.query);
    if (
      this.activeGroup &&
      !matching.some((entry) => entry.venue.venue_group === this.activeGroup)
    ) {
      this.activeGroup = "";
    }
    const filtered = filterDeadlineBoardEntries(matching, this.activeGroup, "");
    const next = filtered[0];
    const latestSourceCheck = DEADLINE_VENUES.map((venue) => venue.source_checked_at || "")
      .filter(Boolean)
      .toSorted()
      .at(-1)
      ?.slice(0, 10);
    return html`
      <section class="deadline-board">
        <header class="deadline-board__header">
          <h1>${t("tabs.adminbotDeadlines")}</h1>
          <p>${t("subtitles.adminbotDeadlines")}</p>
        </header>
        ${this.renderModes()} ${this.renderControls(matching)} ${this.renderArchivalGuide()}
        <div class="deadline-board__overview">
          ${this.renderHero(next)} ${this.renderStats(filtered)}
        </div>
        ${filtered.length
          ? this.view === "cards"
            ? html`<div class="deadline-board__grid">
                ${filtered.map((entry) => this.renderCard(entry))}
              </div>`
            : this.view === "groups"
              ? this.renderGroups(filtered)
              : this.renderTable(filtered)
          : html`<p class="deadline-board__empty">No deadlines match your filter.</p>`}
        <p class="deadline-board__foot">
          ${entries.length} upcoming deadlines · official venue sites + OpenReview
          ${latestSourceCheck ? ` · source checks through ${latestSourceCheck}` : ""}
        </p>
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
