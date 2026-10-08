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
  /** Not sent: the Meetings checkboxes need only the id, the title and who is on it. */
  kind?: "group" | "theme" | "project";
  /** Not sent, for the same reason. */
  event_ids?: string[];
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
  minutes?: number;
  source: "participant_report" | "transcript" | "manual";
  present: boolean;
};

export type MeetingActionItem = {
  text: string;
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
  /** Whether a transcript was processed and how long it ran; who spoke stays on the server. */
  transcript?: { processed_at: string; duration_seconds?: number };
  summary?: {
    overview: string;
    decisions: string[];
    action_items: MeetingActionItem[];
    generated_at: string;
    model: string;
  };
  /**
   * A member's row: their own line. An admin's list row leaves the roster out -- it is read per
   * meeting with `fetchMeeting` when its attendance is opened -- and the PUT reply and
   * `fetchMeeting` carry the whole of it.
   */
  attendees?: MeetingAttendee[];
  /** Who was present, counted: on a member's row and an admin's list row, not the roster read. */
  attendee_count?: number;
  source: "zoom_email" | "manual";
  notes?: string;
};

/**
 * The rosters an admin has opened this session, by meeting id. An entry with no `attendees` is a
 * read in flight; a meeting with no entry has not been asked for (or its read failed, so the next
 * intent asks again).
 */
export type MeetingRosters = Record<
  string,
  {
    attendees?: MeetingAttendee[];
    loading?: boolean;
    /** Say so if this read fails. */ report?: boolean;
  }
>;

export type MeetingCursor = Pick<MeetingRecord, "started_at" | "id">;

/**
 * How many meetings the tab reads at a time: the first page it paints and every "show more".
 * Small on purpose -- the tab is opened to catch up on the last few meetings, and anything older
 * is one click away. The service pages GET /meetings by the same default when no `limit` is sent.
 */
export const MEETINGS_PAGE_SIZE = 10;

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

/**
 * One meeting with its roster (GET /meetings/:id): what an admin's card reads when its attendance
 * is opened. A plain GET through authedJson, so two cards' worth of intent for the same meeting
 * share one request and a re-read revalidates by ETag.
 */
export async function fetchMeeting(
  meetingId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MeetingRecord>> {
  const result = await authedJson(
    baseUrl,
    `/meetings/${encodeURIComponent(meetingId)}`,
    "GET",
    sessionToken,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as MeetingRecord };
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
  /** The streak's meetings. The preview sends them once, on `meetings`; filled in from there. */
  missed_meeting_ids?: string[];
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
  if (!result.body) {
    return { ok: true, value: result.body as MeetingAttendanceNudgePreview };
  }
  const preview = result.body as Omit<MeetingAttendanceNudgePreview, "absent"> & {
    absent: Array<Omit<MeetingAbsence, "missed_topics"> & { missed_topics?: string[] }>;
  };
  // A row is only ever a member who missed every meeting in the streak, so its missed topics are
  // the streak's own. An older service still sends them per row, and those are kept.
  const streakTopics = (preview.meetings ?? []).map((meeting) => meeting.topic);
  return {
    ok: true,
    value: {
      ...preview,
      absent: (preview.absent ?? []).map((row) => ({
        ...row,
        missed_topics: row.missed_topics ?? streakTopics,
      })),
    },
  };
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
