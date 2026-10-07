// AdminBot client: Meeting records, attendance, and the standing meetings.
//
// Mirrors the service's api/routes/meetings.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import { authedJson, type AuthResult, calendarFailure, mapErrorResponse } from "../auth/session.ts";

// Lab member record returned by the AdminBot service. Extra fields beyond these
// are preserved but not consumed by the UI.
/**
 * One of the lab calendar's standing meetings (Monday, `Theme:`, `Proj:`) and who is on it.
 * Mirrors `AdminBotStandingMeeting` (extensions/adminbot/src/workflows/calendar/standing-meetings.ts).
 */
export type StandingMeeting = {
  id: string;
  title: string;
  kind: "group" | "theme" | "project";
  event_ids: string[];
  /** Lowercased addresses. */
  attendees: string[];
};

/** The Meetings checkboxes' options. Admin session only; a failed read is an error, not []. */
export async function fetchStandingMeetings(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<StandingMeeting[]>> {
  const result = await authedJson(baseUrl, "/lab/meetings", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  const meetings = (result.body as { meetings?: unknown }).meetings;
  return { ok: true, value: Array.isArray(meetings) ? (meetings as StandingMeeting[]) : [] };
}

// ---------------------------------------------------------------------------
// Meeting recordings
//
// One GET for the list and two admin writes. The service decides what a member is allowed to see
// (their own attendance and a headcount, never the roster), so there is nothing to redact here --
// this is only the wire.
// ---------------------------------------------------------------------------

export type MeetingAttendee = {
  member_id?: string;
  display_name: string;
  email?: string;
  joined_at?: string;
  minutes?: number;
  source: "participant_report" | "transcript" | "manual";
  present: boolean;
};

export type MeetingActionItem = {
  text: string;
  owner_member_id?: string;
  owner_name?: string;
};

export type MeetingRecord = {
  id: string;
  topic: string;
  started_at: string;
  duration_minutes?: number;
  /** Recording length to the second, as the Zoom notice stated it. Exact where minutes round. */
  duration_seconds?: number;
  recording: { share_url?: string; passcode?: string; drive_url?: string };
  transcript?: { processed_at: string; speaker_names: string[]; duration_seconds?: number };
  summary?: {
    overview: string;
    decisions: string[];
    action_items: MeetingActionItem[];
    generated_at: string;
    model: string;
  };
  attendees?: MeetingAttendee[];
  /** Present only on the member view; the admin view carries the roster itself. */
  attendee_count?: number;
  source: "zoom_email" | "manual";
  notes?: string;
};

export type MeetingCursor = Pick<MeetingRecord, "started_at" | "id">;

export type MeetingPage = { meetings: MeetingRecord[]; next_cursor?: MeetingCursor };

export async function fetchMeetings(
  sessionToken: string,
  baseUrl: string,
  page?: { limit: number; before?: MeetingCursor },
): Promise<AuthResult<MeetingPage>> {
  const params = new URLSearchParams();
  if (page) {
    params.set("limit", String(page.limit));
    if (page.before) {
      params.set("before_started_at", page.before.started_at);
      params.set("before_id", page.before.id);
    }
  }
  const result = await authedJson(
    baseUrl,
    `/meetings${page ? `?${params}` : ""}`,
    "GET",
    sessionToken,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as MeetingPage | null;
  return {
    ok: true,
    value: {
      meetings: body?.meetings ?? [],
      ...(body?.next_cursor ? { next_cursor: body.next_cursor } : {}),
    },
  };
}

export async function saveMeetingAttendance(
  meetingId: string,
  attendees: MeetingAttendee[],
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MeetingRecord>> {
  const result = await authedJson(
    baseUrl,
    `/meetings/${encodeURIComponent(meetingId)}/attendance`,
    "PUT",
    sessionToken,
    { attendees },
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as MeetingRecord };
}

export async function createMeeting(
  meeting: {
    id: string;
    topic: string;
    started_at: string;
    recording: { share_url?: string; passcode?: string; drive_url?: string };
  },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MeetingRecord>> {
  const result = await authedJson(baseUrl, "/meetings", "POST", sessionToken, meeting);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as MeetingRecord };
}

// ---------------------------------------------------------------------------
// Attendance nudges, and the notifications they leave behind
//
// Two audiences, two calls each. An admin previews who has missed the last two group meetings and
// then sends; a member reads what the lab has told them and marks it read. The member's half is
// strictly own-scope -- the service takes the member id from the session, so there is no parameter
// here that could ask for somebody else's.
// ---------------------------------------------------------------------------

export type MeetingAbsence = {
  member_id: string;
  name: string;
  missed_meeting_ids: string[];
  missed_topics: string[];
  reason: "invite" | "full_member";
};

export type MeetingAttendanceNudgePreview = {
  streak: number;
  meeting_label: string;
  meetings: Array<{ id: string; topic: string; started_at: string }>;
  absent: MeetingAbsence[];
  /** False when the calendar could not be read, so the audience is the roster's full members alone. */
  invite_resolved: boolean;
  audience_size: number;
};

export type MeetingAttendanceNudgeResult = {
  notified: string[];
  already_told: string[];
  slack_skipped: Array<{ member_id: string; reason: string }>;
  invite_resolved: boolean;
};

export async function fetchMeetingAttendanceNudges(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MeetingAttendanceNudgePreview>> {
  const result = await authedJson(baseUrl, "/meetings/attendance-nudges", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as MeetingAttendanceNudgePreview };
}

export async function sendMeetingAttendanceNudges(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MeetingAttendanceNudgeResult>> {
  const result = await authedJson(baseUrl, "/meetings/attendance-nudges", "POST", sessionToken, {});
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as MeetingAttendanceNudgeResult };
}
