// Turning what is on screen into a request the service will take, and what came back into
// something the list can draw.
//
// The seam this module used to be -- "requests live in the member's own browser" -- is gone: a
// submitted request is stored by the service (POST /logistics/requests), read back scoped to the
// caller, and the admin list is the lab's, not one laptop's. What is left here is the two
// conversions either side of that wire, kept out of the views so a form field and a stored field
// can be lined up in one place.
//
// Nothing here talks to the network. The calls live in controllers/logistics.ts, for the same
// reason every other tab's do.
import type {
  LogisticsAttachment,
  LogisticsFact,
  LogisticsRequest,
  LogisticsMeeting,
  LogisticsRequestInput,
  LogisticsRequestKind,
  LogisticsSchool,
} from "../auth/session.ts";
import type { LetterFact, MeetingRequestRow, RecommendationSchool } from "./logistics-draft.ts";
import {
  createFactRow,
  createMeetingRow,
  createSchoolRow,
  isEmptyFactRow,
  isEmptyMeetingRow,
  isEmptySchoolRow,
} from "./logistics-draft.ts";

export type {
  LogisticsAttachment,
  LogisticsRequest,
  LogisticsRequestInput,
  LogisticsRequestKind,
  LogisticsRequestStatus,
} from "../auth/session.ts";

/**
 * The per-file ceiling, mirrored from the service.
 *
 * Checked here as well as there so a member who attached a 40MB scan is told before they wait for
 * the upload, and told which file it was. The service is what enforces it -- this is the courtesy
 * copy, and the comment is here so the day one of them moves, both do.
 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 20 * 1024 * 1024;

/** The template a form belongs to, as the service names it. */
export const REQUEST_KIND_BY_TEMPLATE = {
  documentSignature: "document_signature",
  recommendationLetters: "recommendation_letters",
  bookMeeting: "book_meeting",
} as const satisfies Record<string, LogisticsRequestKind>;

function omitBlank(fields: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields).flatMap(([key, value]) =>
      value?.trim() ? [[key, value.trim()] as const] : [],
    ),
  );
}

/**
 * A picked File as the wire carries it.
 *
 * Base64 rather than a multipart upload because the request is one JSON document end to end: there
 * is no upload endpoint to point a FormData at, and inventing one for the handful of PDFs a lab
 * signs each term would be more moving parts than the feature is worth. FileReader rather than
 * `Uint8Array.toBase64` -- the latter is not in every browser the lab runs yet.
 */
export function fileToAttachment(file: File): Promise<LogisticsAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      // A data: URL is "data:<type>;base64,<payload>"; the service wants the payload alone.
      const comma = result.indexOf(",");
      resolve({
        name: file.name,
        size: file.size,
        ...(file.type ? { content_type: file.type } : {}),
        data_base64: comma >= 0 ? result.slice(comma + 1) : "",
      });
    });
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error(`Could not read ${file.name}.`)),
    );
    reader.readAsDataURL(file);
  });
}

export async function filesToAttachments(files: readonly File[]): Promise<LogisticsAttachment[]> {
  return Promise.all(files.map(fileToAttachment));
}

/** The file the browser saves when an admin opens a document off a request. */
export function attachmentDataUrl(attachment: LogisticsAttachment): string {
  const type = attachment.content_type || "application/octet-stream";
  return `data:${type};base64,${attachment.data_base64 ?? ""}`;
}

/**
 * Hands one attachment to the browser as a download.
 *
 * A blob and a synthetic click rather than a link in the markup, because the queue's rows do not
 * hold the bytes: the list read deliberately carries names and sizes only, so the file is fetched
 * when somebody actually wants it. A data: URL would work for small files, but a blob keeps a
 * multi-megabyte PDF out of the DOM.
 */
