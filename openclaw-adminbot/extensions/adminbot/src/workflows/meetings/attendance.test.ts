import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import {
  attendanceFromParticipants,
  attendanceFromSpeakers,
  mergeAttendance,
  parseParticipantCsv,
} from "./attendance.js";

function member(overrides: Partial<AdminBotLabMember> & { id: string; name: string }): AdminBotLabMember {
  return {
    privilege_level: "member",
    access: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const ROSTER = [
  member({ id: "m-andrew", name: "Andrew Kim", email: "andrew@cs.toronto.edu" }),
  member({
    id: "m-priya",
    name: "Priya Raman",
    email: "priya@cs.toronto.edu",
    calendar_email: "priya.raman@gmail.com",
  }),
  member({ id: "m-ana", name: "Ana Ruiz-Gómez", email: "ana@cs.toronto.edu" }),
];

// Zoom's export opens with a one-row meeting summary block before the participant section.
const CSV = `Meeting ID,Topic,Start Time,End Time,User Email,Duration (Minutes),Participants
"812 3456 7890","Weekly Lab Meeting","Aug 12, 2026 10:00 AM","Aug 12, 2026 11:00 AM",andrew@cs.toronto.edu,60,3

Name (Original Name),User Email,Join Time,Leave Time,Duration (Minutes),Guest
"Andrew Kim",andrew@cs.toronto.edu,"Aug 12, 2026 10:00 AM","Aug 12, 2026 11:00 AM",60,No
"priya (she/her)",priya.raman@gmail.com,"Aug 12, 2026 10:02 AM","Aug 12, 2026 11:00 AM",58,No
"ana ruiz gomez",,"Aug 12, 2026 10:05 AM","Aug 12, 2026 11:00 AM",55,No
"Guest iPhone",,"Aug 12, 2026 10:30 AM","Aug 12, 2026 10:45 AM",15,Yes
`;

describe("parseParticipantCsv", () => {
  // The summary block above the participant header also has a Topic and a Duration column, so a
  // parser that grabs the first header row files the meeting itself as an attendee.
  it("finds the participant section, not the summary block above it", () => {
    const rows = parseParticipantCsv(CSV);
    expect(rows.map((row) => row.name)).toEqual([
      "Andrew Kim",
      "priya (she/her)",
      "ana ruiz gomez",
      "Guest iPhone",
    ]);
    expect(rows[0]).toEqual({
      name: "Andrew Kim",
      email: "andrew@cs.toronto.edu",
      joinedAt: "Aug 12, 2026 10:00 AM",
      minutes: 60,
    });
  });

  it("survives a BOM, CRLF endings and a quoted comma", () => {
    const rows = parseParticipantCsv(
      '﻿Name,User Email,Duration (Minutes)\r\n"Kim, Andrew",a@b.edu,60\r\n',
    );
    expect(rows).toEqual([{ name: "Kim, Andrew", email: "a@b.edu", minutes: 60 }]);
  });

  it("returns nothing rather than guessing when the file has no participant section", () => {
    expect(parseParticipantCsv("Topic,Duration\nWeekly,60\n")).toEqual([]);
  });
});

describe("attendanceFromParticipants", () => {
  it("resolves members by either address on their record, and by name", () => {
    const attendance = attendanceFromParticipants(parseParticipantCsv(CSV), ROSTER);
    const byName = Object.fromEntries(
      attendance.map((entry) => [entry.display_name, entry.member_id]),
    );
    expect(byName["Andrew Kim"]).toBe("m-andrew");
    // Matched on calendar_email: the display name "priya (she/her)" resolves to nobody.
    expect(byName["priya (she/her)"]).toBe("m-priya");
    // Matched on name with the accent and hyphen normalized away.
    expect(byName["ana ruiz gomez"]).toBe("m-ana");
    // A guest is recorded as present without being invented into the roster.
    expect(byName["Guest iPhone"]).toBeUndefined();
    expect(attendance.every((entry) => entry.present && entry.source === "participant_report")).toBe(
      true,
    );
  });

  // A dropped connection produces a second row for the same person; counted separately it turns a
  // three-person meeting into a five-person one.
  it("merges the rejoin rows one person produces", () => {
    const attendance = attendanceFromParticipants(
      [
        { name: "Andrew Kim", email: "andrew@cs.toronto.edu", joinedAt: "2026-08-12T10:00:00Z", minutes: 20 },
        { name: "Andrew Kim", email: "andrew@cs.toronto.edu", joinedAt: "2026-08-12T10:25:00Z", minutes: 35 },
      ],
      ROSTER,
    );
    expect(attendance).toHaveLength(1);
    expect(attendance[0]?.minutes).toBe(55);
    expect(attendance[0]?.joined_at).toBe("2026-08-12T10:00:00Z");
  });

  // Attributing to whichever member sorted first would be a coin flip recorded as a fact.
  it("leaves an ambiguous name unmatched", () => {
    const twins = [member({ id: "m-1", name: "Alex Chen" }), member({ id: "m-2", name: "Alex Chen" })];
    expect(attendanceFromParticipants([{ name: "Alex Chen" }], twins)[0]?.member_id).toBeUndefined();
  });
});

describe("attendanceFromSpeakers", () => {
  it("marks its rows as inferred from the transcript", () => {
    const attendance = attendanceFromSpeakers(["Andrew Kim", "Someone Else"], ROSTER);
    expect(attendance).toEqual([
      { display_name: "Andrew Kim", member_id: "m-andrew", source: "transcript", present: true },
      { display_name: "Someone Else", source: "transcript", present: true },
    ]);
  });
});

describe("mergeAttendance", () => {
  // The failure this prevents: the hourly pass re-imports a transcript and silently unticks the
  // person an admin marked present, who was there but never unmuted.
  it("keeps a manual correction over anything imported", () => {
    const merged = mergeAttendance(
      [{ member_id: "m-ana", display_name: "Ana Ruiz-Gómez", source: "manual", present: true }],
      [{ member_id: "m-ana", display_name: "Ana", source: "transcript", present: false }],
    );
    expect(merged).toEqual([
      { member_id: "m-ana", display_name: "Ana Ruiz-Gómez", source: "manual", present: true },
    ]);
  });

  it("lets a participant report overwrite a transcript guess", () => {
    const merged = mergeAttendance(
      [{ member_id: "m-andrew", display_name: "Andrew Kim", source: "transcript", present: true }],
      [
        {
          member_id: "m-andrew",
          display_name: "Andrew Kim",
          source: "participant_report",
          present: true,
          minutes: 60,
        },
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe("participant_report");
    expect(merged[0]?.minutes).toBe(60);
  });

  it("adds people the earlier source never saw", () => {
    const merged = mergeAttendance(
      [{ member_id: "m-andrew", display_name: "Andrew Kim", source: "transcript", present: true }],
      [{ member_id: "m-priya", display_name: "Priya Raman", source: "participant_report", present: true }],
    );
    expect(merged.map((entry) => entry.member_id)).toEqual(["m-andrew", "m-priya"]);
  });
});
