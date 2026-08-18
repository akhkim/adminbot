import { describe, expect, it } from "vitest";
import type { AdminBotMeetingRecord } from "../../contracts/actions.js";
import {
  attendedBy,
  byMostRecent,
  meetingDurationMinutes,
  meetsDurationFloor,
  mergeMeeting,
  redactMeetingForMember,
  validateMeeting,
} from "./records.js";

const NOTICE = {
  id: "zoom-812-2026-08-12",
  topic: "Weekly Lab Meeting",
  started_at: "2026-08-12T14:00:00.000Z",
  recording: { share_url: "https://us02web.zoom.us/rec/share/tok", passcode: "k7$Rm2pQ" },
  source: "zoom_email" as const,
};

describe("validateMeeting", () => {
  it("accepts a notice-shaped record", () => {
    expect(validateMeeting(NOTICE)).toBeUndefined();
  });

  it("refuses a record nobody could open", () => {
    expect(validateMeeting({ ...NOTICE, recording: {} })).toMatch(/share_url/u);
  });

  it("refuses an unparseable start time", () => {
    expect(validateMeeting({ ...NOTICE, started_at: "last tuesday" })).toMatch(/RFC3339/u);
  });

  it("accepts a Drive copy as the only link, since that is what outlives Zoom's retention", () => {
    expect(
      validateMeeting({
        ...NOTICE,
        recording: { drive_url: "https://drive.google.com/file/d/abc" },
      }),
    ).toBeUndefined();
  });
});

describe("mergeMeeting", () => {
  // The failure this exists for: the transcript pass runs hours after the notice and knows nothing
  // about the passcode. Spreading its undefined fields over the record would erase one.
  it("does not blank fields an earlier pass filled in", () => {
    const filed = mergeMeeting(undefined, NOTICE, "2026-08-12T15:00:00.000Z");
    const withTranscript = mergeMeeting(
      filed,
      {
        id: NOTICE.id,
        topic: NOTICE.topic,
        started_at: NOTICE.started_at,
        recording: {},
        source: "zoom_email",
        transcript: {
          processed_at: "2026-08-12T18:00:00.000Z",
          speaker_names: ["Andrew Kim"],
        },
      },
      "2026-08-12T18:00:00.000Z",
    );
    expect(withTranscript.recording).toEqual(NOTICE.recording);
    expect(withTranscript.transcript?.speaker_names).toEqual(["Andrew Kim"]);
    expect(withTranscript.created_at).toBe("2026-08-12T15:00:00.000Z");
    expect(withTranscript.updated_at).toBe("2026-08-12T18:00:00.000Z");
  });

  it("keeps an existing summary when a later pass carries none", () => {
    const summarized = mergeMeeting(
      undefined,
      {
        ...NOTICE,
        summary: {
          overview: "We met.",
          decisions: [],
          action_items: [],
          generated_at: "2026-08-12T18:00:00.000Z",
          model: "local",
        },
      },
      "2026-08-12T18:00:00.000Z",
    );
    const later = mergeMeeting(summarized, NOTICE, "2026-08-13T09:00:00.000Z");
    expect(later.summary?.overview).toBe("We met.");
  });

  it("merges attendance rather than replacing it", () => {
    const filed = mergeMeeting(
      undefined,
      {
        ...NOTICE,
        attendees: [
          { member_id: "ada", display_name: "Ada", source: "manual", present: true },
        ],
      },
      "2026-08-12T15:00:00.000Z",
    );
    const reimported = mergeMeeting(
      filed,
      {
        ...NOTICE,
        attendees: [
          { member_id: "ada", display_name: "Ada", source: "transcript", present: false },
          { member_id: "bo", display_name: "Bo", source: "transcript", present: true },
        ],
      },
      "2026-08-12T18:00:00.000Z",
    );
    expect(reimported.attendees).toEqual([
      { member_id: "ada", display_name: "Ada", source: "manual", present: true },
      { member_id: "bo", display_name: "Bo", source: "transcript", present: true },
    ]);
  });
});

