import { normalizeCalendarTimezone, toAbsoluteRfc3339 } from "../workflows/calendar/time.js";

export const deadlineProposalEntryTypes = [
  "main_conference",
  "demo_track",
  "workshop",
  "arr_direct_submission",
  "arr_commitment",
  "rebuttal",
  "other",
] as const;

export type DeadlineProposalEntryType = (typeof deadlineProposalEntryTypes)[number];

export type DeadlineProposalInput = {
  name: string;
  parentConference: string;
  parentYear: string;
  entryType: DeadlineProposalEntryType;
  deadlineDate: string;
  deadlineTime: string;
  timezone: string;
  homepageUrl: string;
  cfpUrl: string;
  openReviewUrl: string;
  note: string;
};

export type DeadlineSubmitterContact = { name?: string; email?: string };

export function validateDeadlineSubmitterContact(
  input: unknown,
): { ok: true; value: DeadlineSubmitterContact } | { ok: false; error: string } {
  if (input === undefined) {
    return { ok: true, value: {} };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Invalid submitter details." };
  }
  const contact = input as Record<string, unknown>;
  if (
    (contact.name !== undefined && typeof contact.name !== "string") ||
    (contact.email !== undefined && typeof contact.email !== "string")
  ) {
    return { ok: false, error: "Name and email must be text." };
  }
  const name = (contact.name as string | undefined)?.trim() ?? "";
  const email = (contact.email as string | undefined)?.trim() ?? "";
  if (name.length > 200) {
    return { ok: false, error: "Use at most 200 characters for your name." };
  }
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))) {
    return { ok: false, error: "Enter a valid email address." };
  }
  return { ok: true, value: { ...(name ? { name } : {}), ...(email ? { email } : {}) } };
}

export type DeadlinePublicationPayload = {
  previous_deadline_aoe?: string;
  proposal_id: string;
  deadline_id: string;
  revision: number;
  submitter_member_id: string;
  submitter_contact?: DeadlineSubmitterContact;
  duplicate_deadline_ids: string[];
  deadline: DeadlineProposalInput;
};

export type DeadlineProposalRevision = {
  revision: number;
  action_id: string;
  payload_hash: string;
  status: "pending" | "approved" | "executed" | "rejected";
  deadline: DeadlineProposalInput;
  created_at: string;
  created_by_member_id: string;
};

export type DeadlineProposalView = {
  previous_deadline_aoe?: string;
  id: string;
  deadline_id: string;
  submitter_member_id: string;
  submitter_name: string;
  submitter_email?: string;
  status: "pending" | "approved" | "published" | "rejected";
  current_revision: number;
  action_id: string;
  payload_hash: string;
  duplicate_deadline_ids: string[];
  deadline: DeadlineProposalInput;
  revisions: DeadlineProposalRevision[];
  created_at: string;
  updated_at: string;
  published_at?: string;
};

export type PublishedDeadlineRecord = {
  previous_deadline_aoe?: string;
  action_id: string;
  proposal_id: string;
  deadline_id: string;
  revision: number;
  deadline: DeadlineProposalInput;
  published_at: string;
  published_by_member_id: string;
};

export type DeadlineProposalValidation =
  | { ok: true; value: DeadlineProposalInput; instant: string }
  | { ok: false; errors: Partial<Record<keyof DeadlineProposalInput, string>> };

function clean(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) {
    return false;
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  );
}

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function validWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function validateDeadlineProposalInput(
  input: DeadlineProposalInput,
): DeadlineProposalValidation {
  const value: DeadlineProposalInput = {
    name: clean(input.name),
    parentConference: clean(input.parentConference),
    parentYear: clean(input.parentYear),
    entryType: input.entryType,
    deadlineDate: input.deadlineDate.trim(),
    deadlineTime: input.deadlineTime.trim(),
    timezone: normalizeCalendarTimezone(input.timezone) ?? input.timezone.trim(),
    homepageUrl: input.homepageUrl.trim(),
    cfpUrl: input.cfpUrl.trim(),
    openReviewUrl: input.openReviewUrl.trim(),
    note: input.note.trim(),
  };
  const errors: Partial<Record<keyof DeadlineProposalInput, string>> = {};
  for (const field of Object.keys(value) as Array<keyof DeadlineProposalInput>) {
    const limit = field === "note" ? 2000 : field.endsWith("Url") ? 2048 : 200;
    if (value[field].length > limit) {
      errors[field] = `Use at most ${limit} characters.`;
    }
  }
  if (!value.name) {
    errors.name = "Enter the conference or workshop name.";
  }
  if (value.parentYear && !/^\d{4}$/u.test(value.parentYear)) {
    errors.parentYear = "Use a four-digit year.";
  }
  if (!deadlineProposalEntryTypes.includes(value.entryType)) {
    errors.entryType = "Choose an entry type.";
  }
  if (!validDate(value.deadlineDate)) {
    errors.deadlineDate = "Enter a valid date.";
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value.deadlineTime)) {
    errors.deadlineTime = "Enter a valid 24-hour time.";
  }
  if (!value.timezone || !validTimezone(value.timezone)) {
    errors.timezone = "Choose a valid time zone.";
  }
  if (!validWebUrl(value.homepageUrl)) {
    errors.homepageUrl = "Enter an http or https homepage URL.";
  }
  if (value.cfpUrl && !validWebUrl(value.cfpUrl)) {
    errors.cfpUrl = "Enter an http or https call for papers URL.";
  }
  if (value.openReviewUrl && !validWebUrl(value.openReviewUrl)) {
    errors.openReviewUrl = "Enter an http or https OpenReview URL.";
  }
  const instant =
    Object.keys(errors).length === 0
      ? toAbsoluteRfc3339(`${value.deadlineDate}T${value.deadlineTime}`, value.timezone)
      : undefined;
  if (!instant) {
    errors.deadlineTime = errors.deadlineTime ?? "This local time does not resolve in that zone.";
  }
  if (Object.keys(errors).length || !instant) {
    return { ok: false, errors };
  }
  return { ok: true, value, instant };
}

export function deadlineProposalDuplicateKey(input: DeadlineProposalInput): string | undefined {
  const validated = validateDeadlineProposalInput(input);
  if (!validated.ok) {
    return undefined;
  }
  const source = new URL(validated.value.cfpUrl || validated.value.homepageUrl);
  source.hash = "";
  return [
    clean(validated.value.name).toLocaleLowerCase(),
    validated.value.entryType,
    validated.instant,
    source.toString().replace(/\/$/u, ""),
  ].join("\u0000");
}

export function isDeadlinePublicationPayload(value: unknown): value is DeadlinePublicationPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value as Partial<DeadlinePublicationPayload>;
  return (
    (payload.previous_deadline_aoe === undefined ||
      (typeof payload.previous_deadline_aoe === "string" &&
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(payload.previous_deadline_aoe))) &&
    typeof payload.proposal_id === "string" &&
    typeof payload.deadline_id === "string" &&
    typeof payload.revision === "number" &&
    typeof payload.submitter_member_id === "string" &&
    Array.isArray(payload.duplicate_deadline_ids) &&
    validateDeadlineSubmitterContact(payload.submitter_contact).ok &&
    Boolean(payload.deadline) &&
    validateDeadlineProposalInput(payload.deadline as DeadlineProposalInput).ok
  );
}
