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
import { createCachedRead, type CachedRead } from "../../kernel/cached-read.js";

const execFile = promisify(execFileCallback);
const EVENTS_TIMEOUT_MS = 45_000;
const EVENTS_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_EVENTS = 50;
// Two months forward covers "the conference block after this one" without pulling a year of
// recurring standups into a picker.
const DEFAULT_WINDOW_DAYS = 60;
// How long a calendar read is handed back without asking Google again, and how long past that it
// may still be served while a fresh one runs behind it. See createCachedCalendarEventsReader.
const EVENTS_FRESH_MS = 60_000;
const EVENTS_STALE_MS = 5 * 60_000;
// The parameter sets kept at once. The Calendar tab and the meetings page ask with a handful of
// fixed shapes; a caller paging through arbitrary ranges must not grow the map without bound.
const EVENTS_MAX_KEYS = 32;
// A parameter set asked for within this long is read again behind the page by keepWarm.
const EVENTS_WARM_WINDOW_MS = 30 * 60_000;

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
  /**
   * The series an occurrence belongs to, as Google reports it. Not derivable from the id: once a
   * meeting is edited "this and following", its later occurrences keep the original id prefix but
   * belong to a new `<base>_R<instant>` series, and the base series stops at the split.
   */
  recurring_event_id?: string;
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
  if (raw.status === "cancelled") {
    return undefined;
  }
  if (raw.attendeesOmitted === true) {
    throw new Error("Calendar attendee list was omitted; refusing an incomplete read");
  }
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
    ...(asString(raw.recurringEventId)
      ? { recurring_event_id: asString(raw.recurringEventId) }
      : {}),
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
    // Not JSON at all — usually gog's own refusal ("missing --account", an auth error) on a path
    // where it still exits 0. Carry the text: it is the whole diagnosis.
    throw new Error(`gog calendar events did not return JSON: ${trimmed.slice(0, 200)}`);
  }
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? ((payload as Record<string, unknown>).events ?? (payload as Record<string, unknown>).items)
      : undefined;
  // Anything else is a shape we do not understand, and reporting it as an empty calendar is the
  // worst possible answer: the month renders blank and nobody can tell "nothing booked" from "we
  // could not read it". Say what came back instead.
  if (!Array.isArray(list)) {
    throw new Error(`gog calendar events returned an unexpected shape: ${trimmed.slice(0, 200)}`);
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
    // `--no-input` and `--account` for the same reasons connectors/gog.ts passes them: a CLI that
    // can prompt will hang a service until the timeout instead of failing, and gog refuses outright
    // ("missing --account") when it cannot tell which stored token to use. GOG_ACCOUNT is the
    // deployment's answer to that, so it is passed explicitly rather than left to be inherited.
    const args = ["--no-input"];
    const account = (options.env ?? process.env).GOG_ACCOUNT?.trim();
    if (account) {
      args.push("--account", account);
    }
    args.push("calendar", "events", "list");
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

/**
 * The window the Calendar tab asks for when it opens: the month `at` falls in, in `timezone`, as
 * whole UTC days from the 1st to the next month's 1st. It must match the UI's monthWindow exactly,
 * since the kept reads are keyed on these strings.
 */
export function calendarMonthWindow(
  timezone: string,
  at = Date.now(),
): { from: string; to: string } {
  let year: number;
  let month: number;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "numeric",
    }).formatToParts(at);
    year = Number(parts.find((part) => part.type === "year")?.value);
    month = Number(parts.find((part) => part.type === "month")?.value);
  } catch {
    year = new Date(at).getUTCFullYear();
    month = new Date(at).getUTCMonth() + 1;
  }
  const first = (y: number, m: number) =>
    `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01T00:00:00.000Z`;
  return {
    from: first(year, month),
    to: month === 12 ? first(year + 1, 1) : first(year, month + 1),
  };
}

