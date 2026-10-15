// The Events tab: upcoming lab-relevant events, who from the lab is going, and who is nearby.
//
// A renderer over props, like Travel: surfaces/events.ts wires the controller in and the tests draw
// it with plain objects. Places arrive already coarsened by the service (a city or metro label,
// never coordinates); the only inferred place here is the viewer's own, shown back to them.
import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../external-link.ts";
import { sayHiBusyKey, type EventsNotice } from "../controllers/events.ts";
import type {
  EventCard,
  EventPerson,
  EventsOverview,
  MeetupPreferences,
  SayHiTarget,
} from "../data/events.ts";
import { formatRange } from "./time-availability.trips.ts";

export type EventsProps = {
  overview: EventsOverview | null;
  loading: boolean;
  error: string | null;
  notice: EventsNotice | null;
  /** What is in flight; see EventsHost.eventsBusy. */
  busy: string | null;
  onRetry: () => void;
  onToggleGoing: (card: EventCard, going: boolean) => void;
  onPreferences: (
    patch: Partial<{ events: boolean; city: boolean; snoozed_until: string | null }>,
  ) => void;
  onSayHi: (target: SayHiTarget) => void;
};

type Nearby = Extract<NonNullable<EventsOverview["also_nearby"]>, { locked: false }>;

const AVATARS_SHOWN = 6;
const SNOOZE_DAYS = 14;

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts.at(-1)] : parts.slice(0, 1);
  return letters.map((part) => (part ?? "").charAt(0).toUpperCase()).join("") || "?";
}

function renderAvatar(person: EventPerson) {
  return person.avatar_url
    ? html`<img
        class="events__avatar"
        src=${person.avatar_url}
        alt=""
        title=${person.name}
        loading="lazy"
        referrerpolicy="no-referrer"
      />`
    : html`<span
        class="events__avatar events__avatar--initials"
        title=${person.name}
        aria-hidden="true"
        >${initials(person.name)}</span
      >`;
}

export function renderPeople(people: EventPerson[], empty: string) {
  if (people.length === 0) {
    return html`<span class="muted">${empty}</span>`;
  }
  const shown = people.slice(0, AVATARS_SHOWN);
  const more = people.length - shown.length;
  const names = people.map((person) => person.name).join(", ");
  return html`<span class="events__people">
    <span class="events__avatars" aria-hidden="true">
      ${shown.map(renderAvatar)}
      ${more > 0
        ? html`<span class="events__avatar events__avatar--more">+${more}</span>`
        : nothing}
    </span>
    <span class="events__names">${names}</span>
  </span>`;
}

/**
 * Say hi, or "Hi sent" once it has been. The button is the whole interaction: AdminBot opens the
 * Slack group DM straight away, so there is nothing to confirm and nothing to set up.
 */
function renderSayHi(
  target: SayHiTarget,
  state: { can: boolean; said: boolean },
  busy: string | null,
  onSayHi: (target: SayHiTarget) => void,
  label: string,
) {
  if (state.said) {
    return html`<span class="pill events__said-hi">${t("events.card.saidHi")}</span>`;
  }
  if (!state.can) {
    return nothing;
  }
  return html`<button
    type="button"
    class="btn btn--sm events__say-hi"
    aria-label=${label}
    ?disabled=${busy === sayHiBusyKey(target)}
    @click=${() => onSayHi(target)}
  >
    ${t("events.card.sayHi")}
  </button>`;
}

/** Faces under "Also nearby" and Nearby now, each with its own Say hi. */
function renderNearbyFaces(
  nearby: Nearby,
  busy: string | null,
  onSayHi: (target: SayHiTarget) => void,
) {
  return html`<ul class="events__faces">
    ${nearby.people.map(
      (person) => html`<li class="events__face" data-member=${person.member_id}>
        ${renderAvatar(person)}
        <span class="events__face-name">${person.name}</span>
        ${renderSayHi(
          { member_id: person.member_id },
          { can: nearby.can_say_hi, said: Boolean(person.said_hi) },
          busy,
          onSayHi,
          t("events.card.sayHiTo", { name: person.name }),
        )}
      </li>`,
    )}
  </ul>`;
}

