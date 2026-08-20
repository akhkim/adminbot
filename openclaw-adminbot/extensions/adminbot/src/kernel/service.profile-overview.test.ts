// The lab-wide profile overview: who has filled their own record in, and who has used the timeline.
//
// Its own file rather than more of service.test.ts for the same reason the logistics tests are
// split out — that file is already the longest in the extension.
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

/** Every mandatory field filled, so a test can take exactly the ones it wants back out. */
const COMPLETE = {
  name: "Ada Lovelace",
  calendar_email: "ada@cs.toronto.edu",
  location: "Toronto",
  research_topics: ["causality"],
  correspondence_email: "ada@cs.toronto.edu",
  whatsapp: "+1 555 0100",
  joined_month: "2026-01",
  github_url: "https://github.com/ada",
  linkedin_url: "https://linkedin.com/in/ada",
  linkedin_urn: "urn:li:person:ada",
  cv_url: "https://overleaf.com/read/ada",
  intake_form_url: "https://docs.google.com/forms/d/e/ada/viewform",
  openreview_id: "~Ada_Lovelace1",
};

function serviceWith(
  members: Record<string, unknown>[],
  options: { deliverNudges?: boolean } = {},
): AdminBotService {
  // A nudge only counts as sent when a connector handled it, so the reminder test needs one;
  // everything else here is a pure read and does not.
  const service = options.deliverNudges
    ? new AdminBotService(undefined, {
        executor: {
          execute: async (proposal) => ({ handled: proposal.type === "member_nudge.send" }),
        },
      })
    : new AdminBotService();
  for (const member of members) {
    unwrap(service.upsertLabMember(member as never));
  }
  return service;
}

describe("listMemberProfileOverview", () => {
  it("carries the denominator so no client has to count the mandatory fields itself", () => {
    const service = serviceWith([{ id: "ada", ...COMPLETE, privilege_level: "member" }]);
    const overview = unwrap(service.listMemberProfileOverview());
    // Deliberately not `adminBotMandatoryProfileFields.length`: the service does not check `name`,
    // because a member cannot be created without one, so the honest denominator is one smaller.
    // A client counting the exported list would show everybody stuck one field short forever --
    // which is exactly why the count is carried rather than derived.
    expect(overview.mandatory_field_count).toBe(12);
    expect(overview.members[0]?.filled_field_count).toBe(overview.mandatory_field_count);
    expect(overview.members[0]?.missing_fields).toEqual([]);
  });

  it("does not count the one field a member cannot be missing", () => {
    const overview = unwrap(
      serviceWith([
        { id: "ada", ...COMPLETE, privilege_level: "member" },
      ]).listMemberProfileOverview(),
    );
    expect(overview.members[0]?.missing_fields).not.toContain("name");
  });

  it("names the fields a member still owes, not just how many", () => {
    const service = serviceWith([
      { id: "ada", ...COMPLETE, privilege_level: "member", cv_url: "", openreview_id: "" },
    ]);
    const overview = unwrap(service.listMemberProfileOverview());
    const [row] = overview.members;
    expect(row?.missing_fields).toEqual(["cv_url", "openreview_id"]);
    expect(row?.filled_field_count).toBe(overview.mandatory_field_count - 2);
  });

  it("counts an empty list as missing, the way the reminder pass already does", () => {
    const service = serviceWith([
      { id: "ada", ...COMPLETE, privilege_level: "member", research_topics: [] },
    ]);
    expect(unwrap(service.listMemberProfileOverview()).members[0]?.missing_fields).toContain(
      "research_topics",
    );
  });

  it("counts every kind of timeline entry, and says which kind", () => {
    const service = serviceWith([
      {
        id: "ada",
        ...COMPLETE,
        privilege_level: "member",
        availability: [
          { start: "2026-08-01", end: "2026-09-03", project: "AdminBot", hours_per_week: 20 },
        ],
        time_off: [
          {
            start: "2026-08-10",
            end: "2026-08-21",
            kind: "vacation",
            availability: "none",
          },
        ],
        milestones: [{ date: "2026-12-01", label: "thesis" }],
        trips: [{ start: "2026-09-01", end: "2026-09-05", city: "Berlin" }],
      },
    ]);
    const [row] = unwrap(service.listMemberProfileOverview()).members;
    expect(row?.timeline).toMatchObject({
      availability: 1,
      time_off: 1,
      milestones: 1,
      trips: 1,
      total: 4,
    });
  });

  it("reports nothing on the timeline as zero rather than leaving it out", () => {
    const service = serviceWith([{ id: "ada", ...COMPLETE, privilege_level: "member" }]);
    expect(unwrap(service.listMemberProfileOverview()).members[0]?.timeline.total).toBe(0);
  });

  it("puts the least finished profile first, breaking ties on an empty timeline", () => {
    const service = serviceWith([
      {
        id: "done",
        ...COMPLETE,
        name: "Done",
        privilege_level: "member",
        milestones: [{ date: "2026-12-01", label: "thesis" }],
      },
      {
        id: "blank",
        ...COMPLETE,
        name: "Blank",
        privilege_level: "member",
        cv_url: "",
        github_url: "",
        linkedin_url: "",
      },
      { id: "nearly", ...COMPLETE, name: "Nearly", privilege_level: "member", cv_url: "" },
      { id: "notimeline", ...COMPLETE, name: "NoTimeline", privilege_level: "member" },
    ]);
    expect(unwrap(service.listMemberProfileOverview()).members.map((row) => row.id)).toEqual([
      "blank",
      "nearly",
      "notimeline",
      "done",
    ]);
  });

  it("leaves out the people these fields are not asked of", () => {
    const service = serviceWith([
      { id: "ada", ...COMPLETE, privilege_level: "member", status: "active" },
      { id: "old", ...COMPLETE, name: "Alum", privilege_level: "member", status: "alumni" },
      {
        id: "ext",
        ...COMPLETE,
        name: "External",
        privilege_level: "external_collaborator",
        collaborator_subgroup: "acquaintance",
        status: "external",
      },
    ]);
    expect(unwrap(service.listMemberProfileOverview()).members.map((row) => row.id)).toEqual([
      "ada",
    ]);
  });

  it("says when the reminder pass last chased somebody", async () => {
    const service = serviceWith(
      [{ id: "ada", ...COMPLETE, privilege_level: "member", cv_url: "", slack_user_id: "U123" }],
      { deliverNudges: true },
    );
    expect(
      unwrap(service.listMemberProfileOverview()).members[0]?.last_reminded_at,
    ).toBeUndefined();

    await service.sendMandatoryFieldsReminders("zhijing");
    expect(unwrap(service.listMemberProfileOverview()).members[0]?.last_reminded_at).toBeTruthy();
  });
});