describe("redactMeetingForMember", () => {
  const meeting: AdminBotMeetingRecord = {
    ...NOTICE,
    created_at: "2026-08-12T15:00:00.000Z",
    updated_at: "2026-08-12T15:00:00.000Z",
    attendees: [
      { member_id: "ada", display_name: "Ada", source: "participant_report", present: true },
      { member_id: "bo", display_name: "Bo", source: "participant_report", present: true },
      { display_name: "Guest", source: "participant_report", present: false },
    ],
  };

  it("leaves the viewer with their own line and a headcount", () => {
    const redacted = redactMeetingForMember(meeting, "ada");
    expect(redacted.attendees?.map((entry) => entry.member_id)).toEqual(["ada"]);
    // Two present, the guest having left before the meeting is counted as absent.
    expect(redacted.attendee_count).toBe(2);
  });

  it("names nobody for a member who was not there", () => {
    expect(redactMeetingForMember(meeting, "cleo").attendees).toEqual([]);
  });
});

describe("byMostRecent", () => {
  it("puts the meeting just missed at the top", () => {
    const at = (started: string): AdminBotMeetingRecord => ({
      ...NOTICE,
      id: started,
      started_at: started,
      created_at: started,
      updated_at: started,
    });
    expect(
      [at("2026-08-05T14:00:00.000Z"), at("2026-08-12T14:00:00.000Z")]
        .toSorted(byMostRecent)
        .map((meeting) => meeting.id),
    ).toEqual(["2026-08-12T14:00:00.000Z", "2026-08-05T14:00:00.000Z"]);
  });
});

describe("attendedBy", () => {
  it("ignores a line that records a considered absence", () => {
    const meeting: AdminBotMeetingRecord = {
      ...NOTICE,
      created_at: NOTICE.started_at,
      updated_at: NOTICE.started_at,
      attendees: [{ member_id: "ada", display_name: "Ada", source: "manual", present: false }],
    };
    expect(attendedBy(meeting, "ada")).toBeUndefined();
  });
});

describe("meetingDurationMinutes", () => {
  const base: AdminBotMeetingRecord = {
    ...NOTICE,
    created_at: NOTICE.started_at,
    updated_at: NOTICE.started_at,
  };

  it("prefers a reported duration over the transcript's span", () => {
    expect(
      meetingDurationMinutes({
        ...base,
        duration_minutes: 58,
        transcript: { processed_at: base.started_at, speaker_names: [], duration_seconds: 3000 },
      }),
    ).toBe(58);
  });

  it("falls back to the transcript", () => {
    expect(
      meetingDurationMinutes({
        ...base,
        transcript: { processed_at: base.started_at, speaker_names: [], duration_seconds: 540 },
      }),
    ).toBe(9);
  });

  // Zoom's notice states no duration, so this is the normal state for a fresh record.
  it("is undefined when nothing has reported one", () => {
    expect(meetingDurationMinutes(base)).toBeUndefined();
  });
});

describe("meetsDurationFloor", () => {
  const at = (minutes?: number): AdminBotMeetingRecord => ({
    ...NOTICE,
    created_at: NOTICE.started_at,
    updated_at: NOTICE.started_at,
    ...(minutes === undefined ? {} : { duration_minutes: minutes }),
  });

  it("keeps a meeting at or over the floor and drops the ones under it", () => {
    expect(meetsDurationFloor(at(10), 10)).toBe(true);
    expect(meetsDurationFloor(at(58), 10)).toBe(true);
    expect(meetsDurationFloor(at(4), 10)).toBe(false);
  });

  // Hiding unknown-length meetings would hide every one of them for the hours between the notice
  // arriving and a transcript being dropped -- exactly when someone wants the recording.
  it("keeps a meeting whose length nothing has reported", () => {
    expect(meetsDurationFloor(at(), 10)).toBe(true);
  });

  it("shows everything at a floor of zero", () => {
    expect(meetsDurationFloor(at(1), 0)).toBe(true);
  });
});
