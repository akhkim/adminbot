import type { AdminBotMeetingAttendee, AdminBotMeetingRecord } from "../../contracts/actions.js";

/** An attendance line as the Meetings tab reads it: who, how long, from where, and whether present. */
export type AdminBotMeetingListAttendee = Omit<AdminBotMeetingAttendee, "email" | "joined_at">;

/**
 * A meeting as GET /meetings sends it.
 *
 * The admin roster grows with the lab, and each line carried the Zoom account address and join
 * time that only the import uses to match people -- the tab ticks a member by id and names a guest
 * by display name. The transcript's speaker list names colleagues by what they said, and the tab
 * only asks whether a transcript was processed and how long it ran. Bookkeeping stamps
 * (`created_at`, `updated_at`, `host_email`, an action item's owner id) are not drawn either. The
 * stored record keeps all of it.
 */
export type AdminBotMeetingListRow = Omit<
  AdminBotMeetingRecord,
  "attendees" | "transcript" | "summary" | "created_at" | "updated_at" | "host_email"
> & {
  attendees?: AdminBotMeetingListAttendee[];
  transcript?: { processed_at: string; duration_seconds?: number };
  summary?: Omit<NonNullable<AdminBotMeetingRecord["summary"]>, "action_items"> & {
    action_items: { text: string; owner_name?: string }[];
  };
};

export function meetingListRow(meeting: AdminBotMeetingRecord): AdminBotMeetingListRow {
  const {
    attendees,
    transcript,
    summary,
    created_at: _created,
    updated_at: _updated,
    host_email: _host,
    ...rest
  } = meeting;
  return {
    ...rest,
    ...(attendees
      ? {
          attendees: attendees.map(({ email: _email, joined_at: _joined, ...line }) => line),
        }
      : {}),
    ...(transcript
      ? {
          transcript: {
            processed_at: transcript.processed_at,
            ...(typeof transcript.duration_seconds === "number"
              ? { duration_seconds: transcript.duration_seconds }
              : {}),
          },
        }
      : {}),
    ...(summary
      ? {
          summary: {
            ...summary,
            action_items: (summary.action_items ?? []).map(
              ({ owner_member_id: _owner, ...item }) => item,
            ),
          },
        }
      : {}),
  };
}
