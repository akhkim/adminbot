// The Calendar tab: draft an event from a sentence, and invite people the roster can already
// describe.
//
// Two panels because they are two jobs. The top one turns "lunch with the reading group next
// Tuesday at 1 in the DCS lounge" into fields you can check and correct. The bottom one starts from
// an event that already exists and answers the lab's real invite questions — everyone writing for
// this conference, everyone actually in this city right now, everyone based here — instead of
// making you remember who is where.
//
// Neither panel sends anything. Both end in a proposal that an admin approves on the Actions tab,
// which is why every submit button says "Propose". That is the service's rule for anything with an
// external effect, and a mail to forty people is about as external as it gets.
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import type { CalendarEvent } from "../auth/session.ts";
import {
  knownCities,
  knownConferences,
  selectAudience,
  type AudienceFilter,
} from "../calendar-audience.ts";

const PRIVILEGE_LEVELS = ["external_collaborator", "trial", "member", "admin"] as const;
const STATUSES = ["active", "part_time", "on_leave", "alumni", "external"] as const;

function filterOf(state: AppViewState): AudienceFilter {
  return state.calendarAudience ?? {};
}

function setFilter(state: AppViewState, patch: Partial<AudienceFilter>): void {
  state.calendarAudience = { ...filterOf(state), ...patch };
  // A changed filter means a different set of people, so a tick the operator made against the old
  // set is not an opinion about the new one.
  state.calendarExcludedMemberIds = [];
}

