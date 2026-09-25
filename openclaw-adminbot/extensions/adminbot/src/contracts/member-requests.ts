/**
 * A member's request to add somebody to the roster, held until an admin decides it.
 *
 * Adding a member is an admin write: the record's Member Type sets its access level, and saving it
 * moves rooms, meetings and the sheet. A member who is not an admin can still know who has just
 * joined before any admin does, so they get to propose the record, and the proposal waits here.
 *
 * Its own table rather than a roster row with a "pending" status: every sweep that reads the
 * roster -- onboarding, nudges, the calendar backfill, the sheet sync -- would have to learn to
 * skip that status, and one that did not would mail or invite somebody nobody has approved.
 */

export const adminBotMemberRequestStatuses = ["pending", "approved", "rejected"] as const;

export type AdminBotMemberRequestStatus = (typeof adminBotMemberRequestStatuses)[number];

/**
 * The fields a request may carry. Deliberately short: enough for an admin to recognise the person
 * and decide, and nothing that is governance. Privilege, access, status and contact consent are
 * absent by construction -- Member Type decides the access level when the admin approves, exactly
 * as it does on the admin's own Add member form.
 */
export const adminBotMemberRequestFields = [
  "name",
  "email",
  "member_type",
  "affiliation",
  "research_topics",
  "personal_website",
] as const;

export type AdminBotMemberRequestField = (typeof adminBotMemberRequestFields)[number];

export type AdminBotMemberRequestProfile = Partial<Record<AdminBotMemberRequestField, string>> & {
  name: string;
  email: string;
};

export type AdminBotMemberRequest = {
  id: string;
  status: AdminBotMemberRequestStatus;
  requested_by: string;
  profile: AdminBotMemberRequestProfile;
  /** Standing-meeting ids the requester ticked; applied on approval like the admin form's boxes. */
  meetings?: string[];
  /** Why this person should be added, for the admin reading the request. */
  note?: string;
  created_at: string;
  updated_at: string;
  decided_at?: string;
  decided_by?: string;
  /** Why it was turned down, shown back to the requester. */
  decision_note?: string;
  /** The roster record approval created. */
  member_id?: string;
};

const MAX_FIELD_LENGTH = 500;
const MAX_NOTE_LENGTH = 2000;

/**
 * Reads a request body into a request's fields, or says what is wrong with it.
 *
 * Unknown keys are ignored rather than refused: the Control UI reuses its member form, and a key
 * this list does not name is one the request was never going to store. The roster's own validation
 * runs again on approval, so this checks only what the admin needs to be able to read the request.
 */
export function readAdminBotMemberRequest(
  body: Record<string, unknown>,
):
  | { ok: true; profile: AdminBotMemberRequestProfile; meetings?: string[]; note?: string }
  | { ok: false; error: string } {
  const profile: Partial<Record<AdminBotMemberRequestField, string>> = {};
  for (const field of adminBotMemberRequestFields) {
    const value = body[field];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== "string") {
      return { ok: false, error: `${field} must be text` };
    }
    const trimmed = value.trim();
    if (trimmed.length > MAX_FIELD_LENGTH) {
      return { ok: false, error: `${field} is too long` };
    }
    if (trimmed) {
      profile[field] = trimmed;
    }
  }
  if (!profile.name) {
    return { ok: false, error: "a name is required" };
  }
  // The email is what the new member signs in with and what onboarding mails, so a request without
  // one is a record an admin would have to chase before it could do anything.
  if (!profile.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(profile.email)) {
    return { ok: false, error: "a valid email is required" };
  }
  const meetings = Array.isArray(body.meetings)
    ? body.meetings.filter((value): value is string => typeof value === "string" && value !== "")
    : undefined;
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > MAX_NOTE_LENGTH) {
    return { ok: false, error: "note is too long" };
  }
  return {
    ok: true,
    profile: { ...profile, name: profile.name, email: profile.email },
    ...(meetings && meetings.length > 0 ? { meetings } : {}),
    ...(note ? { note } : {}),
  };
}
