// The membership sweep proposes and never executes. These tests are mostly about that line.
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

function seededService() {
  const executed: string[] = [];
  const service = new AdminBotService(undefined, {
    executor: {
      execute: async (proposal) => {
        executed.push(proposal.type);
        return { handled: true };
      },
    },
  });
  const rows = [
    { id: "full", privilege_level: "member", status: "active", email: "full@cs.toronto.edu" },
    { id: "trial", privilege_level: "trial", status: "active", email: "trial@cs.toronto.edu" },
    {
      id: "major",
      privilege_level: "external_collaborator",
      collaborator_subgroup: "coauthor_major",
      status: "active",
      email: "major@other.test",
    },
    { id: "alum", privilege_level: "member", status: "alumni", email: "alum@cs.toronto.edu" },
  ];
  for (const row of rows) {
    unwrap(service.upsertLabMember({ name: `Name ${row.id}`, ...row } as never));
  }
  return { service, executed };
}

const ATTENDEES = [
  "full@cs.toronto.edu",
  "trial@cs.toronto.edu",
  "major@other.test",
  "alum@cs.toronto.edu",
];

describe("planInviteMembership", () => {
  it("proposes the removals without executing anything", () => {
    const { service, executed } = seededService();
    const result = unwrap(
      service.planInviteMembership({
        surface: "group_meeting",
        eventId: "evt-monday",
        attendees: ATTENDEES,
        actor: "cron",
      }),
    );

    expect(result.remove.map((entry) => entry.member_id).toSorted()).toEqual(["alum", "trial"]);
    expect(result.keep.toSorted()).toEqual(["full@cs.toronto.edu", "major@other.test"]);
    expect(result.proposal_id).toBeTruthy();
    // The whole point: nothing reached the calendar.
    expect(executed).toEqual([]);

    const proposal = unwrap(service.listPending()).proposals.find(
      (entry) => entry.id === result.proposal_id,
    )!;
    expect(proposal.type).toBe("calendar.remove_attendees");
    expect(proposal.status).not.toBe("executed");
    // The payload carries both halves: who is dropped, and the exact set the write leaves behind.
    expect(proposal.proposed_payload).toMatchObject({
      event_id: "evt-monday",
      removed_attendees: expect.arrayContaining(["trial@cs.toronto.edu", "alum@cs.toronto.edu"]),
      remaining_attendees: expect.arrayContaining(["full@cs.toronto.edu", "major@other.test"]),
    });
  });

  it("drops the major coauthor too when the surface is the lab calendar", () => {
    const { service } = seededService();
    const result = unwrap(
      service.planInviteMembership({
        surface: "lab_calendar",
        eventId: "evt-cal",
        attendees: ATTENDEES,
        actor: "cron",
      }),
    );
    expect(result.remove.map((entry) => entry.member_id).toSorted()).toEqual([
      "alum",
      "major",
      "trial",
    ]);
  });

  it("proposes nothing when the invite is already correct", () => {
    const { service } = seededService();
    const result = unwrap(
      service.planInviteMembership({
        surface: "group_meeting",
        eventId: "evt-monday",
        attendees: ["full@cs.toronto.edu", "major@other.test"],
        actor: "cron",
      }),
    );
    expect(result.remove).toEqual([]);
    expect(result.proposal_id).toBeUndefined();
    expect(unwrap(service.listPending()).proposals).toHaveLength(0);
  });

  // A failed calendar read looks exactly like an event with no attendees, and the resulting write
  // would blank a real meeting. Refusing is the only safe reading.
  it("refuses to plan against an empty attendee list", () => {
    const { service } = seededService();
    const result = service.planInviteMembership({
      surface: "group_meeting",
      eventId: "evt-monday",
      attendees: [],
      actor: "cron",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toContain("refusing");
  });

  it("requires an event id", () => {
    const { service } = seededService();
    const result = service.planInviteMembership({
      surface: "group_meeting",
      eventId: "  ",
      attendees: ATTENDEES,
      actor: "cron",
    });
    expect(result.ok).toBe(false);
  });
});
