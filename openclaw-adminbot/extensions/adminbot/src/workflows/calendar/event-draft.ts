// Turning "lunch with the reading group next Tuesday at 1, in the DCS lounge" into a structured
// event the operator can check before anything is proposed.
//
// The model reads a sentence and returns fields. It never reaches a calendar: the draft comes back
// to the tab, the operator edits it, and only then does it become a `calendar.*` proposal that
// still has to be approved and executed like every other external effect. That ordering is the
// whole point — a model that misreads "next Tuesday" produces a wrong *draft*, not a wrong meeting
// in somebody's calendar.
//
// The prompt asks for JSON and this module refuses anything else. A model that answers in prose,
// invents a field, or hands back an end before its start is a failed parse with a reason, not a
// half-filled form.
import type { AdminBotPrivacyTaskResult } from "../../contracts/actions.js";
import { normalizeCalendarTimezone } from "./time.js";

export type AdminBotCalendarEventDraft = {
  summary: string;
  /** RFC3339, or `YYYY-MM-DDTHH:mm` local to `timezone`. Exactly what goes on the proposal. */
  start: string;
  end: string;
  timezone?: string;
  location?: string;
  description?: string;
  /** Addresses the sentence itself named, if any. The tab's audience picker adds the rest. */
  attendees?: string[];
};

export type AdminBotCalendarDraftRequest = {
  prompt: string;
  /** The operator's timezone, so "1pm" means their 1pm rather than the server's. */
  timezone?: string;
  /** Overridable so a test pins "next Tuesday" to a known week. */
  now?: string;
  /**
   * The event being edited, when this is an edit rather than a new event.
   *
   * Present, the model is told what the event currently says and to change only what the
   * instruction asks for. Absent, it is composing from nothing. Same JSON either way, so the parser
   * and the review form below do not fork.
   */
  editing?: {
    summary: string;
    start: string;
    end?: string;
    location?: string;
    description?: string;
  };
};

const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/u;
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;
const MAX_PROMPT_CHARS = 2000;

/**
 * What the model is told. Written as one block rather than assembled from fragments so the whole
 * instruction can be read at once — a scheduling prompt that drifts out of step with the parser
 * below is how a model starts returning fields nothing reads.
 */
export function buildEventDraftPrompt(request: AdminBotCalendarDraftRequest): string {
  const now = request.now ?? new Date().toISOString();
  const timezone = request.timezone?.trim() || "UTC";
  const editing = request.editing;
  return [
    editing
      ? "You apply a short instruction to one calendar event that already exists."
      : "You turn a short scheduling instruction into one calendar event.",
    "",
    `The current time is ${now}. The person writing is in the ${timezone} timezone;`,
    "resolve every relative date and time against that, not against UTC.",
    "",
    "Answer with a single JSON object and nothing else. No prose, no code fence.",
    "Keys:",
    '  "summary"     — the event title, in the words a guest would want to read.',
    '  "start"       — "YYYY-MM-DDTHH:mm", local to the timezone above.',
    '  "end"         — same format. If no duration is given, use one hour.',
    '  "location"    — omit unless the instruction names a place.',
    '  "description" — omit unless there is detail beyond the title.',
    '  "attendees"   — array of email addresses the instruction names. Omit if none.',
    "Do not return a timezone key; the service supplies the trusted timezone above.",
    "",
    "Never invent an attendee, a room, or a video link that was not asked for.",
    editing
      ? // The whole event comes back every time, so an edit that only moves the time still has to
        // repeat the title. Saying so is what stops a model returning `{start, end}` alone and the
        // update wiping the fields it left out.
        [
          "Return the event as it should be AFTER the change, with every field filled in —",
          "including the ones the instruction does not mention. Change only what it asks for.",
          "",
          "The event currently reads:",
          `  title:       ${editing.summary}`,
          `  starts:      ${editing.start}`,
          `  ends:        ${editing.end ?? "(not set)"}`,
          `  location:    ${editing.location ?? "(not set)"}`,
          `  description: ${editing.description ?? "(not set)"}`,
        ].join("\n")
      : [
          "If the instruction does not say what the event is, use its own words as the summary",
          "rather than guessing a purpose.",
        ].join("\n"),
    "",
    "Instruction:",
    request.prompt.trim().slice(0, MAX_PROMPT_CHARS),
  ].join("\n");
}

function asTrimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Pulls the JSON object out of a model answer.
 *
 * Models fence JSON even when told not to, and some prepend a line of agreement. Taking the first
 * `{` through the last `}` handles both without accepting an answer that has no object at all.
 */
function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start !== -1 && end > start ? text.slice(start, end + 1) : undefined;
}

function readAttendees(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const email = asTrimmed(entry);
    // Shape only. The service validates addresses properly wherever one is actually sent; here a
    // stray sentence in the array would otherwise ride into the proposal as an "attendee".
    return email && email.includes("@") ? [email] : [];
  });
}

/**
 * Comparable form for the ordering check.
 *
 * Both edges come from the same model answer in the same timezone, so comparing them as text is
 * enough to catch an end before its start — and it avoids parsing a zoneless local time as UTC,
 * which would shift both edges and could turn a valid pair into an invalid one.
 */
function comparableEdge(value: string): string {
  return value.length === 16 ? `${value}:00` : value;
}

export type AdminBotCalendarDraftParse =
  | { ok: true; draft: AdminBotCalendarEventDraft }
  | { ok: false; error: string };

export function parseEventDraft(
  text: string,
  fallbackTimezone?: string,
): AdminBotCalendarDraftParse {
  const json = extractJsonObject(text ?? "");
  if (!json) {
    return { ok: false, error: "the model did not return a JSON object" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return { ok: false, error: "the model's answer was not valid JSON" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "the model's answer was not a JSON object" };
  }
  const raw = payload as Record<string, unknown>;
  const summary = asTrimmed(raw.summary);
  if (!summary) {
    return { ok: false, error: "the draft has no title" };
  }
  const start = asTrimmed(raw.start);
  const end = asTrimmed(raw.end);
  if (!start || !end) {
    return { ok: false, error: "the draft is missing a start or an end time" };
  }
  for (const [label, value] of [
    ["start", start],
    ["end", end],
  ] as const) {
    if (!ISO_LOCAL.test(value) && !ISO_ZONED.test(value)) {
      return { ok: false, error: `the ${label} time is not a date and time the calendar accepts` };
    }
  }
  if (comparableEdge(end) <= comparableEdge(start)) {
    return { ok: false, error: "the draft ends before it starts" };
  }
  const attendees = readAttendees(raw.attendees);
  // The prompt defines no model-owned timezone field: every local clock above is explicitly in
  // the operator zone supplied with the request. Trusting an invented field here let prose such as
  // "Anywhere on Earth (AoE, UTC−12)" override that IANA value and crash the later Intl conversion.
  const timezone = normalizeCalendarTimezone(fallbackTimezone);
  if (fallbackTimezone?.trim() && !timezone) {
    return { ok: false, error: "the operator time zone is not a valid IANA time zone" };
  }
  return {
    ok: true,
    draft: {
      summary,
      start,
      end,
      ...(timezone ? { timezone } : {}),
      ...(asTrimmed(raw.location) ? { location: asTrimmed(raw.location) as string } : {}),
      ...(asTrimmed(raw.description) ? { description: asTrimmed(raw.description) as string } : {}),
      ...(attendees.length ? { attendees } : {}),
    },
  };
}

function readBrokerText(result: AdminBotPrivacyTaskResult): string {
  return asTrimmed(result.output) ?? "";
}

export type EventDraftRunner = (
  request: AdminBotCalendarDraftRequest,
) => Promise<AdminBotCalendarDraftParse>;

/**
 * Drafts through the privacy broker rather than a raw model call, so a prompt naming a member gets
 * the same placeholder treatment every other AdminBot reasoning task gets. Scheduling text is full
 * of names.
 */
export function createEventDraftRunner(
  handle: (request: {
    task: string;
    privacy?: "auto" | "private";
  }) => Promise<AdminBotPrivacyTaskResult>,
): EventDraftRunner {
  return async (request) => {
    const prompt = request.prompt?.trim();
    if (!prompt) {
      return { ok: false, error: "describe the event first" };
    }
    const result = await handle({ task: buildEventDraftPrompt({ ...request, prompt }) });
    const text = readBrokerText(result);
    if (!text) {
      return { ok: false, error: "the model returned nothing" };
    }
    return parseEventDraft(text, request.timezone);
  };
}
