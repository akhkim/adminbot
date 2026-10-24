// The Meeting Recordings tab's side of the wire.
//
// Five calls: read the index of recurring meetings, read one series' recordings, read one
// meeting's roster, correct a roster, file a meeting nobody's notice arrived for. Reads are the
// common case by a wide margin -- the pipeline fills this tab on its own, and the writes exist for
// the days it does not.
//
// What a member is allowed to see is decided by the service, not here: a member's list row is their
// own line plus a headcount. An admin's list row is the headcount alone, and the roster is read per
// meeting when its attendance is about to open, then kept for the session. This controller renders
// whatever came back, which is why a bug in this file cannot leak an attendance list.
import {
  createMeeting,
  fetchMeeting,
  fetchMeetingAttendanceNudges,
  fetchMeetings,
  fetchMeetingSeries,
  MEETINGS_PAGE_SIZE,
  saveMeetingAttendance,
  sendMeetingAttendanceNudges,
  type MeetingAttendee,
  type MeetingRecord,
  type MeetingRosters,
  type MeetingSeriesPages,
} from "../api/meetings.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import type { AdminBotHost } from "./admin.ts";

const SIGN_IN_FIRST = "Sign in to see the lab's meeting recordings.";

function sameSession(token: string): boolean {
  return loadStoredMemberSession()?.sessionToken === token;
}

function failureText(
  result: { kind: string; message?: string },
  fallback: string,
  baseUrl?: string,
): string {
  if (result.kind === "unreachable") {
    return baseUrl
      ? `Could not reach the AdminBot service at ${baseUrl}. Check that it is running.`
      : "Could not reach the AdminBot service. Check that it is running.";
  }
  if (result.kind === "forbidden") {
    return "Your session no longer has access — sign in again and retry.";
  }
  return result.message ?? fallback;
}

/**
 * Read the tab's index of recurring meetings, then the newest series' recordings.
 *
 * The newest series is read straight away because the tab is a catch-up surface: its dropdown
 * opens on arrival, and somebody who missed this week's meeting should see it without a click.
 * Every other series waits until its dropdown is opened.
 */
export async function loadAdminBotMeetings(host: AdminBotHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotMeetingsError = SIGN_IN_FIRST;
    return;
  }
  const version = (host.adminBotMeetingsRequestVersion ?? 0) + 1;
  host.adminBotMeetingsRequestVersion = version;
  host.adminBotMeetingsLoading = true;
  host.adminBotMeetingsError = null;
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  let newest: string | undefined;
  try {
    const result = await fetchMeetingSeries(stored.sessionToken, baseUrl);
    if (!sameSession(stored.sessionToken) || host.adminBotMeetingsRequestVersion !== version) {
      return;
    }
    if (!result.ok) {
      host.adminBotMeetingsError = failureText(result, "Could not load meetings.", baseUrl);
      return;
    }
    host.adminBotMeetingSeries = result.value;
    // A fresh index is a fresh look: series lists and rosters held from before it are dropped, so
    // an opened dropdown is as current as the counts above it. Reading again is a revalidation.
    host.adminBotMeetingSeriesPages = {};
    host.adminBotMeetingRosters = {};
    newest = result.value[0]?.key;
  } finally {
    if (sameSession(stored.sessionToken) && host.adminBotMeetingsRequestVersion === version) {
      host.adminBotMeetingsLoading = false;
    }
  }
  if (newest !== undefined) {
    await loadAdminBotMeetingSeriesPage(host, newest);
  }
}

function setSeriesPage(
  host: AdminBotHost,
  key: string,
  page: MeetingSeriesPages[string] | undefined,
): void {
  // A new object, not a mutated one: lit only re-renders a @state() value when the reference changes.
  const { [key]: _previous, ...rest } = host.adminBotMeetingSeriesPages ?? {};
  host.adminBotMeetingSeriesPages = page ? { ...rest, [key]: page } : rest;
  host.requestUpdate?.();
}

/**
 * Read one series' recordings: its first page when its dropdown opens, the next with `more`.
 *
 * A first read happens once per series per index; opening and closing a dropdown does not re-read
 * it. A failed first read is retried on the next open. The held entry doubles as the in-flight
 * marker, so a reply is kept only while that exact entry is still the one held -- a sign-out, a
 * fresh index, or a newer read for the same series all replace it.
 */
