import { describe, expect, it } from "vitest";
import type { AdminBotMeetingRecord } from "../../contracts/actions.js";
import { meetingListRow, meetingListRowWithoutRoster } from "./meeting-list-row.js";

const RECORD: AdminBotMeetingRecord = {
  id: "zoom-1",
  topic: "Group meeting",
  started_at: "2026-09-01T15:00:00.000Z",
  host_email: "host@example.edu",
  recording: { share_url: "https://zoom.example/rec/1", passcode: "pw" },
  transcript: {
    processed_at: "2026-09-01T17:00:00.000Z",
    speaker_names: ["Ada", "Grace"],
    duration_seconds: 3600,
  },
  summary: {
    overview: "Talked.",
    decisions: ["Ship it"],
    action_items: [{ text: "Write it up", owner_member_id: "ada", owner_name: "Ada" }],
    generated_at: "2026-09-01T17:01:00.000Z",
    model: "local",
  },
  attendees: [
    {
      member_id: "ada",
      display_name: "Ada",
      email: "ada@zoom.example",
      joined_at: "2026-09-01T15:01:00.000Z",
      minutes: 58,
      source: "participant_report",
      present: true,
    },
    {
      display_name: "Guest",
      email: "guest@example.com",
      source: "participant_report",
      present: true,
    },
  ],
  source: "zoom_email",
  created_at: "2026-09-01T15:30:00.000Z",
  updated_at: "2026-09-01T17:01:00.000Z",
};

describe("meetingListRow", () => {
  it("keeps what the Meetings tab draws and drops import bookkeeping", () => {
    expect(meetingListRow(RECORD)).toEqual({
      id: "zoom-1",
      topic: "Group meeting",
      started_at: "2026-09-01T15:00:00.000Z",
      recording: { share_url: "https://zoom.example/rec/1", passcode: "pw" },
      transcript: { processed_at: "2026-09-01T17:00:00.000Z", duration_seconds: 3600 },
      summary: {
        overview: "Talked.",
        decisions: ["Ship it"],
        action_items: [{ text: "Write it up", owner_name: "Ada" }],
        generated_at: "2026-09-01T17:01:00.000Z",
        model: "local",
      },
      attendees: [
        {
          member_id: "ada",
          display_name: "Ada",
          minutes: 58,
          source: "participant_report",
          present: true,
        },
        { display_name: "Guest", source: "participant_report", present: true },
      ],
      source: "zoom_email",
    });
  });

  it("passes a member's redacted view through with its headcount", () => {
    const row = meetingListRow({
      ...RECORD,
      attendees: [],
      attendee_count: 7,
      transcript: undefined,
    });
    expect(row.attendee_count).toBe(7);
    expect(row.attendees).toEqual([]);
    expect(row).not.toHaveProperty("transcript");
  });
});

describe("meetingListRowWithoutRoster", () => {
  it("drops the roster for a headcount of who was present", () => {
    const row = meetingListRowWithoutRoster({
      ...RECORD,
      attendees: [
        ...(RECORD.attendees ?? []),
        { member_id: "bo", display_name: "Bo", source: "manual", present: false },
      ],
    });
    expect(row.attendees).toBeUndefined();
    expect(row.attendee_count).toBe(2);
    expect(row.transcript).toEqual({
      processed_at: "2026-09-01T17:00:00.000Z",
      duration_seconds: 3600,
    });
  });

  it("counts nobody on a meeting with no roster yet", () => {
    const { attendees: _attendees, ...bare } = RECORD;
    expect(meetingListRowWithoutRoster(bare).attendee_count).toBe(0);
  });
});
