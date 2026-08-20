// What a submitted logistics request has to look like before it is stored, and what "soonest" means
// once it is.
//
// Two jobs live here and both are the service's, not a route's or a browser's. The first is the
// boundary: everything on a request arrives as text a member typed, including the bytes of a PDF,
// so nothing past this file may assume a field is present, a number is a number, or a base64 blob
// is small. The second is the deadline: a request is read as a queue and a queue needs one
// ordering, so the soonest instant a request is working towards is resolved once on write rather
// than re-derived by every reader out of dates, times and zones that each of them would have to
// interpret the same way.
//
// Nothing here reaches a connector. A stored request is a record of an ask, and acting on it is an
// admin's own work -- see the header on the contract types.
import type {
  AdminBotLogisticsAttachment,
  AdminBotLogisticsFact,
  AdminBotLogisticsMeeting,
  AdminBotLogisticsRequest,
  AdminBotLogisticsRequestInput,
  AdminBotLogisticsRequestKind,
  AdminBotLogisticsSchool,
} from "../../contracts/actions.js";
import { adminBotLogisticsRequestKinds } from "../../contracts/actions.js";
import { toAbsoluteRfc3339 } from "../calendar/time.js";

/**
 * Per-file and per-request byte caps on the decoded attachment.
 *
 * A request is one JSON row that is read back in full whenever it is opened, so the ceiling is not
 * "what fits in SQLite" but "what a browser can be handed without the tab dying". Five megabytes
 * covers a scanned multi-page form, which is the largest thing anyone has ever needed signed; the
 * request cap is what stops twenty of them arriving at once.
 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
/** Enough for a document set plus its context, and low enough that a runaway loop is caught here. */
export const MAX_ATTACHMENTS_PER_LIST = 25;
export const MAX_ROWS = 100;
/** Free text is stored and re-rendered, so it is bounded like everything else. */
export const MAX_TEXT_LENGTH = 5_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const CLOCK_TIME = /^\d{2}:\d{2}$/u;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

function text(value: unknown, limit = MAX_TEXT_LENGTH): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

/** Keeps a field off the record entirely when it is blank, so an absent value reads as absent. */
function optionalText(value: unknown, limit = MAX_TEXT_LENGTH): { value?: string } {
  const trimmed = text(value, limit);
  return trimmed ? { value: trimmed } : {};
}

function rows<T>(value: unknown, map: (entry: unknown) => T | null): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .slice(0, MAX_ROWS)
    .map(map)
    .filter((entry): entry is T => entry !== null);
}

/**
 * The decoded byte length of a base64 string, or -1 when it is not base64 at all.
 *
 * Computed from the length rather than by decoding: the point of the check is to refuse a payload
 * before it is turned into a buffer, and decoding 200MB to find out it is 200MB defeats that.
 */
export function base64ByteLength(value: string): number {
  const compact = value.replace(/\s/gu, "");
  if (!BASE64.test(compact) || compact.length % 4 !== 0) {
    return -1;
  }
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return (compact.length / 4) * 3 - padding;
}

function parseAttachment(value: unknown): AdminBotLogisticsAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const name = text(record.name, 260);
  if (!name) {
    return null;
  }
  const data = typeof record.data_base64 === "string" ? record.data_base64.replace(/\s/gu, "") : "";
  const size = data ? base64ByteLength(data) : 0;
  const contentType = optionalText(record.content_type, 160);
  return {
    name,
    // Never the client's own `size`: the number that matters is what the bytes actually weigh, and
    // that is the one the caps are checked against.
    size: Math.max(0, size),
    ...(contentType.value ? { content_type: contentType.value } : {}),
    ...(data ? { data_base64: data } : {}),
  };
}

function parseSchool(value: unknown): AdminBotLogisticsSchool | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const school: AdminBotLogisticsSchool = {
    school: text(record.school, 260),
    ...optionalKey("application_deadline", record.application_deadline, 10),
    ...optionalKey("application_deadline_time", record.application_deadline_time, 5),
    ...optionalKey("letter_deadline", record.letter_deadline, 10),
    ...optionalKey("letter_deadline_time", record.letter_deadline_time, 5),
    ...optionalKey("deadline_timezone", record.deadline_timezone, 80),
    ...optionalKey("application_status", record.application_status, 120),
    ...optionalKey("letter_status", record.letter_status, 120),
    ...optionalKey("program", record.program, 260),
    ...optionalKey("program_link", record.program_link, 500),
    ...optionalKey("notes", record.notes),
  };
  // A row with nothing in it is a row the member left blank at the bottom of the table, not a
  // school. Dropping it here keeps "how many schools is this request for" honest.
  return Object.values(school).some((field) => typeof field === "string" && field) ? school : null;
}

function optionalKey<K extends string>(
  key: K,
  value: unknown,
  limit?: number,
): Partial<Record<K, string>> {
  const trimmed = text(value, limit);
  return trimmed ? ({ [key]: trimmed } as Record<K, string>) : {};
}