/** "Happening now", "Starts today", "Tomorrow", "In 12 days", or nothing for a past event. */
export function countdownLabel(card: EventCard): string | null {
  if (card.status === "happening") {
    return t("events.card.happening");
  }
  if (card.status !== "upcoming" || card.days_until === undefined) {
    return null;
  }
  if (card.days_until <= 0) {
    return t("events.card.today");
  }
  if (card.days_until === 1) {
    return t("events.card.tomorrow");
  }
  return t("events.card.inDays", { count: String(card.days_until) });
}

function renderGoingToggle(props: EventsProps, card: EventCard) {
  if (!card.can_rsvp) {
    return nothing;
  }
  // Going because a paper roster says so, with no Travel answer to withdraw: the roster is changed
  // on the paper, not here.
  if (card.i_am_going && !card.my_rsvp) {
    return html`<span class="pill events__status--going">${t("events.card.onRoster")}</span>`;
  }
  const busy = props.busy === `rsvp:${card.key}`;
  return html`<div class="events__toggle" role="group" aria-label=${t("events.card.question")}>
    <button
      type="button"
      class="btn btn--sm ${card.i_am_going ? "primary" : ""}"
      aria-pressed=${card.i_am_going ? "true" : "false"}
      ?disabled=${busy || card.i_am_going}
      @click=${() => props.onToggleGoing(card, true)}
    >
      ${t("events.card.going")}
    </button>
    <button
      type="button"
      class="btn btn--sm ${card.i_am_going ? "" : "events__toggle-off--active"}"
      aria-pressed=${card.i_am_going ? "false" : "true"}
      ?disabled=${busy || !card.i_am_going}
      @click=${() => props.onToggleGoing(card, false)}
    >
      ${t("events.card.notGoing")}
    </button>
  </div>`;
}

function renderCard(props: EventsProps, card: EventCard): TemplateResult {
  const countdown = countdownLabel(card);
  const dates =
    card.starts && card.ends
      ? formatRange({ start: card.starts, end: card.ends })
      : card.starts
        ? formatRange({ start: card.starts, end: card.starts })
        : t("events.card.datesTba");
  return html`<li
    class="events__card ${card.near_you ? "events__card--near" : ""}"
    data-event=${card.key}
  >
    <div class="events__card-head">
      <span class="events__card-title">${card.label}</span>
      <span class="events__badges">
        ${card.near_you
          ? html`<span class="pill events__badge--near">${t("events.card.nearYou")}</span>`
          : nothing}
        ${card.on_paper ? html`<span class="pill">${t("events.card.onPaper")}</span>` : nothing}
      </span>
    </div>
    <div class="events__meta">
      <span
        >${dates}${countdown
          ? html` · <strong class="events__countdown">${countdown}</strong>`
          : nothing}</span
      >
      <span>
        ${card.location ?? t("events.card.locationTba")}
        ${card.map_url
          ? html` ·
              <a href=${card.map_url} target=${EXTERNAL_LINK_TARGET} rel=${buildExternalLinkRel()}
                >${t("events.card.map")}</a
              >`
          : nothing}
        ${card.homepage_url
          ? html` ·
              <a
                href=${card.homepage_url}
                target=${EXTERNAL_LINK_TARGET}
                rel=${buildExternalLinkRel()}
                >${t("events.card.website")}</a
              >`
          : nothing}
      </span>
    </div>
    <div class="events__going">
      <span class="events__going-label">${t("events.card.whoGoing")}</span>
      ${renderPeople(card.going, t("events.card.nobody"))}
      ${renderSayHi(
        { event_key: card.group_key },
        { can: Boolean(card.can_say_hi), said: Boolean(card.said_hi) },
        props.busy,
        props.onSayHi,
        t("events.card.sayHiAt", { event: card.label }),
      )}
    </div>
    ${renderGoingToggle(props, card)}
  </li>`;
}

