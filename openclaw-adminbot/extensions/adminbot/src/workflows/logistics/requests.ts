// What a submitted logistics request has to look like before it is stored, and what "soonest" means
// once it is.
//
// Two jobs live here. The first is the service's validation
// boundary: everything on a request arrives as text a member typed, including the bytes of a PDF,
// so nothing past this file may assume a field is present, a number is a number, or a base64 blob
// is small. The second is the deadline: a request is read as a queue and a queue needs one
// ordering. The shared deadline resolver keeps writes, legacy reads, reminders and the browser
// consistent while preserving the member's original date, time and timezone for display.
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
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
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
    ...optionalKey("letter_deadline", record.letter_deadline, 40),
    ...optionalKey("letter_deadline_time", record.letter_deadline_time, 40),
    ...optionalKey("deadline_timezone", record.deadline_timezone, 80),
    ...optionalKey("application_status", record.application_status, 120),
    ...optionalKey("letter_status", record.letter_status, 120),
    ...optionalKey("program", record.program, 260),
    ...optionalKey("program_link", record.program_link, 500),
    ...optionalKey("notes", record.notes),
  };
  // A row with nothing in it is a row the member left blank at the bottom of the table, not a
  // school. Dropping it here keeps "how many schools is this request for" honest.
  const hasContent = Object.entries(school).some(
    ([key, field]) => key !== "deadline_timezone" && typeof field === "string" && field,
  );
  return hasContent ? { ...school, deadline_timezone: school.deadline_timezone || "AoE" } : null;
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
    ...optionalKey("city", record.city, 120),
    // Kept as typed rather than normalized here. Whether the link is one anybody can open is a
    // question only the network can answer, so it is asked on the way to the sheet, not on the way
    // in -- storing a bad link is how the member gets told which link to fix.
    ...optionalKey("doc_prep_url", record.doc_prep_url, 500),
    ...(typeof record.whatsapp_hello === "boolean"
      ? { whatsapp_hello: record.whatsapp_hello }
      : {}),
    // Only a calendar date survives: the field answers "how long does this stay worth doing", and
    // a half-parsed "end of the month" would sort as an instant nobody meant.
    ...(ISO_DATE.test(text(record.latest_ok_date, 20))
      ? { latest_ok_date: text(record.latest_ok_date, 20) }
      : {}),
  };
  return meeting.purpose ||
    meeting.preferred_time ||
    meeting.length_minutes ||
    meeting.doc_prep_url ||
    meeting.city
    ? meeting
    : null;
}

export function isLogisticsRequestKind(value: unknown): value is AdminBotLogisticsRequestKind {
  return (
    typeof value === "string" &&
    (adminBotLogisticsRequestKinds as readonly string[]).includes(value)
  );
}

/** A letter's wall-clock deadline. Blank time means end of day; blank zone means AoE. */
export function deadlineInstant(date?: string, time?: string, zone?: string): string | undefined {
  const day = (date ?? "").trim();
  if (!ISO_DATE.test(day)) {
    return undefined;
  }
  const calendarDay = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(calendarDay.getTime()) || calendarDay.toISOString().slice(0, 10) !== day) {
    return undefined;
  }
  const clock = (time ?? "").trim() || "23:59";
  if (!CLOCK_TIME.test(clock)) {
    return undefined;
  }
  return toAbsoluteRfc3339(`${day}T${clock}`, (zone ?? "").trim() || "AoE");
}

/** The instant a proposed meeting starts. Meeting timezone defaults are unchanged. */
export function meetingInstant(meeting: AdminBotLogisticsMeeting): string | undefined {
  const preferred = (meeting.preferred_time ?? "").trim();
  if (!LOCAL_DATE_TIME.test(preferred)) {
    return undefined;
  }
  return toAbsoluteRfc3339(preferred, (meeting.timezone ?? "").trim() || "UTC");
}

export type LogisticsDeadline = { at: string; date: string; time: string; timezone: string };

/**
 * Keep the wall-clock fields alongside the instant used for ordering. A letter's application
 * cutoff is never the recommender's deadline, and a viewer's timezone must not change the date.
 * This pure helper is also used by the UI so legacy requests receive the same interpretation.
 */
export function requestDeadlineDetails(
  input: AdminBotLogisticsRequestInput,
): LogisticsDeadline | undefined {
  const deadlines: LogisticsDeadline[] = [];
  if (input.kind === "recommendation_letters") {
    for (const school of input.schools ?? []) {
      const at = deadlineInstant(
        school.letter_deadline,
        school.letter_deadline_time,
        school.deadline_timezone,
      );
      if (at) {
        deadlines.push({
          at,
          date: school.letter_deadline!.trim(),
          time: school.letter_deadline_time?.trim() || "23:59",
          timezone: school.deadline_timezone?.trim() || "AoE",
        });
      }
    }
  }
  if (input.kind === "book_meeting") {
    for (const meeting of input.meetings ?? []) {
      const at = meetingInstant(meeting);
      if (at) {
        deadlines.push({
          at,
          date: meeting.preferred_time!.slice(0, 10),
          time: meeting.preferred_time!.slice(11, 16),
          timezone: meeting.timezone?.trim() || "UTC",
        });
      }
    }
  }
  return deadlines.reduce<LogisticsDeadline | undefined>(
    (earliest, deadline) =>
      !earliest || Date.parse(deadline.at) < Date.parse(earliest.at) ? deadline : earliest,
    undefined,
  );
}

export function requestDeadline(input: AdminBotLogisticsRequestInput): string | undefined {
  return requestDeadlineDetails(input)?.at;
}

/** Read old letter requests with the current rule, without rewriting the member's stored data. */
export function withCurrentLogisticsDeadline(
  request: AdminBotLogisticsRequest,
): AdminBotLogisticsRequest {
  if (request.kind !== "recommendation_letters") {
    return request;
  }
  const { deadline_at: _previous, ...rest } = request;
  const deadline = requestDeadline(request);
  return { ...rest, ...(deadline ? { deadline_at: deadline } : {}) };
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
    for (const school of input.schools ?? []) {
      if (!school.letter_deadline?.trim()) {
        return `a letter deadline is required for ${school.school}`;
      }
      if (
        !deadlineInstant(
          school.letter_deadline,
          school.letter_deadline_time,
          school.deadline_timezone,
        )
      ) {
        return `invalid letter deadline, time, or timezone for ${school.school}`;
      }
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
    ...withCurrentLogisticsDeadline(request),
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