function eventDateLabel(event: CalendarEvent): string {
  if (event.all_day) {
    // A bare date is a date, not midnight: formatting it through a timestamp would show the day
    // before for anyone west of UTC.
    return event.start;
  }
  const parsed = new Date(event.start);
  return Number.isNaN(parsed.valueOf())
    ? event.start
    : parsed.toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function renderDraftPanel(state: AppViewState) {
  const draft = state.calendarDraft ?? null;
  const busy = Boolean(state.calendarDraftBusy);
  return html`
    <section class="card adminbot-card adminbot-calendar__panel" data-testid="calendar-draft-panel">
      <div class="card-title">Draft an event</div>
      <div class="card-sub">
        Write it the way you would say it. The draft comes back here to check before anything is
        filed.
      </div>
      <form
        class="adminbot-form"
        @submit=${(event: Event) => {
          event.preventDefault();
          void state.requestCalendarDraft?.();
        }}
      >
        <label class="adminbot-form__field adminbot-calendar__prompt">
          <span>What is the event</span>
          <textarea
            rows="3"
            data-testid="calendar-prompt"
            placeholder="lunch with the reading group next Tuesday at 1, in the DCS lounge"
            .value=${state.calendarPrompt ?? ""}
            @input=${(event: Event) => {
              state.calendarPrompt = (event.target as HTMLTextAreaElement).value;
            }}
          ></textarea>
        </label>
        <div class="adminbot-calendar__actions">
          <button
            type="submit"
            class="btn"
            data-testid="calendar-draft-submit"
            ?disabled=${busy || !(state.calendarPrompt ?? "").trim()}
          >
            ${busy ? "Drafting…" : "Draft it"}
          </button>
        </div>
      </form>
      ${state.calendarDraftError
        ? html`<div class="callout danger" role="alert">${state.calendarDraftError}</div>`
        : nothing}
      ${draft
        ? html`
            <div class="adminbot-calendar__draft" data-testid="calendar-draft">
              <div class="card-sub">Check this before filing it — every field is editable.</div>
              <div class="adminbot-form adminbot-calendar__draft-fields">
                <label class="adminbot-form__field">
                  <span>Title</span>
                  <input
                    data-testid="calendar-draft-summary"
                    .value=${draft.summary}
                    @input=${(event: Event) => {
                      state.calendarDraft = {
                        ...draft,
                        summary: (event.target as HTMLInputElement).value,
                      };
                    }}
                  />
                </label>
                <label class="adminbot-form__field">
                  <span>Starts</span>
                  <input
                    data-testid="calendar-draft-start"
                    .value=${draft.start}
                    @input=${(event: Event) => {
                      state.calendarDraft = {
                        ...draft,
                        start: (event.target as HTMLInputElement).value,
                      };
                    }}
                  />
                </label>
                <label class="adminbot-form__field">
                  <span>Ends</span>
                  <input
                    data-testid="calendar-draft-end"
                    .value=${draft.end}
                    @input=${(event: Event) => {
                      state.calendarDraft = {
                        ...draft,
                        end: (event.target as HTMLInputElement).value,
                      };
                    }}
                  />
                </label>
                <label class="adminbot-form__field">
                  <span>Where</span>
                  <input
                    .value=${draft.location ?? ""}
                    @input=${(event: Event) => {
                      state.calendarDraft = {
                        ...draft,
                        location: (event.target as HTMLInputElement).value,
                      };
                    }}
                  />
                </label>
                <label class="adminbot-form__field adminbot-calendar__wide">
                  <span>Details</span>
                  <textarea
                    rows="2"
                    .value=${draft.description ?? ""}
                    @input=${(event: Event) => {
                      state.calendarDraft = {
                        ...draft,
                        description: (event.target as HTMLTextAreaElement).value,
                      };
                    }}
                  ></textarea>
                </label>
              </div>
              ${draft.timezone
                ? html`<p class="adminbot-calendar__note">Times are read as ${draft.timezone}.</p>`
                : nothing}
              <div class="adminbot-calendar__actions">
                <button
                  type="button"
                  class="btn"
                  @click=${() => {
                    state.calendarDraft = null;
                  }}
                >
                  Discard
                </button>
                <button
                  type="button"
                  class="btn primary"
                  data-testid="calendar-propose-event"
                  ?disabled=${Boolean(state.calendarBusy) || !draft.summary.trim()}
                  @click=${() => void state.proposeCalendarEvent?.()}
                >
                  Propose this event
                </button>
              </div>
            </div>
          `
        : nothing}
    </section>
  `;
}

function renderEventList(state: AppViewState) {
  const events = state.calendarEvents ?? [];
  if (state.calendarEventsLoading) {
    return html`<p class="adminbot-calendar__note">Reading the calendar…</p>`;
  }
  if (state.calendarEventsError) {
    return html`<div class="callout danger" role="alert">${state.calendarEventsError}</div>`;
  }
  if (!events.length) {
    return html`<p class="adminbot-calendar__note" data-testid="calendar-events-empty">
      Nothing on the calendar in the next two months.
    </p>`;
  }
  return html`
    <ul class="adminbot-calendar__events" data-testid="calendar-events">
      ${events.map(
        (event) => html`
          <li>
            <label>
              <input
                type="radio"
                name="calendarEvent"
                value=${event.id}
                ?checked=${state.calendarSelectedEventId === event.id}
                @change=${() => {
                  state.calendarSelectedEventId = event.id;
                }}
              />
              <span class="adminbot-calendar__event-when">${eventDateLabel(event)}</span>
              <span class="adminbot-calendar__event-name">${event.summary}</span>
              ${event.location
                ? html`<span class="adminbot-calendar__event-where">${event.location}</span>`
                : nothing}
            </label>
          </li>
        `,
      )}
    </ul>
  `;
}

function renderFilterSelect(params: {
  label: string;
  testId: string;
  value: string | undefined;
  options: readonly string[];
  anyLabel: string;
  onChange: (value: string | undefined) => void;
}) {
  return html`
    <label class="adminbot-form__field">
      <span>${params.label}</span>
      <select
        data-testid=${params.testId}
        @change=${(event: Event) => {
          const value = (event.target as HTMLSelectElement).value;
          params.onChange(value || undefined);
        }}
      >
        <option value="" ?selected=${!params.value}>${params.anyLabel}</option>
        ${params.options.map(
          (option) => html`
            <option value=${option} ?selected=${params.value === option}>${option}</option>
          `,
        )}
      </select>
    </label>
  `;
}

function renderInvitePanel(state: AppViewState) {
  const members = state.adminBotData?.members ?? [];
  const papers = state.adminBotData?.papers ?? [];
  const filter = filterOf(state);
  const audience = selectAudience(members, papers, filter);
  const excluded = new Set(state.calendarExcludedMemberIds ?? []);
  const chosen = audience.matches.filter((match) => !excluded.has(match.member_id));
  const events = state.calendarEvents ?? [];
  const selected = events.find((event) => event.id === state.calendarSelectedEventId);
  const timezones = [
    ...new Set(members.flatMap((member) => (member.timezone ? [member.timezone] : []))),
  ].toSorted((left, right) => left.localeCompare(right));

  return html`
    <section
      class="card adminbot-card adminbot-calendar__panel"
      data-testid="calendar-invite-panel"
    >
      <div class="adminbot-calendar__panel-head">
        <div>
          <div class="card-title">Invite people to an event</div>
          <div class="card-sub">
            Pick an event, then describe who should be there. Everyone matching every filter is
            listed, with the reason they matched.
          </div>
        </div>
        <button
          type="button"
          class="btn btn--sm"
          data-testid="calendar-refresh"
          ?disabled=${Boolean(state.calendarEventsLoading)}
          @click=${() => void state.loadCalendarEvents?.()}
        >
          Refresh
        </button>
      </div>

      ${renderEventList(state)}

      <div class="adminbot-form adminbot-calendar__filters">
        ${renderFilterSelect({
          label: "Writing for",
          testId: "calendar-filter-conference",
          value: filter.conference,
          options: knownConferences(papers),
          anyLabel: "Any conference",
          onChange: (conference) => setFilter(state, { conference }),
        })}
        ${renderFilterSelect({
          label: "Currently in",
          testId: "calendar-filter-current-city",
          value: filter.currentCity,
          options: knownCities(members, "current_city"),
          anyLabel: "Anywhere",
          onChange: (currentCity) => setFilter(state, { currentCity }),
        })}
        ${renderFilterSelect({
          label: "Based in",
          testId: "calendar-filter-home-city",
          value: filter.homeCity,
          options: knownCities(members, "location"),
          anyLabel: "Anywhere",
          onChange: (homeCity) => setFilter(state, { homeCity }),
        })}
        ${renderFilterSelect({
          label: "Timezone",
          testId: "calendar-filter-timezone",
          value: filter.timezone,
          options: timezones,
          anyLabel: "Any timezone",
          onChange: (timezone) => setFilter(state, { timezone }),
        })}
        ${renderFilterSelect({
          label: "Membership",
          testId: "calendar-filter-privilege",
          value: filter.privilegeLevels?.[0],
          options: PRIVILEGE_LEVELS,
          anyLabel: "Any level",
          onChange: (level) => setFilter(state, { privilegeLevels: level ? [level] : undefined }),
        })}
        ${renderFilterSelect({
          label: "Status",
          testId: "calendar-filter-status",
          value: filter.statuses?.[0],
          options: STATUSES,
          anyLabel: "Any status",
          onChange: (status) => setFilter(state, { statuses: status ? [status] : undefined }),
        })}
      </div>

      ${audience.matches.length
        ? html`
            <ul class="adminbot-calendar__matches" data-testid="calendar-matches">
              ${audience.matches.map(
                (match) => html`
                  <li>
                    <label>
                      <input
                        type="checkbox"
                        ?checked=${!excluded.has(match.member_id)}
                        @change=${(event: Event) => {
                          const on = (event.target as HTMLInputElement).checked;
                          const next = new Set(state.calendarExcludedMemberIds ?? []);
                          if (on) {
                            next.delete(match.member_id);
                          } else {
                            next.add(match.member_id);
                          }
                          state.calendarExcludedMemberIds = [...next];
                        }}
                      />
                      <span class="adminbot-calendar__match-name">${match.name}</span>
                      <span class="adminbot-calendar__match-email">${match.email}</span>
                      <span class="adminbot-calendar__match-why">${match.reasons.join(" · ")}</span>
                    </label>
                  </li>
                `,
              )}
            </ul>
          `
        : html`<p class="adminbot-calendar__note" data-testid="calendar-no-matches">
            ${Object.keys(filter).length
              ? "Nobody on the roster matches all of those."
              : "Pick at least one filter to see who would be invited."}
          </p>`}
      ${audience.unreachable.length
        ? html`<p class="adminbot-calendar__note" data-testid="calendar-unreachable">
            No address on file for ${audience.unreachable.map((person) => person.name).join(", ")} —
            they cannot be invited until one is added.
          </p>`
        : nothing}

      <div class="adminbot-calendar__actions">
        <button
          type="button"
          class="btn primary"
          data-testid="calendar-propose-invite"
          ?disabled=${Boolean(state.calendarBusy) || !selected || chosen.length === 0}
          @click=${() => void state.proposeCalendarInvite?.()}
        >
          ${selected ? `Propose invites (${chosen.length})` : "Pick an event to invite people to"}
        </button>
      </div>
    </section>
  `;
}

export function renderAdminBotCalendar(state: AppViewState) {
  return html`
    <div class="adminbot-calendar">${renderDraftPanel(state)} ${renderInvitePanel(state)}</div>
  `;
}

/** The addresses and the reason behind the current selection, for the proposal the controller files. */
export function calendarInviteSelection(state: AppViewState): {
  event: CalendarEvent | undefined;
  emails: string[];
  reason: string;
} {
  const members = state.adminBotData?.members ?? [];
  const papers = state.adminBotData?.papers ?? [];
  const filter = filterOf(state);
  const excluded = new Set(state.calendarExcludedMemberIds ?? []);
  const matches = selectAudience(members, papers, filter).matches.filter(
    (match) => !excluded.has(match.member_id),
  );
  const parts = [
    filter.conference ? `writing for ${filter.conference}` : "",
    filter.currentCity ? `currently in ${filter.currentCity}` : "",
    filter.homeCity ? `based in ${filter.homeCity}` : "",
    filter.timezone ? `in ${filter.timezone}` : "",
    filter.privilegeLevels?.length ? filter.privilegeLevels.join("/") : "",
    filter.statuses?.length ? filter.statuses.join("/") : "",
  ].filter(Boolean);
  return {
    event: (state.calendarEvents ?? []).find((event) => event.id === state.calendarSelectedEventId),
    emails: matches.map((match) => match.email),
    reason: parts.length
      ? `Selected on the Calendar tab: ${parts.join(", ")}.`
      : "Selected on the Calendar tab.",
  };
}