function parseFact(value: unknown): AdminBotLogisticsFact | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const fact = {
    project: text(record.project, 260),
    contribution: text(record.contribution),
  };
  return fact.project || fact.contribution ? fact : null;
}

function parseMeeting(value: unknown): AdminBotLogisticsMeeting | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const length = Number(record.length_minutes);
  const submittedAt = text(record.submitted_at, 40);
  const meeting: AdminBotLogisticsMeeting = {
    purpose: text(record.purpose, 500),
    ...optionalKey("preferred_time", record.preferred_time, 20),
    ...optionalKey("timezone", record.timezone, 80),
    // Bounded rather than dropped: a typo'd 6000 is a real request with a wrong number in it, and
    // clamping keeps the row while making the column safe to add up.
    ...(Number.isFinite(length) && length > 0
      ? { length_minutes: Math.min(Math.round(length), 24 * 60) }
      : {}),
    ...(submittedAt && !Number.isNaN(Date.parse(submittedAt))
      ? { submitted_at: new Date(submittedAt).toISOString() }
      : {}),
  };
  return meeting.purpose || meeting.preferred_time || meeting.length_minutes ? meeting : null;
}

export function isLogisticsRequestKind(value: unknown): value is AdminBotLogisticsRequestKind {
  return (
    typeof value === "string" &&
    (adminBotLogisticsRequestKinds as readonly string[]).includes(value)
  );
}

/**
 * A wall-clock deadline as an absolute instant.
 *
 * A date with no time is due at the end of that day, not the start of it: a member who writes
 * "December 1" has until December 1 is over, and treating it as midnight would mark a request late
 * a full day early. A blank zone reads as UTC -- the form asks for a zone the moment a time is
 * typed, so a timed deadline with no zone is already the unusual case, and UTC is the one guess
 * that does not silently shift with whoever happens to be reading.
 */
export function deadlineInstant(date?: string, time?: string, zone?: string): string | undefined {
  const day = (date ?? "").trim();
  if (!ISO_DATE.test(day)) {
    return undefined;
  }
  const clock = (time ?? "").trim();
  const wall = `${day}T${CLOCK_TIME.test(clock) ? clock : "23:59"}`;
  return toAbsoluteRfc3339(wall, (zone ?? "").trim() || "UTC");
}

/** The instant a proposed meeting starts, which is the thing a meeting request is working towards. */
export function meetingInstant(meeting: AdminBotLogisticsMeeting): string | undefined {
  const preferred = (meeting.preferred_time ?? "").trim();
  if (!LOCAL_DATE_TIME.test(preferred)) {
    return undefined;
  }
  return toAbsoluteRfc3339(preferred, (meeting.timezone ?? "").trim() || "UTC");
}

/**
 * The soonest instant anything on this request is due.
 *
 * Both dates on every school count -- a letter is late if either passes -- and every proposed
 * meeting slot counts. A signature request names no date of its own: the deadline lives in the
 * member's prose, and guessing one out of a sentence would be worse than admitting there is none.
 */
export function requestDeadline(input: AdminBotLogisticsRequestInput): string | undefined {
  const instants: string[] = [];
  for (const school of input.schools ?? []) {
    const zone = school.deadline_timezone;
    const application = deadlineInstant(
      school.application_deadline,
      school.application_deadline_time,
      zone,
    );
    const letter = deadlineInstant(school.letter_deadline, school.letter_deadline_time, zone);
    if (application) {
      instants.push(application);
    }
    if (letter) {
      instants.push(letter);
    }
  }
  for (const meeting of input.meetings ?? []) {
    const instant = meetingInstant(meeting);
    if (instant) {
      instants.push(instant);
    }
  }
  // RFC3339 instants from toISOString are all UTC and fixed-width, so the string minimum is the
  // chronological one.
  return instants.length
    ? instants.reduce((soonest, at) => (at < soonest ? at : soonest))
    : undefined;
}

/**
 * Everything the request carries, cleaned to its own kind.
 *
 * Fields belonging to another template are dropped rather than kept: a meeting request that
 * arrived with a schools table would otherwise sort on a deadline no admin can see anywhere on the
 * screen, and a client bug would become a data bug.
 */
export function normalizeLogisticsRequestInput(
  input: AdminBotLogisticsRequestInput,
): AdminBotLogisticsRequestInput {
  if (input.kind === "document_signature") {
    return {
      kind: "document_signature",
      documents: rows(input.documents, parseAttachment),
      ...optionalKey("description", input.description),
      attachments: rows(input.attachments, parseAttachment),
    };
  }
  if (input.kind === "recommendation_letters") {
    return {
      kind: "recommendation_letters",
      schools: rows(input.schools, parseSchool),
      facts: rows(input.facts, parseFact),
      ...optionalKey("cv_overleaf_url", input.cv_overleaf_url, 500),
      ...optionalKey("drive_folder_url", input.drive_folder_url, 500),
    };
  }
  return { kind: "book_meeting", meetings: rows(input.meetings, parseMeeting) };
}

