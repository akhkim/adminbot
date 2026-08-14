// The Calendar tab's side of the wire.
//
// Four things happen here:
//
//   1. Reading upcoming events from the lab calendar, which also tells the tab which calendar it
//      is looking at so the embed, the list and every write name the same one.
//   2. Asking the model to turn a sentence into a draft — either a new event, or the changes to an
//      event that already exists. Drafts come back to the screen; the operator edits them there.
//   3. Creating or editing an event.
//   4. Inviting people to one.
//
// Writes go straight through: the service files the typed action, records the signed-in admin as
// its approver and executes it in the same request. The tab is admin-only and the person clicking
// is the person who would have approved it anyway, so the second click bought nothing — but the
// ledger still gets the proposal, the approver and the execution, so "who put this on the calendar"
// stays answerable. That means the buttons on this tab really do send; the view asks for a
// confirmation before the two that other people can see.
import {
  createCalendarEvent,
  draftCalendarEvent,
  fetchCalendarEvents,
  inviteToCalendarEvent,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  updateCalendarEvent,
  type CalendarEvent,
  type CalendarEventDraft,
} from "../auth/session.ts";
import { ADMINBOT_TOOLS_UNAVAILABLE_MESSAGE, type AdminBotHost } from "./admin.ts";

const SIGN_IN_FIRST = "Sign in with an admin account to use the calendar.";

function failureText(result: { kind: string; message?: string }, fallback: string): string {
  if (result.kind === "unreachable") {
    return ADMINBOT_TOOLS_UNAVAILABLE_MESSAGE;
  }
  if (result.kind === "forbidden") {
    return "Your session no longer has admin access — sign in again and retry.";
  }
  if (result.kind === "rate-limited") {
    return "Too many attempts. Wait a moment and try again.";
  }
  // The service names what it refused ("could not read the calendar: gog: no token"), which is the
  // only sentence that tells the operator whether to fix a filter or fix the deployment.
  return result.message ?? fallback;
}

export async function loadAdminBotCalendar(host: AdminBotHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.calendarEventsError = SIGN_IN_FIRST;
    return;
  }
  host.calendarEventsLoading = true;
  host.calendarEventsError = null;
  try {
    const result = await fetchCalendarEvents(
      {},
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      host.calendarEventsError = failureText(result, "Could not read the calendar.");
      host.calendarEvents = [];
      return;
    }
    host.calendarEvents = result.value.events;
    if (result.value.calendar) {
      host.calendarSource = result.value.calendar;
    }
  } finally {
    host.calendarEventsLoading = false;
  }
}

/**
 * Drafts from the prompt box.
 *
 * With an event selected and edit mode on, the instruction is applied to that event and the model
 * is told what it currently says; otherwise it composes a new one. Same draft shape either way, so
 * the review form does not fork.
 */
export async function requestAdminBotCalendarDraft(host: AdminBotHost): Promise<void> {
  const prompt = (host.calendarPrompt ?? "").trim();
  if (!prompt) {
    host.calendarDraftError = "Describe the event first.";
    return;
  }
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.calendarDraftError = SIGN_IN_FIRST;
    return;
  }
  const editing = host.calendarEditingEventId
    ? (host.calendarEvents ?? []).find((event) => event.id === host.calendarEditingEventId)
    : undefined;
  host.calendarDraftBusy = true;
  host.calendarDraftError = null;
  try {
    const result = await draftCalendarEvent(
      {
        prompt,
        // The browser's zone, so "1pm" is the operator's 1pm rather than the server's.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(editing
          ? {
              editing: {
                summary: editing.summary,
                start: editing.start,
                ...(editing.end ? { end: editing.end } : {}),
                ...(editing.location ? { location: editing.location } : {}),
                ...(editing.description ? { description: editing.description } : {}),
              },
            }
          : {}),
      },
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      host.calendarDraftError = failureText(result, "Could not draft that event.");
      return;
    }
    host.calendarDraft = result.value;
  } finally {
    host.calendarDraftBusy = false;
  }
}

/** The draft as the operator currently has it on screen, with their edits applied. */
export function currentCalendarDraft(host: AdminBotHost): CalendarEventDraft | null {
  return host.calendarDraft ?? null;
}

/**
 * Puts the draft on the calendar — as a new event, or as changes to the one being edited.
 *
 * An edit sends the whole event rather than a patch, because the underlying update writes what it
 * is given: sending only the changed fields would clear the rest.
 */
export async function saveAdminBotCalendarEvent(host: AdminBotHost): Promise<void> {
  const draft = currentCalendarDraft(host);
  if (!draft) {
    return;
  }
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = { kind: "error", text: SIGN_IN_FIRST };
    return;
  }
  const editingId = host.calendarEditingEventId ?? null;
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  const payload = {
    summary: draft.summary,
    start: draft.start,
    end: draft.end,
    ...(draft.timezone ? { timezone: draft.timezone } : {}),
    ...(draft.location ? { location: draft.location } : {}),
    ...(draft.description ? { description: draft.description } : {}),
  };
  host.calendarBusy = true;
  try {
    const result = editingId
      ? await updateCalendarEvent(editingId, payload, stored.sessionToken, baseUrl)
      : await createCalendarEvent(
          { ...payload, ...(draft.attendees?.length ? { attendees: draft.attendees } : {}) },
          stored.sessionToken,
          baseUrl,
        );
    if (!result.ok) {
      host.adminBotNotice = {
        kind: "error",
        text: failureText(result, "Could not save that event."),
      };
      return;
    }
    host.adminBotNotice = {
      kind: "success",
      text: editingId ? "Event updated." : "Event added to the calendar.",
    };
    host.calendarDraft = null;
    host.calendarPrompt = "";
    host.calendarEditingEventId = null;
    // The embed and the list are both now stale, and the list is what the invite half points at.
    await loadAdminBotCalendar(host);
  } finally {
    host.calendarBusy = false;
  }
}

export async function inviteAdminBotCalendarAudience(
  host: AdminBotHost,
  params: { event: CalendarEvent; emails: string[]; reason: string },
): Promise<void> {
  if (!params.emails.length) {
    return;
  }
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = { kind: "error", text: SIGN_IN_FIRST };
    return;
  }
  host.calendarBusy = true;
  try {
    const result = await inviteToCalendarEvent(
      params.event.id,
      {
        attendees: params.emails,
        summary: params.event.summary,
        // The filter that produced this list, recorded on the action so the ledger says who was
        // mailed and why without reconstructing it from the address list.
        rationale: params.reason,
      },
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      host.adminBotNotice = {
        kind: "error",
        text: failureText(result, "Could not send those invites."),
      };
      return;
    }
    host.adminBotNotice = {
      kind: "success",
      text: `Invited ${params.emails.length} ${
        params.emails.length === 1 ? "person" : "people"
      } to "${params.event.summary}".`,
    };
    await loadAdminBotCalendar(host);
  } finally {
    host.calendarBusy = false;
  }
}