export type CachedCalendarEventsReader = {
  read: CalendarEventsReader;
  /** Forget every kept read, so the next one asks Google. Call it after a calendar write. */
  invalidate(): void;
  /**
   * Reads `seeds` now, then every `intervalMs` reads again each parameter set asked for in the
   * last half hour, and does the same right after each invalidate. The first viewer after a
   * restart or a calendar write is then handed a kept answer instead of waiting on gog.
   * Returns a stop.
   */
  keepWarm(
    intervalMs: number,
    seeds?: Parameters<CalendarEventsReader>[0][] | (() => Parameters<CalendarEventsReader>[0][]),
  ): () => void;
};

/**
 * `read` with each parameter set's answer kept for a minute and served for a few more while a
 * fresh one is fetched behind it.
 *
 * Every read is a `gog` process and a Google round trip, which is seconds on the live host and
 * was being paid by every load of the Calendar tab and the meetings page. The key is the
 * parameters as the caller passed them, before `from`/`to` default to "now": keyed on the
 * resolved window, a caller that leaves them out would never hit, and the minutes a kept default
 * window lags behind the clock do not matter to a two-month listing. Writes made from here go
 * through the executor, which calls `invalidate()` after every `calendar.*` action; a change made
 * in Google directly shows up once the kept answer goes stale.
 */
export function createCachedCalendarEventsReader(
  read: CalendarEventsReader,
  options: { now?: () => number } = {},
): CachedCalendarEventsReader {
  const now = options.now ?? (() => Date.now());
  const reads = new Map<string, CachedRead<AdminBotCalendarEvent[]>>();
  // What was asked for and when, kept across invalidate so keepWarm knows what to read again.
  const asked = new Map<string, { params: Parameters<CalendarEventsReader>[0]; at: number }>();
  let warm: (() => void) | undefined;
  const keyOf = (params: Parameters<CalendarEventsReader>[0]) =>
    JSON.stringify([
      params.calendarId ?? null,
      params.from ?? null,
      params.to ?? null,
      params.max ?? null,
      params.query ?? null,
    ]);
  const entry = (params: Parameters<CalendarEventsReader>[0]) => {
    const key = keyOf(params);
    let cached = reads.get(key);
    if (!cached) {
      if (reads.size >= EVENTS_MAX_KEYS) {
        // Insertion order, so this drops the parameter set that was first asked for.
        reads.delete(reads.keys().next().value!);
      }
      cached = createCachedRead(() => read(params), {
        freshMs: EVENTS_FRESH_MS,
        staleMs: EVENTS_STALE_MS,
        ...(options.now ? { now: options.now } : {}),
      });
      reads.set(key, cached);
    }
    return { key, cached };
  };
  return {
    read(params) {
      const { key, cached } = entry(params);
      if (asked.size >= EVENTS_MAX_KEYS && !asked.has(key)) {
        asked.delete(asked.keys().next().value!);
      }
      asked.set(key, { params, at: now() });
      return cached.read();
    },
    invalidate() {
      // Each entry's own invalidate as well as the clear, so a read already under way when the
      // write landed cannot put its pre-write answer back.
      for (const cached of reads.values()) {
        cached.invalidate();
      }
      reads.clear();
      warm?.();
    },
    keepWarm(intervalMs, seeds = []) {
      warm = () => {
        // Seeds are worked out on every tick, so one that names "this month" moves with the clock.
        const due = new Map<string, Parameters<CalendarEventsReader>[0]>();
        for (const params of typeof seeds === "function" ? seeds() : seeds) {
          due.set(keyOf(params), params);
        }
        for (const [key, { params, at }] of asked) {
          if (now() - at < EVENTS_WARM_WINDOW_MS) {
            due.set(key, params);
          }
        }
        for (const params of due.values()) {
          // A failed read is not kept; the page then reads for itself, as before.
          entry(params)
            .cached.refresh()
            .catch(() => {});
        }
      };
      warm();
      const timer = setInterval(warm, intervalMs);
      timer.unref?.();
      return () => {
        clearInterval(timer);
        warm = undefined;
      };
    },
  };
}
