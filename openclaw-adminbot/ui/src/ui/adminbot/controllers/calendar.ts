// The Calendar tab's side of the wire.
//
// Three things happen here and none of them touches Google directly:
//
//   1. Reading upcoming events, so the invite half has real events to point at.
//   2. Asking the model to turn a sentence into a draft event. The draft comes back to the screen;
//      the operator can edit every field before anything else happens.
//   3. Filing a `calendar.*` proposal. That is where this tab stops — the service risk-tiers the
//      action, an admin approves it on the Actions tab, and only then does the gog connector run
//      it. The buttons say "Propose" for that reason, not out of shyness.
//
// Everything is on the member Bearer session. The shared service principal is refused by both
// calendar routes, and a plain member session is refused too: reading the lab's calendar and
// spending model time are admin acts.
import {
  createCalendarProposal,
  draftCalendarEvent,
  fetchCalendarEvents,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
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
    host.calendarEvents = result.value;
  } finally {
    host.calendarEventsLoading = false;
  }
}

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
  host.calendarDraftBusy = true;
  host.calendarDraftError = null;
  try {
    const result = await draftCalendarEvent(
      {
        prompt,
        // The browser's zone, so "1pm" is the operator's 1pm rather than the server's.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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

export async function proposeAdminBotCalendarEvent(host: AdminBotHost): Promise<void> {
  const draft = currentCalendarDraft(host);
  if (!draft) {
    return;
  }
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = { kind: "error", text: SIGN_IN_FIRST };
    return;
  }
  host.calendarBusy = true;
  try {
    const result = await createCalendarProposal(
      {
        // A hold rather than an invite: an event drafted from a sentence has no attendees the
        // operator has confirmed, and `send_invite` is what mails people. Inviting is the other
        // half of this tab, done deliberately against a chosen event.
        type: "calendar.create_tentative_hold",
        summary: `Create "${draft.summary}"`,
        payload: {
          summary: draft.summary,
          from: draft.start,
          to: draft.end,
          ...(draft.timezone ? { timezone: draft.timezone } : {}),
          ...(draft.location ? { location: draft.location } : {}),
          ...(draft.description ? { description: draft.description } : {}),
          ...(draft.attendees?.length ? { attendees: draft.attendees } : {}),
        },
        rationale: "Drafted from a written instruction on the Calendar tab and reviewed on screen.",
      },
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      host.adminBotNotice = {
        kind: "error",
        text: failureText(result, "Could not file that proposal."),
      };
      return;
    }
    host.adminBotNotice = {
      kind: "success",
      text: "Filed for approval. Approve it on the Actions tab to put it on the calendar.",
    };
    host.calendarDraft = null;
    host.calendarPrompt = "";
  } finally {
    host.calendarBusy = false;
  }
}

export async function proposeAdminBotCalendarInvite(
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
    const result = await createCalendarProposal(
      {
        type: "calendar.send_invite",
        summary: `Invite ${params.emails.length} to "${params.event.summary}"`,
        payload: {
          summary: params.event.summary,
          from: params.event.start,
          to: params.event.end ?? params.event.start,
          attendees: params.emails,
          ...(params.event.location ? { location: params.event.location } : {}),
          ...(params.event.calendar_id ? { calendar_id: params.event.calendar_id } : {}),
          ...(params.event.description ? { description: params.event.description } : {}),
        },
        // The filter that produced this list, recorded on the proposal so the approver sees who is
        // being mailed and why without reconstructing it from the address list.
        rationale: params.reason,
      },
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      host.adminBotNotice = {
        kind: "error",
        text: failureText(result, "Could not file that invite."),
      };
      return;
    }
    host.adminBotNotice = {
      kind: "success",
      text: `Filed for approval. ${params.emails.length} ${
        params.emails.length === 1 ? "person" : "people"
      } will be invited once it is approved.`,
    };
  } finally {
    host.calendarBusy = false;
  }
}