export async function loadAdminBotMeetingSeriesPage(
  host: AdminBotHost,
  key: string,
  options: { more?: boolean } = {},
): Promise<void> {
  const held = host.adminBotMeetingSeriesPages?.[key];
  if (held?.loading) {
    return;
  }
  if (options.more ? !held?.next_cursor : held && !held.error) {
    return;
  }
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotMeetingsError = SIGN_IN_FIRST;
    return;
  }
  const before = options.more ? (held?.next_cursor ?? undefined) : undefined;
  const pending: MeetingSeriesPages[string] = {
    meetings: options.more ? (held?.meetings ?? []) : [],
    next_cursor: options.more ? (held?.next_cursor ?? null) : null,
    loading: true,
    error: null,
  };
  setSeriesPage(host, key, pending);
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  const result = await fetchMeetings(stored.sessionToken, baseUrl, {
    limit: MEETINGS_PAGE_SIZE,
    series: key,
    ...(before ? { before } : {}),
  });
  if (!sameSession(stored.sessionToken) || host.adminBotMeetingSeriesPages?.[key] !== pending) {
    return;
  }
  if (!result.ok) {
    setSeriesPage(host, key, {
      ...pending,
      loading: false,
      error: failureText(result, "Could not load these recordings.", baseUrl),
    });
    return;
  }
  const seen = new Set(pending.meetings.map((meeting) => meeting.id));
  setSeriesPage(host, key, {
    meetings: [
      ...pending.meetings,
      ...result.value.meetings.filter((meeting) => !seen.has(meeting.id)),
    ],
    next_cursor: result.value.next_cursor ?? null,
    loading: false,
    error: null,
  });
}

function setRoster(
  host: AdminBotHost,
  meetingId: string,
  entry: MeetingRosters[string] | undefined,
): void {
  // A new object, not a mutated one, for the same reason replaceMeeting builds a new array.
  const { [meetingId]: _previous, ...rest } = host.adminBotMeetingRosters ?? {};
  host.adminBotMeetingRosters = entry ? { ...rest, [meetingId]: entry } : rest;
  host.requestUpdate?.();
}

/**
 * Read one meeting's roster for the admin attendance editor, once per meeting per session.
 *
 * Called on intent -- the pointer reaching the attendance summary, focus landing on it -- as well
 * as on open, so the roster is usually here before the <details> unfolds and its first paint is
 * the ticked roster rather than an empty one. A read already held or in flight is not repeated;
 * the request layer would share it anyway, but this keeps a hovered list of fifty cards from
 * queueing fifty promises. `report` is false for the intent reads: a failed prefetch of something
 * nobody opened is not worth a banner; an open, or an open while that read is out, reports.
 */
export async function loadAdminBotMeetingRoster(
  host: AdminBotHost,
  meetingId: string,
  options: { report: boolean },
): Promise<void> {
  const held = host.adminBotMeetingRosters?.[meetingId];
  if (held?.attendees || held?.loading) {
    // The fold opened while its prefetch was still out: if that read fails, it should now say so.
    if (held.loading && options.report) {
      held.report = true;
    }
    return;
  }
  const stored = loadStoredMemberSession();
  if (!stored) {
    return;
  }
  const pending: MeetingRosters[string] = { loading: true, report: options.report };
  setRoster(host, meetingId, pending);
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  const result = await fetchMeeting(meetingId, stored.sessionToken, baseUrl);
  // A sign-out, or a save that replied with the roster first, replaced the pending entry; what is
  // there now is newer than this read.
  if (!sameSession(stored.sessionToken) || host.adminBotMeetingRosters?.[meetingId] !== pending) {
    return;
  }
  if (!result.ok) {
    setRoster(host, meetingId, undefined);
    if (pending.report) {
      host.adminBotMeetingsError = failureText(result, "Could not load attendance.", baseUrl);
    }
    return;
  }
  setRoster(host, meetingId, { attendees: result.value.attendees ?? [] });
}

/**
 * Tick or untick one person on one meeting.
 *
 * The whole corrected line is sent rather than a delta, and the roster is replaced from the
 * server's reply rather than patched locally: the service re-stamps every line as `manual` on the
 * way in, and a locally patched row would show the wrong source until the next reload. The reply
 * is the whole meeting, so the list row is rebuilt from it too -- its headcount moves with the
 * tick -- without reading the list again.
 */
export async function setAdminBotMeetingAttendance(
  host: AdminBotHost,
  meetingId: string,
  attendee: MeetingAttendee,
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotMeetingsError = SIGN_IN_FIRST;
    return;
  }
  host.adminBotMeetingsSaving = true;
  host.adminBotMeetingsError = null;
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  try {
    const result = await saveMeetingAttendance(meetingId, [attendee], stored.sessionToken, baseUrl);
    if (!sameSession(stored.sessionToken)) {
      return;
    }
    if (!result.ok) {
      host.adminBotMeetingsError = failureText(result, "Could not save attendance.", baseUrl);
      return;
    }
    const { attendees, ...row } = result.value;
    host.adminBotMeetingSeriesPages = replaceMeeting(host.adminBotMeetingSeriesPages ?? {}, {
      ...row,
      attendee_count: (attendees ?? []).filter((line) => line.present).length,
    });
    setRoster(host, meetingId, { attendees: attendees ?? [] });
  } finally {
    if (sameSession(stored.sessionToken)) {
      host.adminBotMeetingsSaving = false;
    }
  }
}

