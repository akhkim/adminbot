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
import { i18n } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../external-link.ts";
import type { CalendarEvent } from "../auth/session.ts";
import {
  knownCities,
  knownConferences,
  selectAudience,
  type AudienceFilter,
} from "../calendar-audience.ts";
import {
  dayKeyInZone,
  eventTimeLabel,
  eventsByDay,
  monthGrid,
  monthLabel,
  monthStartKey,
  shiftMonth,
} from "../calendar-month.ts";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
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

function renderMonth(state: AppViewState) {
  const source = state.calendarSource ?? null;
  const timezone = source?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayKey = dayKeyInZone(Date.now(), timezone);
  const monthKey = state.calendarMonth ?? monthStartKey(todayKey);
  const weeks = monthGrid(monthKey, todayKey);
  const byDay = eventsByDay(state.calendarEvents ?? [], timezone);
  const step = (months: number) => () => {
    state.calendarMonth = shiftMonth(monthKey, months);
    // The first load covered a window, not a month, so moving off it has to fetch what it shows.
    void state.loadCalendarEvents?.();
  };

  return html`
    <section class="card adminbot-card adminbot-calendar__panel" data-testid="calendar-month">
      <div class="adminbot-calendar__panel-head">
        <div>
          <div class="card-title">${monthLabel(monthKey, i18n.getLocale())}</div>
          <div class="card-sub">
            ${source
              ? `${source.id} · ${source.timezone}`
              : "The lab calendar, as the service reads it."}
          </div>
        </div>
        <div class="adminbot-calendar__month-nav">
          <button
            type="button"
            class="btn btn--sm"
            data-testid="calendar-month-prev"
            aria-label="Previous month"
            @click=${step(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            class="btn btn--sm"
            data-testid="calendar-month-today"
            @click=${() => {
              state.calendarMonth = monthStartKey(todayKey);
              void state.loadCalendarEvents?.();
            }}
          >
            Today
          </button>
          <button
            type="button"
            class="btn btn--sm"
            data-testid="calendar-month-next"
            aria-label="Next month"
            @click=${step(1)}
          >
            ›
          </button>
          ${source
            ? html`<a
                class="btn btn--sm"
                href=${source.embed_url}
                target=${EXTERNAL_LINK_TARGET}
                rel=${buildExternalLinkRel()}
                data-testid="calendar-embed-link"
                >Open in Google</a
              >`
            : nothing}
        </div>
      </div>
      ${state.calendarEventsError
        ? html`<div class="callout danger" role="alert">${state.calendarEventsError}</div>`
        : nothing}
      <div class="adminbot-calendar__grid" data-testid="calendar-grid">
        ${WEEKDAYS.map((day) => html`<div class="adminbot-calendar__weekday">${day}</div>`)}
        ${weeks.flat().map((day) => {
          const events = byDay.get(day.key) ?? [];
          return html`
            <div
              class=${`adminbot-calendar__day${day.inMonth ? "" : " adminbot-calendar__day--muted"}${
                day.isToday ? " adminbot-calendar__day--today" : ""
              }`}
              data-testid=${`calendar-day-${day.key}`}
            >
              <span class="adminbot-calendar__day-number">${day.day}</span>
              ${events.map(
                (event) => html`
                  <button
                    type="button"
                    class=${`adminbot-calendar__chip${
                      state.calendarSelectedEventId === event.id
                        ? " adminbot-calendar__chip--selected"
                        : ""
                    }`}
                    title=${event.summary}
                    data-testid=${`calendar-chip-${event.id}`}
                    @click=${() => {
                      // One click picks the event for the invite panel and aims the instruction box
                      // at it, since both of the things you can do to an existing event need it
                      // selected.
                      state.calendarSelectedEventId = event.id;
                      state.calendarEditingEventId = event.id;
                      state.calendarDraft = null;
                      state.calendarConfirming = null;
                    }}
                  >
                    <span class="adminbot-calendar__chip-time"
                      >${eventTimeLabel(event, timezone, i18n.getLocale())}</span
                    >
                    <span class="adminbot-calendar__chip-name">${event.summary}</span>
                  </button>
                `,
              )}
            </div>
          `;
        })}
      </div>
      ${state.calendarEventsLoading
        ? html`<p class="adminbot-calendar__note">Reading the calendar…</p>`
        : nothing}
    </section>
  `;
}

