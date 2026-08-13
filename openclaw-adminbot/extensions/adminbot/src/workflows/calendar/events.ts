// Reading the lab's calendar, so the Calendar tab can offer real events to invite people to.
//
// This is the only *read* side the calendar has. Everything that writes goes through the proposal
// gate as a `calendar.*` action (contracts/actions.ts) and is executed by connectors/gog.ts; this
// module deliberately runs a read-only command and returns data, so nothing here can change a
// calendar even if a caller wanted it to.
//
// `gog` is spawned rather than imported for the same reason the rest of the connector layer spawns
// it: the CLI owns the OAuth token and its keyring, and a hung browser-less auth prompt must not be
// able to take the AdminBot API down with it.
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { resolveGogExecutable } from "../../connectors/gog.js";

const execFile = promisify(execFileCallback);
const EVENTS_TIMEOUT_MS = 45_000;
const EVENTS_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_EVENTS = 50;
// Two months forward covers "the conference block after this one" without pulling a year of
// recurring standups into a picker.
const DEFAULT_WINDOW_DAYS = 60;

export type AdminBotCalendarEvent = {
  id: string;
  summary: string;
  /** RFC3339 start, or a bare date for an all-day event — whichever Google returned. */
  start: string;
  end?: string;
  location?: string;
  description?: string;
  /** The calendar it lives on, so a later invite proposal names the same one. */
  calendar_id?: string;
  html_link?: string;
  /** Addresses already on the event, so the tab can avoid re-inviting them. */
  attendees?: string[];
  all_day?: boolean;
};

export type CalendarEventsReader = (params: {
  calendarId?: string;
  from?: string;
  to?: string;
  max?: number;
  query?: string;
}) => Promise<AdminBotCalendarEvent[]>;

type GogRun = (args: string[]) => Promise<string>;

function createGogRunner(env?: NodeJS.ProcessEnv): GogRun {
  const bin = resolveGogExecutable(env);
  return async (args) => {
    const { stdout } = await execFile(bin, args, {
      timeout: EVENTS_TIMEOUT_MS,
      maxBuffer: EVENTS_MAX_OUTPUT_BYTES,
      ...(env ? { env } : {}),
    });
    return stdout;
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Google returns `{ dateTime }` for a timed event and `{ date }` for an all-day one, and the two
 * are not interchangeable: a bare date parsed as a timestamp lands at UTC midnight, which is the
 * previous evening for everyone west of London. Keep whichever was sent and flag which it was.
 */
function readEdge(value: unknown): { at?: string; allDay: boolean } {
  if (!value || typeof value !== "object") {
    return { allDay: false };
  }
  const edge = value as Record<string, unknown>;
  const dateTime = asString(edge.dateTime);
  if (dateTime) {
    return { at: dateTime, allDay: false };
  }
  const date = asString(edge.date);
  return date ? { at: date, allDay: true } : { allDay: false };
}

function readAttendees(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      return asString(entry) ? [entry.trim()] : [];
    }
    if (entry && typeof entry === "object") {
      const email = asString((entry as Record<string, unknown>).email);
      return email ? [email] : [];
    }
    return [];
  });
}

/**
 * Turns one gog/Google event object into our shape, or drops it.
 *
 * An event with no id or no start cannot be invited to and cannot be sorted, so it is dropped
 * rather than rendered as a row that does nothing when clicked.
 */
export function parseCalendarEvent(value: unknown): AdminBotCalendarEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const id = asString(raw.id);
  const start = readEdge(raw.start);
  const startAt = start.at ?? asString(raw.start);
  if (!id || !startAt) {
    return undefined;
  }
  const end = readEdge(raw.end);
  const attendees = readAttendees(raw.attendees);
  const calendarId = asString(raw.calendarId) ?? asString(raw.calendar_id);
  return {
    id,
    // An untitled event is legal in Google and common for holds; name it rather than rendering a
    // blank row the operator cannot tell apart from the one above it.
    summary: asString(raw.summary) ?? "(no title)",
    start: startAt,
    ...(end.at ? { end: end.at } : {}),
    ...(asString(raw.location) ? { location: asString(raw.location) } : {}),
    ...(asString(raw.description) ? { description: asString(raw.description) } : {}),
    ...(calendarId ? { calendar_id: calendarId } : {}),
    ...(asString(raw.htmlLink) ? { html_link: asString(raw.htmlLink) } : {}),
    ...(attendees.length ? { attendees } : {}),
    ...(start.allDay || end.allDay ? { all_day: true } : {}),
  };
}

/**
 * gog `--json` prints either a bare array or an object wrapping one, depending on the command and
 * version. Accept both rather than pinning to whichever this box happens to print today.
 */
export function parseCalendarEvents(stdout: string): AdminBotCalendarEvent[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    throw new Error("gog calendar events did not return JSON");
  }
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? ((payload as Record<string, unknown>).events ??
        (payload as Record<string, unknown>).items ??
        [])
      : [];
  if (!Array.isArray(list)) {
    return [];
  }
  return list.flatMap((entry) => {
    const event = parseCalendarEvent(entry);
    return event ? [event] : [];
  });
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString();
}

export function createCalendarEventsReader(
  options: {
    env?: NodeJS.ProcessEnv;
    run?: GogRun;
    now?: () => number;
  } = {},
): CalendarEventsReader {
  const run = options.run ?? createGogRunner(options.env);
  const now = options.now ?? Date.now;
  return async (params) => {
    const from = params.from ?? isoDate(now());
    const to = params.to ?? isoDate(now() + DEFAULT_WINDOW_DAYS * 86_400_000);
    const args = ["calendar", "events", "list"];
    if (params.calendarId) {
      args.push(params.calendarId);
    }
    args.push(
      "--from",
      from,
      "--to",
      to,
      "--max",
      String(params.max ?? DEFAULT_MAX_EVENTS),
      "--order",
      "asc",
      "--json",
    );
    if (params.query) {
      args.push("--query", params.query);
    }
    return parseCalendarEvents(await run(args));
  };
}
