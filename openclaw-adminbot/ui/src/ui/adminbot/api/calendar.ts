// AdminBot client: Lab calendar events and drafts.
//
// Mirrors the service's api/routes/calendar.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import { authedJson, type AuthResult, calendarFailure } from "../auth/session.ts";

// Reads an AdminBot resource over the member's own session. The dashboard uses this rather than
// the gateway tool path because `tools.invoke` requires operator.write, which a plain member's
// paired device deliberately does not hold -- so for them the tool path returns nothing at all.
// The Calendar tab's two reads. Both are admin-member only server-side; neither writes. Creating an
// event or inviting anyone is a `calendar.*` proposal through createCalendarProposal below, which
// still has to be approved and executed like every other external effect.
export type CalendarEvent = {
  id: string;
  summary: string;
  start: string;
  end?: string;
  location?: string;
  description?: string;
  calendar_id?: string;
  html_link?: string;
  attendees?: string[];
  all_day?: boolean;
};

export type CalendarEventDraft = {
  summary: string;
  start: string;
  end: string;
  timezone?: string;
  location?: string;
  description?: string;
  attendees?: string[];
};

export type LabCalendar = { id: string; timezone: string; embed_url: string };

export async function fetchCalendarEvents(
  params: { calendarId?: string; from?: string; to?: string; query?: string; max?: number },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<{ events: CalendarEvent[]; calendar: LabCalendar | null }>> {
  const search = new URLSearchParams();
  if (params.calendarId) search.set("calendar_id", params.calendarId);
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  if (params.query) search.set("query", params.query);
  if (params.max) search.set("max", String(params.max));
  const query = search.toString();
  const result = await authedJson(
    baseUrl,
    query ? `/calendar/events?${query}` : "/calendar/events",
    "GET",
    sessionToken,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    // 502 means the CLI is missing, unauthenticated, or its keyring is locked — the service says
    // which, and that sentence is far more use than "could not load".
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { events?: CalendarEvent[]; calendar?: LabCalendar } | null;
  return { ok: true, value: { events: body?.events ?? [], calendar: body?.calendar ?? null } };
}

export async function draftCalendarEvent(
  request: {
    prompt: string;
    timezone?: string;
    /** Present when the instruction is an edit to this event rather than a new one. */
    editing?: {
      summary: string;
      start: string;
      end?: string;
      location?: string;
      description?: string;
    };
  },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<CalendarEventDraft>> {
  const result = await authedJson(baseUrl, "/calendar/event-draft", "POST", sessionToken, {
    prompt: request.prompt,
    ...(request.timezone ? { timezone: request.timezone } : {}),
    ...(request.editing ? { editing: request.editing } : {}),
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    // A 400 here names what was wrong with the draft ("the draft ends before it starts"), which is
    // the sentence that tells the operator how to rewrite their instruction.
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { draft?: CalendarEventDraft } | null;
  if (!body?.draft) {
    return { ok: false, kind: "auth-failed" };
  }
  return { ok: true, value: body.draft };
}

/**
 * The Calendar tab's three writes. Each one goes straight through: the service files the typed
 * action, records the signed-in admin as its approver, and executes it in the same request.
 *
 * The tab is admin-only, so the person clicking is the person who would have approved it anyway.
 * The ledger still gets the proposal, the named approver and the execution — one click, same audit.
 */
export type CalendarActionResult = { action_id: string; status: string; executed_at?: string };

export async function createCalendarEvent(
  event: {
    summary: string;
    start: string;
    end: string;
    timezone?: string;
    location?: string;
    description?: string;
    attendees?: string[];
  },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<CalendarActionResult>> {
  return await calendarWrite("/calendar/events", event, sessionToken, baseUrl);
}

export async function updateCalendarEvent(
  eventId: string,
  event: {
    summary: string;
    start: string;
    end: string;
    timezone?: string;
    location?: string;
    description?: string;
  },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<CalendarActionResult>> {
  return await calendarWrite(
    `/calendar/events/${encodeURIComponent(eventId)}`,
    event,
    sessionToken,
    baseUrl,
  );
}

export async function inviteToCalendarEvent(
  eventId: string,
  request: {
    attendees: string[];
    /**
     * Addresses to take off the event, for an exclusive send.
     *
     * Paired with `remaining_attendees` and never sent alone: the calendar write behind a removal
     * replaces the guest list rather than subtracting from it, so the route refuses a removal that
     * does not say what should be left.
     */
    remove?: string[];
    remaining_attendees?: string[];
    summary?: string;
    rationale?: string;
  },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<CalendarActionResult>> {
  return await calendarWrite(
    `/calendar/events/${encodeURIComponent(eventId)}/invite`,
    request,
    sessionToken,
    baseUrl,
  );
}

async function calendarWrite(
  path: string,
  body: Record<string, unknown>,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<CalendarActionResult>> {
  const result = await authedJson(baseUrl, path, "POST", sessionToken, body);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: (result.body ?? {}) as CalendarActionResult };
}