export function saveAttachment(attachment: LogisticsAttachment): void {
  const binary = atob(attachment.data_base64 ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const url = URL.createObjectURL(
    new Blob([bytes], { type: attachment.content_type || "application/octet-stream" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.name;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next tick rather than immediately: Safari has not always started the download
  // by the time click() returns, and a revoked URL cancels it.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * A byte count as a person reads it.
 *
 * Lives in the data layer rather than in either view because both of them show file sizes -- the
 * form as the member picks files, the detail as an admin reads them -- and a second copy would be
 * two answers to "how big is this" the day one of them is adjusted.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below 10 so "1.4 MB" keeps its precision, none above so "247 KB" stays terse.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Which file, if any, puts the request over a cap. Returned as a name so the message can say it. */
export function oversizedFile(files: readonly File[]): File | null {
  return files.find((file) => file.size > MAX_ATTACHMENT_BYTES) ?? null;
}

export function totalFileBytes(files: readonly File[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}

export function schoolToWire(row: RecommendationSchool): LogisticsSchool {
  return {
    school: row.school.trim(),
    ...omitBlank({
      application_deadline: row.applicationDeadline,
      application_deadline_time: row.applicationDeadlineTime,
      letter_deadline: row.letterDeadline,
      letter_deadline_time: row.letterDeadlineTime,
      deadline_timezone: row.deadlineTimezone,
      application_status: row.applicationStatus,
      letter_status: row.letterStatus,
      program: row.program,
      program_link: row.programLink,
      notes: row.notes,
    }),
  };
}

export function factToWire(row: LetterFact): LogisticsFact {
  return { project: row.project.trim(), contribution: row.contribution.trim() };
}

export function meetingToWire(row: MeetingRequestRow): LogisticsMeeting {
  const minutes = Number(row.lengthMinutes);
  return {
    purpose: row.purpose.trim(),
    ...omitBlank({ preferred_time: row.preferredTime, timezone: row.timezone }),
    ...(Number.isFinite(minutes) && minutes > 0 ? { length_minutes: Math.round(minutes) } : {}),
    // The stamp travels with the row: it is when the member asked, and re-stamping it on submit
    // would make every row on a request look like it was raised at the same moment.
    ...(row.submittedAt > 0 ? { submitted_at: new Date(row.submittedAt).toISOString() } : {}),
  };
}

/** The blank row at the bottom of a table is not a request for anything. */
export function filledSchools(rows: readonly RecommendationSchool[]): RecommendationSchool[] {
  return rows.filter((row) => !isEmptySchoolRow(row));
}

export function filledFacts(rows: readonly LetterFact[]): LetterFact[] {
  return rows.filter((row) => !isEmptyFactRow(row));
}

export function filledMeetings(rows: readonly MeetingRequestRow[]): MeetingRequestRow[] {
  return rows.filter((row) => !isEmptyMeetingRow(row));
}

export type SignatureFormState = {
  files: File[];
  description: string;
  attachments: File[];
};

export type LettersFormState = {
  schools: readonly RecommendationSchool[];
  facts: readonly LetterFact[];
  cvOverleafUrl: string;
  driveFolderUrl: string;
};

export type MeetingFormState = { rows: readonly MeetingRequestRow[] };

export async function signatureRequestInput(
  form: SignatureFormState,
): Promise<LogisticsRequestInput> {
  const [documents, attachments] = await Promise.all([
    filesToAttachments(form.files),
    filesToAttachments(form.attachments),
  ]);
  return {
    kind: "document_signature",
    documents,
    attachments,
    ...omitBlank({ description: form.description }),
  };
}

export function lettersRequestInput(form: LettersFormState): LogisticsRequestInput {
  return {
    kind: "recommendation_letters",
    schools: filledSchools(form.schools).map(schoolToWire),
    facts: filledFacts(form.facts).map(factToWire),
    ...omitBlank({
      cv_overleaf_url: form.cvOverleafUrl,
      drive_folder_url: form.driveFolderUrl,
    }),
  };
}

export function meetingRequestInput(form: MeetingFormState): LogisticsRequestInput {
  return {
    kind: "book_meeting",
    meetings: filledMeetings(form.rows).map(meetingToWire),
  };
}

/**
 * Why this form cannot be submitted yet, or null when it can.
 *
 * The service checks all of this again and is what actually refuses -- but a member who has just
 * filled in a table deserves to be told which row is wrong before the upload, not after it.
 */
export function describeSubmitBlock(
  kind: LogisticsRequestKind,
  form: SignatureFormState | LettersFormState | MeetingFormState,
): {
  reason: "empty" | "no-name" | "no-purpose" | "file-too-big" | "request-too-big";
  file?: string;
} | null {
  if (kind === "document_signature") {
    const signature = form as SignatureFormState;
    if (!signature.files.length) {
      return { reason: "empty" };
    }
    const all = [...signature.files, ...signature.attachments];
    const oversized = oversizedFile(all);
    if (oversized) {
      return { reason: "file-too-big", file: oversized.name };
    }
    if (totalFileBytes(all) > MAX_REQUEST_BYTES) {
      return { reason: "request-too-big" };
    }
    return null;
  }
  if (kind === "recommendation_letters") {
    const letters = form as LettersFormState;
    const schools = filledSchools(letters.schools);
    if (!schools.length) {
      return { reason: "empty" };
    }
    return schools.some((row) => !row.school.trim()) ? { reason: "no-name" } : null;
  }
  const meetings = filledMeetings((form as MeetingFormState).rows);
  if (!meetings.length) {
    return { reason: "empty" };
  }
  return meetings.some((row) => !row.purpose.trim()) ? { reason: "no-purpose" } : null;
}

/**
 * A stored attachment back as a File, so a request being corrected keeps the documents it was sent
 * with.
 *
 * Without this, editing a signature request would mean re-picking every file off the member's disk
 * -- and the ones they no longer have to hand would quietly drop off the request. Only possible on
 * a request read in full: the list carries no bytes.
 */
export function attachmentToFile(attachment: LogisticsAttachment): File {
  const binary = atob(attachment.data_base64 ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  // An empty type is what `new File` defaults to anyway, so a missing content type needs no
  // special case here.
  return new File([bytes], attachment.name, { type: attachment.content_type ?? "" });
}

export function schoolFromWire(school: LogisticsSchool): RecommendationSchool {
  return createSchoolRow({
    school: school.school,
    applicationDeadline: school.application_deadline ?? "",
    applicationDeadlineTime: school.application_deadline_time ?? "",
    letterDeadline: school.letter_deadline ?? "",
    letterDeadlineTime: school.letter_deadline_time ?? "",
    deadlineTimezone: school.deadline_timezone ?? "",
    applicationStatus: school.application_status ?? "",
    letterStatus: school.letter_status ?? "",
    program: school.program ?? "",
    programLink: school.program_link ?? "",
    notes: school.notes ?? "",
  });
}

export function factFromWire(fact: LogisticsFact): LetterFact {
  return createFactRow({ project: fact.project, contribution: fact.contribution });
}

export function meetingFromWire(meeting: LogisticsMeeting): MeetingRequestRow {
  return createMeetingRow({
    purpose: meeting.purpose,
    preferredTime: meeting.preferred_time ?? "",
    timezone: meeting.timezone ?? "",
    lengthMinutes: meeting.length_minutes ? String(meeting.length_minutes) : "",
    // The stamp is when they asked, and correcting a request is not asking again.
    ...(meeting.submitted_at ? { submittedAt: Date.parse(meeting.submitted_at) } : {}),
  });
}

/**
 * A submitted request back in the shape its form holds it in.
 *
 * Rows get fresh view-side ids on the way in, exactly as a restored draft does: the ids only have
 * to be unique among the rows on screen, and reusing ones from another render would point lit's
 * keyed repeat at the wrong inputs.
 */
export function requestToFormState(request: LogisticsRequest): {
  signature?: SignatureFormState;
  letters?: LettersFormState;
  meeting?: MeetingFormState;
} {
  if (request.kind === "document_signature") {
    // Only files this client actually holds can go back into a picker. A request whose bytes the
    // service has dropped is settled, and a settled request cannot be corrected anyway.
    return {
      signature: {
        files: (request.documents ?? []).filter((file) => file.data_base64).map(attachmentToFile),
        description: request.description ?? "",
        attachments: (request.attachments ?? [])
          .filter((file) => file.data_base64)
          .map(attachmentToFile),
      },
    };
  }
  if (request.kind === "recommendation_letters") {
    const facts = (request.facts ?? []).map(factFromWire);
    return {
      letters: {
        schools: (request.schools ?? []).map(schoolFromWire),
        // A blank row to type in rather than an empty table, same as a restored draft gets.
        facts: facts.length ? facts : [createFactRow()],
        cvOverleafUrl: request.cv_overleaf_url ?? "",
        driveFolderUrl: request.drive_folder_url ?? "",
      },
    };
  }
  return { meeting: { rows: (request.meetings ?? []).map(meetingFromWire) } };
}

/**
 * Whether nobody is waiting on this request any more.
 *
 * The same three statuses the service treats as settled -- it is what decides that the stored files
 * are dropped, so a client that disagreed would offer a download for bytes that are gone.
 */
export function isSettledRequest(request: Pick<LogisticsRequest, "status">): boolean {
  return (
    request.status === "completed" ||
    request.status === "declined" ||
    request.status === "withdrawn"
  );
}