export async function fileAdminBotMeeting(
  host: AdminBotHost,
  draft: { topic: string; started_at: string; share_url: string; passcode?: string },
): Promise<boolean> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotMeetingsError = SIGN_IN_FIRST;
    return false;
  }
  host.adminBotMeetingsSaving = true;
  host.adminBotMeetingsError = null;
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  try {
    const result = await createMeeting(
      {
        // Hand-filed records get their own id space. Deriving one from the share URL the way the
        // ingest does would let a manual entry collide with the notice for the same meeting when
        // it turns up later, and the collision would silently overwrite whichever came second.
        id: `manual-${Date.now().toString(36)}`,
        topic: draft.topic,
        started_at: draft.started_at,
        recording: {
          share_url: draft.share_url,
          ...(draft.passcode ? { passcode: draft.passcode } : {}),
        },
      },
      stored.sessionToken,
      baseUrl,
    );
    if (!sameSession(stored.sessionToken)) {
      return false;
    }
    if (!result.ok) {
      host.adminBotMeetingsError = failureText(result, "Could not file the meeting.", baseUrl);
      return false;
    }
  } finally {
    if (sameSession(stored.sessionToken)) {
      host.adminBotMeetingsSaving = false;
    }
  }
  // The new meeting may start a series or join one, and change which series is newest; the index
  // is re-read rather than patched, since the service owns the rule that decides which series it
  // joined.
  await loadAdminBotMeetings(host);
  return true;
}

function replaceMeeting(pages: MeetingSeriesPages, updated: MeetingRecord): MeetingSeriesPages {
  // New objects, not mutated ones: lit only re-renders a @state() value when the reference changes.
  return Object.fromEntries(
    Object.entries(pages).map(([key, page]) => [
      key,
      page.meetings.some((meeting) => meeting.id === updated.id)
        ? {
            ...page,
            meetings: page.meetings.map((meeting) =>
              meeting.id === updated.id ? updated : meeting,
            ),
          }
        : page,
    ]),
  );
}

/**
 * Who has missed the last two meetings, without telling them yet.
 *
 * Always a preview before a send. The message names people and goes out on Slack, so an admin gets
 * to see the list -- and, when the calendar could not be read, to see that the audience fell back
 * to the roster's full members and may be missing somebody who is only on the invite.
 */
export async function loadAdminBotMeetingNudges(host: AdminBotHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotMeetingNudgeError = SIGN_IN_FIRST;
    return;
  }
  host.adminBotMeetingNudgeBusy = true;
  host.adminBotMeetingNudgeError = null;
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  try {
    const result = await fetchMeetingAttendanceNudges(stored.sessionToken, baseUrl);
    if (!sameSession(stored.sessionToken)) {
      return;
    }
    if (!result.ok) {
      host.adminBotMeetingNudgeError = failureText(
        result,
        "Could not work out who has been missing meetings.",
        baseUrl,
      );
      return;
    }
    host.adminBotMeetingNudgePreview = result.value;
  } finally {
    if (sameSession(stored.sessionToken)) {
      host.adminBotMeetingNudgeBusy = false;
    }
  }
}

/**
 * Send them.
 *
 * The preview is re-read afterwards rather than cleared: the service refuses to tell somebody twice
 * about the same pair of meetings, so the list that comes back is what a second press would do --
 * which is nothing, and it should look like nothing.
 */
export async function sendAdminBotMeetingNudges(host: AdminBotHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotMeetingNudgeError = SIGN_IN_FIRST;
    return;
  }
  host.adminBotMeetingNudgeBusy = true;
  host.adminBotMeetingNudgeError = null;
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  try {
    const result = await sendMeetingAttendanceNudges(stored.sessionToken, baseUrl);
    if (!sameSession(stored.sessionToken)) {
      return;
    }
    if (!result.ok) {
      host.adminBotMeetingNudgeError = failureText(
        result,
        "Could not send the reminders.",
        baseUrl,
      );
      return;
    }
    host.adminBotMeetingNudgeResult = result.value;
  } finally {
    if (sameSession(stored.sessionToken)) {
      host.adminBotMeetingNudgeBusy = false;
    }
  }
  if (!sameSession(stored.sessionToken)) {
    return;
  }
  await loadAdminBotMeetingNudges(host);
}