function attachmentsOf(input: AdminBotLogisticsRequestInput): AdminBotLogisticsAttachment[] {
  return [...(input.documents ?? []), ...(input.attachments ?? [])];
}

/**
 * Why this request cannot be stored, or null when it can.
 *
 * Emptiness is a validation failure and not a silent accept: an empty request in the queue costs
 * an admin the same click as a real one, and the member who sent it believes they asked.
 */
export function validateLogisticsRequest(input: AdminBotLogisticsRequestInput): string | null {
  if (!isLogisticsRequestKind(input.kind)) {
    return "kind must be one of " + adminBotLogisticsRequestKinds.join(", ");
  }
  const attachments = attachmentsOf(input);
  if (attachments.length > MAX_ATTACHMENTS_PER_LIST) {
    return `a request carries at most ${MAX_ATTACHMENTS_PER_LIST} files`;
  }
  let total = 0;
  for (const file of attachments) {
    if (file.data_base64 && base64ByteLength(file.data_base64) < 0) {
      return `${file.name} is not readable as base64`;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return `${file.name} is larger than ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB`;
    }
    total += file.size;
  }
  if (total > MAX_REQUEST_BYTES) {
    return `the files on this request total more than ${Math.floor(MAX_REQUEST_BYTES / (1024 * 1024))}MB`;
  }
  if (input.kind === "document_signature" && !(input.documents ?? []).length) {
    return "a signature request needs at least one document to sign";
  }
  if (input.kind === "recommendation_letters") {
    if (!(input.schools ?? []).length) {
      return "a letters request needs at least one school";
    }
    if ((input.schools ?? []).some((school) => !school.school.trim())) {
      return "every school row needs the school's name";
    }
  }
  if (input.kind === "book_meeting") {
    if (!(input.meetings ?? []).length) {
      return "a meeting request needs at least one proposed meeting";
    }
    if ((input.meetings ?? []).some((meeting) => !meeting.purpose.trim())) {
      return "every meeting row needs a purpose";
    }
  }
  return null;
}

/**
 * A submitted request, or the reason it was refused.
 *
 * Normalize first, then validate: the checks are written against cleaned rows, so "every school
 * needs a name" cannot be fooled by a row whose name is three spaces, and the size caps are checked
 * against the bytes the base64 actually decodes to rather than a `size` the client sent along.
 */
export function prepareLogisticsRequest(
  input: AdminBotLogisticsRequestInput,
  identity: { id: string; member_id: string; member_name: string },
  nowIso: string,
): { ok: true; request: AdminBotLogisticsRequest } | { ok: false; error: string } {
  if (!isLogisticsRequestKind(input?.kind)) {
    return {
      ok: false,
      error: `kind must be one of ${adminBotLogisticsRequestKinds.join(", ")}`,
    };
  }
  const normalized = normalizeLogisticsRequestInput(input);
  const invalid = validateLogisticsRequest(normalized);
  if (invalid) {
    return { ok: false, error: invalid };
  }
  const deadline = requestDeadline(normalized);
  return {
    ok: true,
    request: {
      ...normalized,
      id: identity.id,
      member_id: identity.member_id,
      member_name: identity.member_name,
      status: "submitted",
      submitted_at: nowIso,
      updated_at: nowIso,
      ...(deadline ? { deadline_at: deadline } : {}),
    },
  };
}

/**
 * The same request without the file bytes.
 *
 * The list read strips them because a queue of twenty requests is otherwise twenty PDFs down the
 * wire to draw a table of names and dates. The names and sizes stay, so the list can say what is
 * attached; opening one request fetches that one in full.
 */
export function withoutAttachmentBytes(
  request: AdminBotLogisticsRequest,
): AdminBotLogisticsRequest {
  const strip = (
    files?: AdminBotLogisticsAttachment[],
  ): AdminBotLogisticsAttachment[] | undefined =>
    files?.map(({ data_base64: _bytes, ...rest }) => rest);
  const documents = strip(request.documents);
  const attachments = strip(request.attachments);
  return {
    ...request,
    ...(documents ? { documents } : {}),
    ...(attachments ? { attachments } : {}),
  };
}

/**
 * Most urgent first, which is the order the queue is worked in.
 *
 * A request with no deadline sorts last rather than first -- there is nothing to be late for -- and
 * ties break on the most recently submitted.
 */
export function byUrgency(left: AdminBotLogisticsRequest, right: AdminBotLogisticsRequest): number {
  if (left.deadline_at !== right.deadline_at) {
    if (!left.deadline_at) {
      return 1;
    }
    if (!right.deadline_at) {
      return -1;
    }
    return left.deadline_at < right.deadline_at ? -1 : 1;
  }
  return right.submitted_at.localeCompare(left.submitted_at);
}
