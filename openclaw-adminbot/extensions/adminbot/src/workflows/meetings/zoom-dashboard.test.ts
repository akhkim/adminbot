import { describe, expect, it } from "vitest";
import type { AdminBotLabMember, AdminBotMeetingRecord } from "../../contracts/actions.js";
import {
  aliasCandidates,
  attendanceFromDashboard,
  dashboardMeetingRecordId,
  dashboardMeetingUpdate,
  dashboardTimeToRfc3339,
  matchRecordedMeeting,
  parseZoomDashboardCsv,
  uniqueParticipantCount,
  type ZoomDashboardMeeting,
} from "./zoom-dashboard.js";

function member(
  overrides: Partial<AdminBotLabMember> & { id: string; name: string },
): AdminBotLabMember {
  return {
    privilege_level: "member",
    access: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const ROSTER = [
  member({ id: "m-andrew", name: "Andrew Kim", email: "andrew@example.edu" }),
  member({ id: "m-priya", name: "Priya Raman", email: "priya@example.edu" }),
  member({ id: "m-ana", name: "Ana Ruiz-Gómez", email: "ana@example.edu" }),
];

const HEADER =
  "﻿Topic,Type,ID,Host name,Host email,Start time,End time,Participants,Duration (minutes)," +
  "Total participant minutes,Department,Group,Source,Unique viewers,Max concurrent views," +
  "Creation time,Personal Meeting ID,Name (original name),Email,Join time,Leave time," +
  "Duration (minutes),Guest,Recording disclaimer response,In waiting room";

function row(start: string, minutes: number, name: string, email = "", personMinutes = 30) {
  return [
    "Weekly Lab Meeting",
    "Meeting",
    "812 3456 7890",
    "Host",
    "host@example.edu",
    `"${start}"`,
    `"${start}"`,
    "9",
    String(minutes),
    "100",
    "",
    "Group",
    "Zoom",
    "-",
    "-",
    '"10/06/2025 01:16:21 AM"',
    "",
    `"${name}"`,
    email,
    `"${start}"`,
    `"${start}"`,
    String(personMinutes),
    "Yes",
    "OK",
    "No",
  ].join(",");
}

const CSV = [
  HEADER,
  row("08/24/2026 09:25:32 AM", 104, "Andrew K", "", 90),
  row("08/24/2026 09:25:32 AM", 104, "Priya Raman", "", 40),
  row("08/24/2026 09:25:32 AM", 104, "Priya Raman", "", 50),
  row("08/24/2026 09:25:32 AM", 104, "ana ruiz gomez", "ana@example.edu"),
  row("08/24/2026 09:25:32 AM", 104, "Sam's Notetaker (Otter.ai)"),
  row("08/24/2026 09:25:32 AM", 104, "Room W1160"),
  row("08/24/2026 09:03:00 AM", 1, "Andrew K", "", 1),
  "",
].join("\n");

function meeting(overrides: Partial<ZoomDashboardMeeting> = {}): ZoomDashboardMeeting {
  return {
    zoomMeetingId: "81234567890",
    topic: "Weekly Lab Meeting",
    startedAt: "2026-09-21T12:59:07.000Z",
    durationMinutes: 107,
    participants: [],
    ...overrides,
  };
}

function record(id: string, startedAt: string, seconds: number, topic = "Weekly Lab Meeting") {
  return {
    id,
    topic,
    started_at: startedAt,
    duration_seconds: seconds,
    recording: { share_url: `https://zoom.example/rec/share/${id}` },
    source: "zoom_email",
    created_at: startedAt,
    updated_at: startedAt,
  } as AdminBotMeetingRecord;
}

describe("dashboardTimeToRfc3339", () => {
  it("reads the export's local time in the account's zone, across daylight saving", () => {
    expect(dashboardTimeToRfc3339("08/24/2026 09:25:32 AM", "America/Toronto")).toBe(
      "2026-08-24T13:25:32.000Z",
    );
    expect(dashboardTimeToRfc3339("11/02/2026 09:30:00 AM", "America/Toronto")).toBe(
      "2026-11-02T14:30:00.000Z",
    );
    expect(dashboardTimeToRfc3339("08/03/2026 09:03:14 PM", "America/Toronto")).toBe(
      "2026-08-04T01:03:14.000Z",
    );
    expect(dashboardTimeToRfc3339("08/24/2026 12:05:00 AM", "America/Toronto")).toBe(
      "2026-08-24T04:05:00.000Z",
    );
    expect(dashboardTimeToRfc3339("Aug 24, 2026 9:25 AM", "America/Toronto")).toBeUndefined();
  });
});

describe("parseZoomDashboardCsv", () => {
  it("splits the export into meetings by id and start time, reading the person's duration", () => {
    const meetings = parseZoomDashboardCsv(CSV, "America/Toronto");
    expect(meetings.map((m) => [m.startedAt, m.durationMinutes, m.participants.length])).toEqual([
      ["2026-08-24T13:03:00.000Z", 1, 1],
      ["2026-08-24T13:25:32.000Z", 104, 6],
    ]);
    const [, weekly] = meetings;
    expect(weekly?.zoomMeetingId).toBe("81234567890");
    // The participant's own duration, not the meeting's, which shares the column name.
    expect(weekly?.participants[0]).toEqual({
      name: "Andrew K",
      joinedAt: "2026-08-24T13:25:32.000Z",
      minutes: 90,
    });
    expect(weekly?.participants[3]?.email).toBe("ana@example.edu");
  });

  it("returns nothing for a file that is not this export", () => {
    expect(parseZoomDashboardCsv("Name (Original Name),Duration (Minutes)\nA,3\n", "UTC")).toEqual(
      [],
    );
  });

  it("counts people once however often they rejoined", () => {
    const [, weekly] = parseZoomDashboardCsv(CSV, "America/Toronto");
    expect(uniqueParticipantCount(weekly)).toBe(5);
    expect(dashboardMeetingRecordId(weekly)).toBe("zoom-81234567890-2026-08-24");
  });
});

describe("matchRecordedMeeting", () => {
  // Filed when the notice mail arrived: a 10-second test clip and the 107-minute meeting.
  const clip = record("zoom-clip", "2026-09-21T12:35:00.000Z", 10);
  const recording = record("zoom-meeting", "2026-09-21T17:21:00.000Z", 6412);

  it("picks the recording whose length is the meeting's", () => {
    expect(matchRecordedMeeting(meeting(), [clip, recording])?.id).toBe("zoom-meeting");
  });

  it("prefers the closer length when two recordings could fit", () => {
    const shorter = record("zoom-shorter", "2026-09-21T14:10:00.000Z", 6000);
    expect(matchRecordedMeeting(meeting(), [shorter, recording])?.id).toBe("zoom-meeting");
  });

  it("finds nothing for another series, another week, or a record already claimed", () => {
    expect(
      matchRecordedMeeting(meeting(), [record("x", recording.started_at, 6412, "Reading Group")]),
    ).toBeUndefined();
    expect(
      matchRecordedMeeting(meeting(), [record("x", "2026-09-28T17:21:00.000Z", 6412)]),
    ).toBeUndefined();
    expect(matchRecordedMeeting(meeting(), [recording], new Set(["zoom-meeting"]))).toBeUndefined();
  });

  it("finds a record of unknown length only by its id, never by guessing", () => {
    const unknown = { ...recording, duration_seconds: undefined };
    expect(matchRecordedMeeting(meeting(), [unknown])).toBeUndefined();
  });
});

describe("attendanceFromDashboard", () => {
  const [, weekly] = parseZoomDashboardCsv(CSV, "America/Toronto");

  it("drops notetakers, merges rejoins and keeps the unmatched as guests", () => {
    const { attendees, dropped } = attendanceFromDashboard(weekly, ROSTER);
    expect(dropped).toEqual(["Sam's Notetaker (Otter.ai)"]);
    expect(attendees.find((a) => a.member_id === "m-priya")?.minutes).toBe(90);
    expect(attendees.find((a) => a.member_id === "m-ana")?.source).toBe("participant_report");
    expect(attendees.filter((a) => !a.member_id).map((a) => a.display_name)).toEqual([
      "Andrew K",
      "Room W1160",
    ]);
  });

  it("resolves an aliased name to its member, and drops a name aliased to null", () => {
    const aliases = new Map<string, string | null>([
      ["andrew k", "m-andrew"],
      ["room w1160", null],
    ]);
    const { attendees, dropped } = attendanceFromDashboard(weekly, ROSTER, aliases);
    expect(attendees.every((a) => a.member_id)).toBe(true);
    expect(attendees.find((a) => a.member_id === "m-andrew")).toMatchObject({
      display_name: "Andrew K",
      present: true,
    });
    expect(dropped).toContain("Room W1160");
  });

  it("refuses an alias that names nobody", () => {
    expect(() =>
      attendanceFromDashboard(weekly, ROSTER, new Map([["andrew k", "m-nobody"]])),
    ).toThrow(/m-nobody/u);
  });
});

describe("dashboardMeetingUpdate", () => {
  it("files a meeting no notice described as a participant report, with no link", () => {
    expect(dashboardMeetingUpdate(meeting(), [])).toEqual({
      id: "zoom-81234567890-2026-09-21",
      topic: "Weekly Lab Meeting",
      started_at: "2026-09-21T12:59:07.000Z",
      duration_minutes: 107,
      recording: {},
      attendees: [],
      source: "participant_report",
    });
  });

  it("lands on a notice's record, keeping its id, topic and source and correcting its time", () => {
    const existing = record("zoom-meeting", "2026-09-21T17:21:00.000Z", 6412, "weekly lab meeting");
    expect(dashboardMeetingUpdate(meeting(), [], existing)).toMatchObject({
      id: "zoom-meeting",
      topic: "weekly lab meeting",
      started_at: "2026-09-21T12:59:07.000Z",
      recording: {},
      source: "zoom_email",
    });
  });
});

describe("aliasCandidates", () => {
  it("suggests members a shortened or prefixed display name could be", () => {
    expect(aliasCandidates("Andrew K", ROSTER).map((m) => m.id)).toEqual(["m-andrew"]);
    expect(aliasCandidates("X. Priya Raman", ROSTER).map((m) => m.id)).toEqual(["m-priya"]);
    expect(aliasCandidates("Room W1160", ROSTER)).toEqual([]);
  });
});