function viewerSourceNote(source: "sign_in" | "profile" | "slack"): string {
  return source === "sign_in"
    ? t("events.location.signIn")
    : source === "profile"
      ? t("events.location.profile")
      : t("events.location.slack");
}

function renderHeader(props: EventsProps, overview: EventsOverview) {
  const where = overview.viewer_location;
  const nearby = overview.also_nearby;
  return html`<section class="card adminbot-card adminbot-card--wide events__intro">
    <div class="card-title">${t("events.title")}</div>
    <p class="card-sub">${t("events.hint")}</p>
    <p class="events__where" data-testid="events-where">
      ${where
        ? html`${t("events.location.youAre", { place: where.label })}
            <span class="muted">(${viewerSourceNote(where.source)})</span>`
        : html`<span class="muted">${t("events.location.unknown")}</span>`}
    </p>
    ${!nearby
      ? nothing
      : nearby.locked
        ? html`<p class="muted events__nearby">${t("events.nearby.locked")}</p>`
        : html`<div class="events__nearby" data-testid="events-nearby">
            <span>${t("events.nearby.label", { place: nearby.place_label })}</span>
            ${nearby.people.length === 0
              ? html`<span class="muted">${t("events.nearby.nobody")}</span>`
              : renderNearbyFaces(nearby, props.busy, props.onSayHi)}
          </div>`}
  </section>`;
}

function renderPrompts(props: EventsProps, cards: EventCard[]) {
  const prompted = cards.filter((card) => card.in_town_prompt);
  return prompted.map(
    (card) => html`<div class="callout events__prompt" role="status" data-testid="events-prompt">
      <span>${card.in_town_prompt}</span>
      ${card.can_rsvp
        ? html`<button
            type="button"
            class="btn btn--sm primary"
            ?disabled=${props.busy === `rsvp:${card.key}`}
            @click=${() => props.onToggleGoing(card, true)}
          >
            ${t("events.prompt.yes")}
          </button>`
        : nothing}
    </div>`,
  );
}

function renderSettings(props: EventsProps, today: string, prefs: MeetupPreferences) {
  const busy = props.busy === "prefs";
  const snoozed = prefs.snoozed_until && prefs.snoozed_until >= today ? prefs.snoozed_until : null;
  return html`<section class="card adminbot-card adminbot-card--wide events__settings">
    <div class="card-title">${t("events.settings.title")}</div>
    <p class="card-sub">${t("events.settings.hint")}</p>
    <label class="events__check">
      <input
        type="checkbox"
        .checked=${prefs.events}
        ?disabled=${busy}
        @change=${(event: Event) =>
          props.onPreferences({ events: (event.target as HTMLInputElement).checked })}
      />
      <span
        >${t("events.settings.events")}<small class="muted"
          >${t("events.settings.eventsHint")}</small
        ></span
      >
    </label>
    <label class="events__check">
      <input
        type="checkbox"
        .checked=${prefs.city}
        ?disabled=${busy}
        @change=${(event: Event) =>
          props.onPreferences({ city: (event.target as HTMLInputElement).checked })}
      />
      <span
        >${t("events.settings.city")}<small class="muted"
          >${t("events.settings.cityHint")}</small
        ></span
      >
    </label>
    <div class="events__snooze">
      ${snoozed
        ? html`<span>${t("events.settings.snoozedUntil", { day: snoozed })}</span>
            <button
              type="button"
              class="btn btn--sm"
              ?disabled=${busy}
              @click=${() => props.onPreferences({ snoozed_until: null })}
            >
              ${t("events.settings.resume")}
            </button>`
        : html`<button
            type="button"
            class="btn btn--sm"
            ?disabled=${busy}
            @click=${() => props.onPreferences({ snoozed_until: addDays(today, SNOOZE_DAYS) })}
          >
            ${t("events.settings.snooze")}
          </button>`}
    </div>
  </section>`;
}

