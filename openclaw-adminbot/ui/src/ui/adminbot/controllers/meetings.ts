// The Meeting Recordings tab's side of the wire.
//
// Three calls: read the list, correct a roster, file a meeting nobody's notice arrived for. Reads
// are the common case by a wide margin -- the pipeline fills this tab on its own, and the writes
// exist for the days it does not.
//
// What a member is allowed to see is decided by the service, not here: the same GET returns the
// full roster to an admin and one line plus a headcount to everyone else. This controller renders
// whatever came back, which is why a bug in this file cannot leak an attendance list.
import {
  createMeeting,
  fetchMeetings,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  saveMeetingAttendance,
  type MeetingAttendee,
  type MeetingRecord,
} from "../auth/session.ts";
import type { AdminBotHost } from "./admin.ts";

const SIGN_IN_FIRST = "Sign in to see the lab's meeting recordings.";

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

export async function loadAdminBotMeetings(host: AdminBotHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotMeetingsError = SIGN_IN_FIRST;
    return;
  }
  host.adminBotMeetingsLoading = true;
  host.adminBotMeetingsError = null;
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  try {
    const result = await fetchMeetings(stored.sessionToken, baseUrl);
    if (!result.ok) {
      host.adminBotMeetingsError = failureText(result, "Could not load meetings.", baseUrl);
      return;
    }
    host.adminBotMeetings = result.value;
  } finally {
    host.adminBotMeetingsLoading = false;
  }
}

/**
 * Tick or untick one person on one meeting.
 *
 * The whole corrected line is sent rather than a delta, and the list is replaced from the server's
 * reply rather than patched locally: the service re-stamps every line as `manual` on the way in,
 * and a locally patched row would show the wrong source until the next reload.
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
    if (!result.ok) {
      host.adminBotMeetingsError = failureText(result, "Could not save attendance.", baseUrl);
      return;
    }
    host.adminBotMeetings = replaceMeeting(host.adminBotMeetings ?? [], result.value);
  } finally {
    host.adminBotMeetingsSaving = false;
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
    if (!result.ok) {
      host.adminBotMeetingsError = failureText(result, "Could not file the meeting.", baseUrl);
      return false;
    }
    host.adminBotMeetings = [result.value, ...(host.adminBotMeetings ?? [])];
    return true;
  } finally {
    host.adminBotMeetingsSaving = false;
  }
}

function replaceMeeting(meetings: MeetingRecord[], updated: MeetingRecord): MeetingRecord[] {
  // A new array, not a mutated one: lit only re-renders a @state() array when the reference changes.
  return meetings.map((meeting) => (meeting.id === updated.id ? updated : meeting));
}
