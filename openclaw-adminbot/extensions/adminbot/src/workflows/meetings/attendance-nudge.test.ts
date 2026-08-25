import { describe, expect, it } from "vitest";
import type { AdminBotLabMember, AdminBotMeetingRecord } from "../../contracts/actions.js";
import { adminBotDefaultGroupMeeting } from "../../contracts/group-meeting.js";
import {
  absenceStreakKey,
  buildMeetingAttendanceMessage,
  consecutiveAbsences,
  groupMeetingInviteEmails,
  hasKnownAttendance,
  meetingAudience,
  streakMeetings,
} from "./attendance-nudge.js";

function member(fields: Partial<AdminBotLabMember> & { id: string }): AdminBotLabMember {
  return {
    name: fields.id,
    privilege_level: "member",
    access: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...fields,
  } as AdminBotLabMember;
}

function meeting(
  id: string,
  startedAt: string,
  present: string[],
  extra: Partial<AdminBotMeetingRecord> = {},
): AdminBotMeetingRecord {
  return {
    id,
    topic: `Group meeting ${id}`,
    started_at: startedAt,
    recording: { share_url: `https://zoom.example/${id}` },
    source: "zoom_email",
    created_at: startedAt,
    updated_at: startedAt,
    attendees: present.map((memberId) => ({
      member_id: memberId,
      display_name: memberId,
      source: "participant_report" as const,
      present: true,
    })),
    ...extra,
  };
}

const ada = member({ id: "ada", name: "Ada Lovelace", member_type: "full" });
const mei = member({ id: "mei", name: "Mei Chen", member_type: "full" });
const guest = member({ id: "guest", name: "Guest Prof", member_type: "external-prof" });

describe("hasKnownAttendance", () => {
  it("is false for a meeting whose roster has not been imported yet", () => {
    // The normal state between Zoom's notice landing and a host exporting the CSV. Treating it as
    // "everybody was absent" would warn the whole lab every Monday lunchtime.
    expect(hasKnownAttendance(meeting("m1", "2026-08-17T13:30:00.000Z", []))).toBe(false);
  });

  it("is true once anybody is recorded present", () => {
    expect(hasKnownAttendance(meeting("m1", "2026-08-17T13:30:00.000Z", ["ada"]))).toBe(true);
  });
});

describe("streakMeetings", () => {
  it("takes the most recent meetings that have a roster, skipping the ones that do not", () => {
    const meetings = [
      meeting("m3", "2026-08-24T13:30:00.000Z", []),
      meeting("m2", "2026-08-17T13:30:00.000Z", ["ada"]),
      meeting("m1", "2026-08-10T13:30:00.000Z", ["mei"]),
    ];
    expect(streakMeetings(meetings, 2).map((entry) => entry.id)).toEqual(["m2", "m1"]);
  });
});

describe("meetingAudience", () => {
  it("takes full members, and anybody the calendar invite names", () => {
    const invited = member({ id: "sam", name: "Sam", email: "sam@cs.toronto.edu" });
    const audience = meetingAudience([ada, guest, invited], ["SAM@cs.toronto.edu"]);
    expect(audience.map((entry) => [entry.member.id, entry.reason])).toEqual([
      ["ada", "full_member"],
      ["sam", "invite"],
    ]);
  });

  it("leaves out alumni even when the spreadsheet still calls them full", () => {
    const gone = member({ id: "gone", member_type: "full, alumni" });
    expect(meetingAudience([gone], [])).toEqual([]);
  });
});

describe("consecutiveAbsences", () => {
  const meetings = [
    meeting("m2", "2026-08-17T13:30:00.000Z", ["ada"]),
    meeting("m1", "2026-08-10T13:30:00.000Z", ["ada"]),
  ];

  it("finds the member absent from both", () => {
    const absent = consecutiveAbsences({ meetings, members: [ada, mei] });
    expect(absent.map((row) => row.member_id)).toEqual(["mei"]);
    expect(absent[0]?.missed_meeting_ids).toEqual(["m2", "m1"]);
  });

  it("says nothing at all until two meetings have a roster", () => {
    expect(consecutiveAbsences({ meetings: [meetings[0]!], members: [ada, mei] })).toEqual([]);
  });

  it("does not count a meeting against somebody who had not joined yet", () => {
    const newcomer = member({ id: "new", member_type: "full", joined_month: "2026-08" });
    // Both meetings are in the month they joined, so neither is one they can be said to have
    // missed -- the month is all the roster records, so the coarse read has to favour the member.
    expect(
      consecutiveAbsences({ meetings, members: [newcomer] }).map((row) => row.member_id),
    ).toEqual([]);
  });

  it("excuses an unmatched guest line that carries the member's name", () => {
    const named = [
      meeting("m2", "2026-08-17T13:30:00.000Z", []),
      meeting("m1", "2026-08-10T13:30:00.000Z", []),
    ].map((entry) =>
      Object.assign({}, entry, {
        attendees: [
          { display_name: "mei chen (phone)", source: "transcript" as const, present: true },
          { display_name: "Mei Chen", source: "transcript" as const, present: true },
        ],
      }),
    );
    expect(consecutiveAbsences({ meetings: named, members: [mei] })).toEqual([]);
  });

  it("leaves out somebody who is neither on the invite nor a full member", () => {
    expect(consecutiveAbsences({ meetings, members: [guest] })).toEqual([]);
  });
});

describe("absenceStreakKey", () => {
  it("is the same whichever order the meetings arrive in", () => {
    expect(absenceStreakKey(["m2", "m1"])).toBe(absenceStreakKey(["m1", "m2"]));
  });

  it("changes once a new meeting joins the streak", () => {
    expect(absenceStreakKey(["m3", "m2"])).not.toBe(absenceStreakKey(["m2", "m1"]));
  });
});

describe("groupMeetingInviteEmails", () => {
  it("takes the attendees of every event on the scheduled weekday, lowercased and deduped", () => {
    const emails = groupMeetingInviteEmails(
      [
        // 2026-08-17 is a Monday; 13:30Z is 09:30 in Toronto.
        {
          id: "e1",
          summary: "Lab sync",
          start: "2026-08-17T13:30:00.000Z",
          attendees: ["Ada@cs.toronto.edu", "mei@cs.toronto.edu"],
        },
        {
          id: "e2",
          summary: "Reading group",
          start: "2026-08-19T13:30:00.000Z",
          attendees: ["someone@else.example"],
        },
        {
          id: "e3",
          summary: "Lab sync",
          start: "2026-08-24T13:30:00.000Z",
          attendees: ["ada@cs.toronto.edu", "sam@cs.toronto.edu"],
        },
      ],
      adminBotDefaultGroupMeeting,
    );
    expect(emails.toSorted()).toEqual([
      "ada@cs.toronto.edu",
      "mei@cs.toronto.edu",
      "sam@cs.toronto.edu",
    ]);
  });

  it("is empty when nothing matched, which callers read as unknown rather than as nobody", () => {
    expect(groupMeetingInviteEmails([], adminBotDefaultGroupMeeting)).toEqual([]);
  });
});

describe("buildMeetingAttendanceMessage", () => {
  it("names the day and the meetings that were missed", () => {
    const message = buildMeetingAttendanceMessage({
      missedTopics: ["Group meeting m2", "Group meeting m1"],
      meetingLabel: "Monday meeting",
    });
    expect(message).toContain("last 2 Monday meetings");
    expect(message).toContain("Group meeting m2; Group meeting m1");
  });
});