export function renderEvents(props: EventsProps) {
  const overview = props.overview;
  return html`
    <div class="events" data-testid="events">
      ${props.notice
        ? html`<div
            class="callout ${props.notice.kind === "error" ? "danger" : "success"}"
            role=${props.notice.kind === "error" ? "alert" : "status"}
          >
            ${props.notice.text}
          </div>`
        : nothing}
      ${props.error
        ? html`<div class="callout danger" role="alert">
            ${props.error}
            <button type="button" class="btn btn--sm" @click=${props.onRetry}>
              ${t("events.retry")}
            </button>
          </div>`
        : nothing}
      ${!overview
        ? props.loading
          ? html`<div class="muted">${t("events.loading")}</div>`
          : nothing
        : html`
            ${renderHeader(props, overview)} ${renderPrompts(props, overview.events)}
            <section class="card adminbot-card adminbot-card--wide">
              <div class="card-title">${t("events.upcoming.title")}</div>
              ${overview.events.length === 0
                ? html`<p class="muted events__empty" data-testid="events-empty">
                    ${t("events.upcoming.empty")}
                  </p>`
                : html`<ul class="events__list">
                    ${overview.events.map((card) => renderCard(props, card))}
                  </ul>`}
              ${overview.past.length > 0
                ? html`<details class="events__past">
                    <summary>
                      ${t("events.past.title", { count: String(overview.past.length) })}
                    </summary>
                    <ul class="events__list">
                      ${overview.past.map((card) => renderCard(props, card))}
                    </ul>
                  </details>`
                : nothing}
            </section>
            ${renderSettings(props, overview.today, overview.preferences)}
          `}
    </div>
  `;
}

export type NearbyNowProps = {
  nearby: NonNullable<EventsOverview["also_nearby"]> | undefined;
  busy: string | null;
  notice: EventsNotice | null;
  onSayHi: (target: SayHiTarget) => void;
};

/**
 * Collaborate's Nearby now strip: the same faces as the Events header, where people already go to
 * find collaborators. Draws nothing unless somebody is actually around.
 */
export function renderNearbyNow(props: NearbyNowProps) {
  const nearby = props.nearby;
  if (!nearby || nearby.locked || nearby.people.length === 0) {
    return nothing;
  }
  return html`<section
    class="card adminbot-card adminbot-card--wide events__nearby-now"
    data-testid="nearby-now"
  >
    <div class="card-title">${t("events.nearbyNow.title")}</div>
    <p class="card-sub">${t("events.nearbyNow.sub", { place: nearby.place_label })}</p>
    ${props.notice
      ? html`<div
          class="callout ${props.notice.kind === "error" ? "danger" : "success"}"
          role=${props.notice.kind === "error" ? "alert" : "status"}
        >
          ${props.notice.text}
        </div>`
      : nothing}
    ${renderNearbyFaces(nearby, props.busy, props.onSayHi)}
  </section>`;
}

export type MeetupToggleProps = {
  preferences: MeetupPreferences;
  busy: boolean;
  onToggle: (on: boolean) => void;
  onManage: () => void;
};

/** The profile's one-tap switch: both kinds of intro on or off. Events has the finer controls. */
export function renderMeetupToggle(props: MeetupToggleProps) {
  const on = props.preferences.events && props.preferences.city;
  return html`<section
    class="card adminbot-card adminbot-card--wide events__profile-toggle"
    data-testid="meetup-toggle"
  >
    <label class="events__switch">
      <input
        type="checkbox"
        role="switch"
        .checked=${on}
        ?disabled=${props.busy}
        @change=${(event: Event) => props.onToggle((event.target as HTMLInputElement).checked)}
      />
      <span>
        <strong>${t("events.profile.toggle")}</strong>
        <small class="muted">${t("events.profile.hint")}</small>
      </span>
    </label>
    <button type="button" class="btn btn--sm events__manage" @click=${props.onManage}>
      ${t("events.profile.manage")}
    </button>
  </section>`;
}