/**
 * The assistant half: a conversation, and the draft it has produced so far.
 *
 * Laid out like the reimbursement assistant because it is the same act — you describe something in
 * words, a local model answers, and a structured result builds up beside the conversation. Reusing
 * the shape means nobody has to learn a second way of talking to AdminBot.
 */
function renderDraftPanel(state: AppViewState) {
  const draft = state.calendarDraft ?? null;
  const busy = Boolean(state.calendarDraftBusy);
  const editing = state.calendarEditingEventId
    ? (state.calendarEvents ?? []).find((event) => event.id === state.calendarEditingEventId)
    : undefined;
  const messages = state.calendarMessages ?? [];

  return html`
    <div class="adminbot-calendar__workspace">
      <section
        class="card adminbot-card adminbot-calendar__chat"
        aria-label="Calendar assistant"
        data-testid="calendar-draft-panel"
      >
        <div class="adminbot-calendar__chat-heading">
          <div>
            <div class="card-title">Calendar assistant</div>
            <div class="card-sub">
              Say what you want in words. Runs on the local AdminBot model, and nothing reaches the
              calendar until you press the button.
            </div>
          </div>
          <button
            type="button"
            class="btn btn--sm"
            data-testid="calendar-chat-reset"
            ?disabled=${busy}
            @click=${() => {
              state.calendarMessages = [];
              state.calendarDraft = null;
              state.calendarPrompt = "";
              state.calendarEditingEventId = null;
              state.calendarConfirming = null;
            }}
          >
            Start over
          </button>
        </div>
        ${editing
          ? html`<div class="adminbot-calendar__editing" data-testid="calendar-editing">
              <span>Changing "${editing.summary}"</span>
              <button
                type="button"
                class="btn btn--sm"
                data-testid="calendar-editing-clear"
                @click=${() => {
                  state.calendarEditingEventId = null;
                  state.calendarDraft = null;
                }}
              >
                Add a new event instead
              </button>
            </div>`
          : nothing}
        <div class="adminbot-calendar__messages" role="log" aria-live="polite">
          ${messages.length === 0
            ? html`<div
                class="adminbot-calendar__message adminbot-calendar__message--assistant"
                data-testid="calendar-chat-greeting"
              >
                <span>AdminBot</span>
                <p>
                  ${editing
                    ? `Tell me what to change about "${editing.summary}" — for example, "move it to Thursday at 3 and put it in BA 5256".`
                    : 'Describe an event and I will draft it. For example, "lunch with the reading group next Tuesday at 1, in the DCS lounge".'}
                </p>
              </div>`
            : messages.map(
                (message) => html`
                  <div
                    class="adminbot-calendar__message adminbot-calendar__message--${message.role}"
                  >
                    <span>${message.role === "assistant" ? "AdminBot" : "You"}</span>
                    <p>${message.content}</p>
                  </div>
                `,
              )}
          ${busy
            ? html`<div
                class="adminbot-calendar__message adminbot-calendar__message--assistant"
                data-testid="calendar-chat-thinking"
              >
                <span>AdminBot</span>
                <p>Working on it…</p>
              </div>`
            : nothing}
        </div>
        ${state.calendarDraftError
          ? html`<div class="callout danger" role="alert">${state.calendarDraftError}</div>`
          : nothing}
        <form
          class="adminbot-calendar__composer"
          @submit=${(event: Event) => {
            event.preventDefault();
            void state.requestCalendarDraft?.();
          }}
        >
          <label class="adminbot-form__field">
            <span>${editing ? "What should change" : "What is the event"}</span>
            <textarea
              name="prompt"
              rows="3"
              data-testid="calendar-prompt"
              placeholder=${editing
                ? "move it to Thursday at 3, and change the room to BA 5256"
                : "lunch with the reading group next Tuesday at 1, in the DCS lounge"}
              ?disabled=${busy}
              .value=${state.calendarPrompt ?? ""}
              @input=${(event: Event) => {
                state.calendarPrompt = (event.target as HTMLTextAreaElement).value;
              }}
            ></textarea>
          </label>
          <button
            type="submit"
            class="btn btn--sm primary"
            data-testid="calendar-draft-submit"
            ?disabled=${busy || !(state.calendarPrompt ?? "").trim()}
          >
            ${busy ? "Drafting…" : "Send to assistant"}
          </button>
        </form>
      </section>
      ${renderDraftCard(state, draft, editing)}
    </div>
  `;
}

