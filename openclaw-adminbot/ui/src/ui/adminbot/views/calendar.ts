// The Calendar tab: the lab calendar, an instruction box that writes to it, and an invite list
// built from what the roster already knows about people.
//
// The embed at the top is the same calendar every read and write below uses — the service says
// which one, so the picture and the actions cannot drift apart.
//
// The instruction box does double duty. With nothing selected it composes a new event; with an
// event selected for editing it applies the instruction to that event and shows what the change
// would leave behind. Either way the draft is editable before it goes anywhere.
//
// These buttons really do send: the tab is admin-only, so a write files its action, records the
// admin as approver and executes in one request. The two that other people can see — putting an
// event on the shared calendar, and mailing invitations — ask for a second click first, because
// there is no approval queue standing between a typo and forty inboxes.
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../external-link.ts";
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
  // set is not an opinion about the new one — and a confirmation given for the old set is not
  // consent to mail the new one.
  state.calendarExcludedMemberIds = [];
  state.calendarConfirming = null;
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

function renderEmbed(state: AppViewState) {
  const source = state.calendarSource ?? null;
  if (!source) {
    return nothing;
  }
  return html`
    <section class="card adminbot-card adminbot-calendar__panel" data-testid="calendar-embed">
      <div class="adminbot-calendar__panel-head">
        <div>
          <div class="card-title">${source.id}</div>
          <div class="card-sub">
            Everything below reads and writes this calendar (${source.timezone}).
          </div>
        </div>
        <a
          class="btn btn--sm"
          href=${source.embed_url}
          target=${EXTERNAL_LINK_TARGET}
          rel=${buildExternalLinkRel()}
          data-testid="calendar-embed-link"
          >Open in Google Calendar</a
        >
      </div>
      <iframe
        class="adminbot-calendar__embed"
        title="Lab calendar"
        src=${source.embed_url}
        loading="lazy"
      ></iframe>
      <!-- Google renders a sign-in wall inside the frame for anyone whose browser has no session
           with access to this calendar. Nothing the app can fix from here, so the link above is
           always offered rather than only when the frame fails — the frame cannot tell us. -->
      <p class="adminbot-calendar__note">
        Not showing? The embed needs a Google session with access to this calendar. The list below
        comes from the service and does not.
      </p>
    </section>
  `;
}

function renderDraftPanel(state: AppViewState) {
  const draft = state.calendarDraft ?? null;
  const busy = Boolean(state.calendarDraftBusy);
  const editing = state.calendarEditingEventId
    ? (state.calendarEvents ?? []).find((event) => event.id === state.calendarEditingEventId)
    : undefined;
  return html`
    <section class="card adminbot-card adminbot-calendar__panel" data-testid="calendar-draft-panel">
      <div class="card-title">${editing ? "Change an event" : "Add an event"}</div>
      <div class="card-sub">
        ${editing
          ? html`Say what to change about <strong>${editing.summary}</strong>. The change comes back
              here to check first.`
          : "Write it the way you would say it. The draft comes back here to check first."}
      </div>
      ${editing
        ? html`<div class="adminbot-calendar__editing" data-testid="calendar-editing">
            <span>Editing "${editing.summary}"</span>
            <button
              type="button"
              class="btn btn--sm"
              data-testid="calendar-editing-clear"
              @click=${() => {
                state.calendarEditingEventId = null;
                state.calendarDraft = null;
              }}
            >
              Compose a new event instead
            </button>
          </div>`
        : nothing}
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
            placeholder=${state.calendarEditingEventId
              ? "move it to Thursday at 3, and change the room to BA 5256"
              : "lunch with the reading group next Tuesday at 1, in the DCS lounge"}
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
                ${state.calendarConfirming === "save"
                  ? html`<span class="adminbot-calendar__confirm" role="status">
                      ${editing
                        ? "This updates the event for everyone already on it."
                        : "This puts the event on the shared calendar."}
                    </span>`
                  : nothing}
                <button
                  type="button"
                  class="btn"
                  @click=${() => {
                    state.calendarDraft = null;
                    state.calendarConfirming = null;
                  }}
                >
                  Discard
                </button>
                <button
                  type="button"
                  class="btn primary"
                  data-testid="calendar-save-event"
                  ?disabled=${Boolean(state.calendarBusy) || !draft.summary.trim()}
                  @click=${() => {
                    // Two clicks, because the first one is where a typo still costs nothing.
                    if (state.calendarConfirming !== "save") {
                      state.calendarConfirming = "save";
                      return;
                    }
                    state.calendarConfirming = null;
                    void state.saveCalendarEvent?.();
                  }}
                >
                  ${state.calendarConfirming === "save"
                    ? editing
                      ? "Confirm update"
                      : "Confirm — add it"
                    : editing
                      ? "Update this event"
                      : "Add to calendar"}
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
            <button
              type="button"
              class="btn btn--sm adminbot-calendar__event-edit"
              data-testid=${`calendar-edit-${event.id}`}
              @click=${() => {
                // Sends the instruction box up to this event. The draft and any half-typed
                // instruction go with it: they were about a different event.
                state.calendarEditingEventId = event.id;
                state.calendarDraft = null;
                state.calendarPrompt = "";
                state.calendarConfirming = null;
              }}
            >
              Change with a prompt
            </button>
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
        ${state.calendarConfirming === "invite" && selected
          ? html`<span
              class="adminbot-calendar__confirm"
              role="status"
              data-testid="calendar-invite-confirm"
            >
              ${chosen.length} ${chosen.length === 1 ? "person gets" : "people get"} a Google
              Calendar invitation to "${selected.summary}".
            </span>`
          : nothing}
        <button
          type="button"
          class="btn primary"
          data-testid="calendar-send-invite"
          ?disabled=${Boolean(state.calendarBusy) || !selected || chosen.length === 0}
          @click=${() => {
            // Two clicks, because nothing stands between this button and forty inboxes.
            if (state.calendarConfirming !== "invite") {
              state.calendarConfirming = "invite";
              return;
            }
            state.calendarConfirming = null;
            void state.sendCalendarInvites?.();
          }}
        >
          ${!selected
            ? "Pick an event to invite people to"
            : state.calendarConfirming === "invite"
              ? `Confirm — send ${chosen.length}`
              : `Send invites (${chosen.length})`}
        </button>
      </div>
    </section>
  `;
}

export function renderAdminBotCalendar(state: AppViewState) {
  return html`
    <div class="adminbot-calendar">
      ${renderEmbed(state)} ${renderDraftPanel(state)} ${renderInvitePanel(state)}
    </div>
  `;
}

/** The addresses and the reason behind the current selection, for the send the controller makes. */
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
