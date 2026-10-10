/** Google Calendar membership reads and writes; writes are called only by the approved executor. */
export type CalendarMemberEvent = {
  id: string;
  status?: string;
  organizer: { email: string };
  attendees: Array<Record<string, unknown> & { email: string }>;
};
export type CalendarMembershipReader = (calendarId: string) => Promise<CalendarMemberEvent[]>;
type Capture = (args: string[]) => Promise<string>;

function args(method: string, params: Record<string, unknown>) {
  return [
    "--json",
    "--no-input",
    "--enable-commands-exact",
    "api.call",
    "api",
    "call",
    "calendar",
    "v3",
    `calendar.events.${method}`,
    "--params",
    JSON.stringify(params),
    "--scope",
    "https://www.googleapis.com/auth/calendar",
  ];
}

export function parseMembershipEvent(value: unknown): CalendarMemberEvent {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid calendar event");
  }
  const event = value as Record<string, unknown>;
  if (typeof event.id !== "string" || !event.id) {
    throw new Error("Calendar event has no ID");
  }
  if (event.status === "cancelled") {
    return { id: event.id, status: "cancelled", organizer: { email: "" }, attendees: [] };
  }
  const organizer = event.organizer as { email?: unknown } | undefined;
  if (
    typeof organizer?.email !== "string" ||
    !organizer.email ||
    event.attendeesOmitted === true ||
    (event.attendees !== undefined && !Array.isArray(event.attendees))
  ) {
    throw new Error(`Incomplete calendar event ${event.id}`);
  }
  const attendees = (event.attendees ?? []) as unknown[];
  for (const attendee of attendees) {
    if (
      !attendee ||
      typeof attendee !== "object" ||
      typeof (attendee as Record<string, unknown>).email !== "string" ||
      !(attendee as { email: string }).email.trim()
    ) {
      throw new Error(`Invalid attendee in event ${event.id}`);
    }
  }
  return {
    id: event.id,
    organizer: { email: organizer.email },
    attendees: attendees as CalendarMemberEvent["attendees"],
  };
}

export function protectedCalendarAttendee(
  event: CalendarMemberEvent,
  attendee: CalendarMemberEvent["attendees"][number],
  calendarId: string,
) {
  const email = attendee.email.trim().toLowerCase();
  return (
    attendee.resource === true ||
    attendee.organizer === true ||
    email === event.organizer.email.trim().toLowerCase() ||
    email === calendarId.trim().toLowerCase()
  );
}

export function calendarMembershipReader(capture: Capture): CalendarMembershipReader {
  return async (calendarId) => {
    const events = new Map<string, CalendarMemberEvent>();
    const seen = new Set<string>();
    let pageToken: string | undefined;
    const timeMin = new Date().toISOString();
    do {
      const body = JSON.parse(
        await capture(
          args("list", {
            calendarId,
            timeMin,
            singleEvents: false,
            showDeleted: false,
            maxResults: 250,
            ...(pageToken ? { pageToken } : {}),
          }),
        ),
      );
      if (
        body.kind !== "calendar#events" ||
        (body.items !== undefined && !Array.isArray(body.items))
      ) {
        throw new Error("Calendar returned an invalid event list");
      }
      for (const item of body.items ?? []) {
        const event = parseMembershipEvent(item);
        if (event.status !== "cancelled") {
          events.set(event.id, event);
        }
      }
      pageToken = body.nextPageToken;
      if (pageToken !== undefined && (typeof pageToken !== "string" || seen.has(pageToken))) {
        throw new Error("Invalid calendar pagination token");
      }
      if (pageToken) {
        seen.add(pageToken);
      }
    } while (pageToken);
    return [...events.values()];
  };
}

export async function removeFilteredCalendarAttendees(
  payload: Record<string, unknown>,
  capture: Capture,
  run: (args: string[]) => Promise<void>,
) {
  const calendarId = payload.calendar_id;
  const eventId = payload.event_id;
  if (
    typeof calendarId !== "string" ||
    !calendarId ||
    typeof eventId !== "string" ||
    !eventId ||
    !Array.isArray(payload.removed_attendees) ||
    !payload.removed_attendees.every((email) => typeof email === "string" && email.trim())
  ) {
    throw new Error("Invalid calendar membership removal payload");
  }
  const removed = new Set(
    (payload.removed_attendees as string[]).map((email) => email.trim().toLowerCase()),
  );
  const event = parseMembershipEvent(
    JSON.parse(await capture(args("get", { calendarId, eventId }))),
  );
  if (event.id !== eventId) {
    throw new Error("Calendar returned the wrong event");
  }
  if (event.status === "cancelled") {
    return;
  }
  // Re-read just before applying: subtract only approved addresses and preserve other guests,
  // RSVP states and optional/resource metadata. The ordinary gog update command drops these.
  const keep = event.attendees.filter(
    (attendee) =>
      protectedCalendarAttendee(event, attendee, calendarId) ||
      !removed.has(attendee.email.trim().toLowerCase()),
  );
  if (keep.length === event.attendees.length) {
    return;
  }
  await run([
    ...args("patch", { calendarId, eventId, sendUpdates: "none" }),
    "--allow-write",
    "--force",
    "--body",
    JSON.stringify({ attendees: keep }),
  ]);
}