/** The structured result, beside the conversation — the reimbursement draft card's counterpart. */
function renderDraftCard(
  state: AppViewState,
  draft: AppViewState["calendarDraft"],
  editing: CalendarEvent | undefined,
) {
  if (!draft) {
    return html`
      <section class="card adminbot-card adminbot-calendar__draft-card">
        <div class="card-title">Draft</div>
        <p class="adminbot-calendar__note" data-testid="calendar-draft-empty">
          Nothing drafted yet. What the assistant proposes shows up here, editable, before it
          reaches the calendar.
        </p>
      </section>
    `;
  }
  const field = (
    label: string,
    value: string,
    key: "summary" | "start" | "end" | "location",
    testId?: string,
  ) => html`
    <label class="adminbot-form__field">
      <span>${label}</span>
      <input
        data-testid=${testId ?? ""}
        .value=${value}
        @input=${(event: Event) => {
          state.calendarDraft = { ...draft, [key]: (event.target as HTMLInputElement).value };
        }}
      />
    </label>
  `;
  return html`
    <section class="card adminbot-card adminbot-calendar__draft-card" data-testid="calendar-draft">
      <div class="card-title">${editing ? "After the change" : "Draft"}</div>
      <div class="card-sub">Every field is editable before it reaches the calendar.</div>
      <div class="adminbot-form adminbot-calendar__draft-fields">
        ${field("Title", draft.summary, "summary", "calendar-draft-summary")}
        ${field("Starts", draft.start, "start", "calendar-draft-start")}
        ${field("Ends", draft.end, "end", "calendar-draft-end")}
        ${field("Where", draft.location ?? "", "location")}
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
    </section>
  `;
}

/**
 * Which event the invites would go to.
 *
 * Not a second picker: the month above is the picker, and two lists of the same events with
 * different selections is how an operator invites people to the wrong one. This states what the
 * calendar currently has selected and sends them back up if it is nothing.
 */
function renderSelectedEvent(state: AppViewState) {
  const selected = (state.calendarEvents ?? []).find(
    (event) => event.id === state.calendarSelectedEventId,
  );
  if (!selected) {
    return html`<p class="adminbot-calendar__note" data-testid="calendar-no-event">
      Pick an event on the calendar above to invite people to it.
    </p>`;
  }
  return html`
    <div class="adminbot-calendar__selected" data-testid="calendar-selected-event">
      <span class="adminbot-calendar__event-when">${eventDateLabel(selected)}</span>
      <span class="adminbot-calendar__event-name">${selected.summary}</span>
      ${selected.location
        ? html`<span class="adminbot-calendar__event-where">${selected.location}</span>`
        : nothing}
      ${selected.attendees?.length
        ? html`<span class="adminbot-calendar__event-where"
            >${selected.attendees.length} already invited</span
          >`
        : nothing}
    </div>
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

      ${renderSelectedEvent(state)}

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
      ${renderMonth(state)} ${renderDraftPanel(state)} ${renderInvitePanel(state)}
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
