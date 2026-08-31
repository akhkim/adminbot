// Telling people who have stopped coming to the group meeting, on all three channels at once.
//
// Its own file rather than more of service.test.ts, which is already the longest in the extension.
import { describe, expect, it } from "vitest";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

/** Nudges only count as sent when a connector handled them, so every service here has one. */
function serviceWithMembers(): AdminBotService {
  const service = new AdminBotService(undefined, {
    executor: {
      execute: async (proposal) => ({ handled: proposal.type === "member_nudge.send" }),
    },
  });
  unwrap(
    service.upsertLabMember({
      receives_nudges: true,
      id: "ada",
      name: "Ada Lovelace",
      member_type: "full",
      slack_user_id: "U-ADA",
    } as never),
  );
  unwrap(
    service.upsertLabMember({
      receives_nudges: true,
      id: "mei",
      name: "Mei Chen",
      member_type: "full",
      slack_user_id: "U-MEI",
    } as never),
  );
  return service;
}

function fileMeetings(service: AdminBotService, present: string[][]): void {
  present.forEach((attendeeIds, index) => {
    const day = 10 + index * 7;
    unwrap(
      service.upsertMeeting({
        id: `m${index + 1}`,
        topic: `Group meeting ${index + 1}`,
        started_at: `2026-08-${day}T13:30:00.000Z`,
        recording: { share_url: `https://zoom.example/m${index + 1}` },
        source: "manual",
        attendees: attendeeIds.map((id) => ({
          member_id: id,
          display_name: id,
          source: "participant_report" as const,
          present: true,
        })),
      }),
    );
  });
}

describe("collectMeetingAttendanceNudges", () => {
  it("names the member who missed both, and nobody else", () => {
    const service = serviceWithMembers();
    fileMeetings(service, [["ada", "mei"], ["ada"], ["ada"]]);
    const collected = unwrap(service.collectMeetingAttendanceNudges());
    expect(collected.absent.map((row) => row.member_id)).toEqual(["mei"]);
    expect(collected.meeting_label).toBe("Monday meeting");
    // Nothing was passed in, so the calendar half of the audience is unresolved and the page has to
    // be able to say so rather than implying the list is complete.
    expect(collected.invite_resolved).toBe(false);
  });

  it("widens the audience to whoever the calendar invite names", () => {
    const service = serviceWithMembers();
    unwrap(
      service.upsertLabMember({
        receives_nudges: true,
        id: "sam",
        name: "Sam Okafor",
        // Not a full member, so only the invite can put them in scope.
        member_type: "coauthor-minor",
        calendar_email: "sam@gmail.com",
      } as never),
    );
    fileMeetings(service, [["ada"], ["ada"]]);
    const collected = unwrap(
      service.collectMeetingAttendanceNudges({ inviteEmails: ["sam@gmail.com"] }),
    );
    expect(collected.absent.map((row) => [row.member_id, row.reason]).toSorted()).toEqual([
      ["mei", "full_member"],
      ["sam", "invite"],
    ]);
    expect(collected.invite_resolved).toBe(true);
  });
});

describe("sendMeetingAttendanceNudges", () => {
  it("files a notification and sends a Slack DM, once per streak", async () => {
    const service = serviceWithMembers();
    fileMeetings(service, [["ada"], ["ada"]]);

    const first = unwrap(await service.sendMeetingAttendanceNudges("admin"));
    expect(first.notified).toEqual(["mei"]);
    expect(first.slack_skipped).toEqual([]);

    const notifications = unwrap(service.listMemberNotifications("mei")).notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.kind).toBe("meeting_attendance");
    expect(notifications[0]?.tab).toBe("adminbotMeetings");
    expect(notifications[0]?.read_at).toBeUndefined();
    expect(notifications[0]?.body).toContain("Monday meeting");

    // A cron, a retry and an admin's button all describe the same pair of meetings, so the second
    // run says nothing rather than repeating itself.
    const second = unwrap(await service.sendMeetingAttendanceNudges("admin"));
    expect(second.notified).toEqual([]);
    expect(second.already_told).toEqual(["mei"]);
    expect(unwrap(service.listMemberNotifications("mei")).notifications).toHaveLength(1);
  });

  it("speaks again once a new meeting makes a new streak", async () => {
    const service = serviceWithMembers();
    fileMeetings(service, [["ada"], ["ada"]]);
    unwrap(await service.sendMeetingAttendanceNudges("admin"));

    unwrap(
      service.upsertMeeting({
        id: "m3",
        topic: "Group meeting 3",
        started_at: "2026-08-24T13:30:00.000Z",
        recording: { share_url: "https://zoom.example/m3" },
        source: "manual",
        attendees: [
          { member_id: "ada", display_name: "ada", source: "participant_report", present: true },
        ],
      }),
    );
    const third = unwrap(await service.sendMeetingAttendanceNudges("admin"));
    expect(third.notified).toEqual(["mei"]);
    expect(unwrap(service.listMemberNotifications("mei")).notifications).toHaveLength(2);
  });

  it("still notifies somebody whose Slack is unreachable", async () => {
    const service = new AdminBotService(undefined, {
      executor: { execute: async () => ({ handled: false }) },
    });
    unwrap(service.upsertLabMember({ receives_nudges: true, id: "ada", name: "Ada", member_type: "full" } as never));
    unwrap(service.upsertLabMember({ receives_nudges: true, id: "mei", name: "Mei", member_type: "full" } as never));
    fileMeetings(service, [["ada"], ["ada"]]);

    const sent = unwrap(await service.sendMeetingAttendanceNudges("admin"));
    // The DM could not go (no linked Slack account, and no connector handled it) and the member is
    // still told -- reporting this as "skipped" would hide the fact that they were.
    expect(sent.notified).toEqual(["mei"]);
    expect(sent.slack_skipped.map((skip) => skip.member_id)).toEqual(["mei"]);
    expect(unwrap(service.listMemberNotifications("mei")).notifications).toHaveLength(1);
  });
});

describe("member notifications", () => {
  it("marks read without removing the row, and never crosses members", async () => {
    const service = serviceWithMembers();
    fileMeetings(service, [["ada"], ["ada"]]);
    unwrap(await service.sendMeetingAttendanceNudges("admin"));

    expect(unwrap(service.listMemberNotifications("ada")).notifications).toEqual([]);

    const read = unwrap(service.markMemberNotificationsRead("mei"));
    expect(read.read).toBe(1);
    const after = unwrap(service.listMemberNotifications("mei")).notifications;
    // Read is "you have seen this", not "you have done it": the dashboard card stays.
    expect(after).toHaveLength(1);
    expect(after[0]?.read_at).toBeTruthy();

    // A second pass finds nothing unread rather than re-stamping.
    expect(unwrap(service.markMemberNotificationsRead("mei")).read).toBe(0);
  });

  it("refuses a member id the roster does not know", () => {
    const service = serviceWithMembers();
    const result = service.listMemberNotifications("nobody");
    expect(result.ok).toBe(false);
  });
});
