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
    // Opted onto the nudge list unless a case says otherwise -- the overview reads every active
    // member, but only somebody on the list can actually be sent the reminder it counts.
    unwrap(service.upsertLabMember({ receives_nudges: true, ...member } as never));
  }
  return service;
}

describe("listMemberProfileOverview", () => {
  it("carries the denominator so no client has to count the mandatory fields itself", () => {
    const service = serviceWith([{ id: "ada", ...COMPLETE, privilege_level: "member" }]);
    const overview = unwrap(service.listMemberProfileOverview());
    // Deliberately not `adminBotMandatoryProfileFields.length`: the service checks neither `name`,
    // because a member cannot be created without one, nor the admin-owned fields, because the
    // member's own page will not let them type those -- so the honest denominator is two smaller.
    // A client counting the exported list would show everybody stuck short forever, which is
    // exactly why the count is carried rather than derived.
    expect(overview.mandatory_field_count).toBe(11);
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

describe("who the sweep leaves out", () => {
  it("drops somebody the spreadsheet calls alumni even when status says nothing", () => {
    // The live roster's actual shape: 22 people are alumni in member_type and only 2 carry
    // status "alumni", with no overlap. Reading status alone kept every one of them in the
    // adoption columns, which is a reminder aimed at somebody who left months ago.
    const service = serviceWith([
      { id: "ada", ...COMPLETE, privilege_level: "member" },
      { id: "grace", ...COMPLETE, privilege_level: "member", member_type: "alumni" },
      {
        id: "alan",
        ...COMPLETE,
        privilege_level: "member",
        member_type: "alumni, coauthor-major",
      },
    ]);
    const ids = unwrap(service.listMemberProfileOverview()).members.map((member) => member.id);
    expect(ids).toEqual(["ada"]);
  });

  it("keeps a coauthor who has not left", () => {
    // Only the alumni token retires somebody. A coauthor is still someone the lab asks.
    const service = serviceWith([
      { id: "ada", ...COMPLETE, privilege_level: "member", member_type: "full, coauthor-major" },
      { id: "grace", ...COMPLETE, privilege_level: "member", member_type: "external-prof" },
    ]);
    const ids = unwrap(service.listMemberProfileOverview()).members.map((member) => member.id);
    expect([...ids].sort()).toEqual(["ada", "grace"]);
  });

  it("still drops somebody flagged alumni by status alone", () => {
    const service = serviceWith([
      { id: "ada", ...COMPLETE, privilege_level: "member" },
      { id: "grace", ...COMPLETE, privilege_level: "member", status: "alumni" },
    ]);
    const ids = unwrap(service.listMemberProfileOverview()).members.map((member) => member.id);
    expect(ids).toEqual(["ada"]);
  });
});

describe("the activity counts", () => {
  // Six at a time, because that is how the roster is really written: a sync touches everybody in
  // one second, and the counts have to treat that as one pass rather than six people working.
  const ROSTER = ["ada", "grace", "alan", "edsger", "barbara", "ken"];

  function serviceWithRoster() {
    return serviceWith(
      ROSTER.map((id) => ({ id, ...COMPLETE, name: id, privilege_level: "member" })),
    );
  }

  it("counts a member's sign-ins from the audit trail, not from last_login_at", () => {
    const service = serviceWithRoster();
    // last_login_at is empty on this roster -- a bulk write erased it -- so a page reading only
    // that field calls a daily user "never signed in". The audit trail still has the sign-ins.
    for (const [index, at] of ["2026-08-20T10:00:00.000Z", "2026-08-21T10:00:00.000Z"].entries()) {
      service.recordAudit({
        id: `aud_login_${index}`,
        timestamp: at,
        type: "auth.login_succeeded",
        actor: "ada",
      });
    }
    const ada = unwrap(service.listMemberProfileOverview()).members.find(
      (member) => member.id === "ada",
    );
    expect(ada?.activity.logins).toBe(2);
    expect(ada?.last_login_at).toBe("2026-08-21T10:00:00.000Z");
  });

  it("counts paper work, and rolls the lab up into active_ever", () => {
    const service = serviceWithRoster();
    service.recordAudit({
      id: "aud_slot",
      timestamp: "2026-08-22T10:00:00.000Z",
      type: "paper_slot.updated",
      actor: "ada",
    });
    const overview = unwrap(service.listMemberProfileOverview());
    const ada = overview.members.find((member) => member.id === "ada");
    const grace = overview.members.find((member) => member.id === "grace");
    expect(ada?.activity.paper_updates).toBe(1);
    expect(grace?.activity.paper_updates).toBe(0);
    // Ada never signed in, so this is exactly the member signed_in_ever cannot see.
    expect(overview.adoption.signed_in_ever).toBe(0);
    expect(overview.adoption.active_ever).toBe(1);
  });

  it("does not count a roster-wide sync as everybody editing their profile", () => {
    const service = serviceWithRoster();
    const at = "2026-08-22T10:00:00.000Z";
    for (const id of ROSTER) {
      service.recordAudit({
        id: `aud_sync_${id}`,
        timestamp: at,
        type: "lab_member.upserted",
        actor: id,
      });
    }
    const overview = unwrap(service.listMemberProfileOverview());
    const ada = overview.members.find((member) => member.id === "ada");
    // Both bursts -- the creates and the sync -- are one pass each, so neither counts. Without
    // this the whole roster reads as active and the column says nothing.
    expect(ada?.activity.profile_edits).toBe(0);
    expect(overview.adoption.active_ever).toBe(0);
  });

  it("counts one member's own save, made on their own", () => {
    const service = serviceWithRoster();
    service.recordAudit({
      id: "aud_self",
      timestamp: "2026-08-22T11:00:00.000Z",
      type: "lab_member.upserted",
      actor: "ada",
    });
    const overview = unwrap(service.listMemberProfileOverview());
    const ada = overview.members.find((member) => member.id === "ada");
    expect(ada?.activity.profile_edits).toBe(1);
    expect(ada?.activity.last_active_at).toBe("2026-08-22T11:00:00.000Z");
    expect(overview.adoption.active_ever).toBe(1);
  });

  it("gives a member with nothing recorded a zeroed row rather than an absent one", () => {
    const service = serviceWithRoster();
    const ada = unwrap(service.listMemberProfileOverview()).members.find(
      (member) => member.id === "ada",
    );
    expect(ada?.activity).toEqual({ logins: 0, profile_edits: 0, paper_updates: 0 });
  });
});

describe("adoption", () => {
  it("separates 'the field is filled' from 'the member filled it'", () => {
    // The state most of the roster is actually in: bulk-imported, complete, adopted by nobody.
    const service = serviceWith([{ id: "ada", ...COMPLETE, privilege_level: "member" }]);
    const imported = unwrap(service.listMemberProfileOverview());
    expect(imported.members[0]?.missing_fields).toEqual([]);
    expect(imported.members[0]?.self_filled_field_count).toBe(0);
    expect(imported.adoption.profile_rate).toBe(0);
    expect(imported.adoption.signed_in_ever).toBe(0);

    // The member changes one thing about themselves, and only that one counts.
    unwrap(service.updateOwnProfile("ada", { location: "Zurich" }));
    const edited = unwrap(service.listMemberProfileOverview());
    expect(edited.members[0]?.self_filled_field_count).toBe(1);
    expect(edited.members[0]?.last_self_edit_at).toBeTruthy();
    expect(edited.members[0]?.updated_at).toBeTruthy();
  });

  it("does not credit the member when an admin corrects their record", () => {
    const service = serviceWith([{ id: "ada", ...COMPLETE, privilege_level: "member" }]);
    unwrap(
      service.upsertLabMember({ id: "ada", location: "Zurich" } as never, {
        source: "admin",
        actor: "zhijing",
      }),
    );
    const overview = unwrap(service.listMemberProfileOverview());
    expect(overview.members[0]?.self_filled_field_count).toBe(0);
    expect(overview.members[0]?.last_self_edit_at).toBeUndefined();
  });

  it("does not launder an unchanged re-import into member-authored data", () => {
    const service = serviceWith([{ id: "ada", ...COMPLETE, privilege_level: "member" }]);
    unwrap(service.updateOwnProfile("ada", { location: "Zurich" }));
    // The nightly spreadsheet sync re-sends everything it has, including the value already stored.
    unwrap(service.upsertLabMember({ id: "ada", ...COMPLETE, location: "Zurich" } as never));
    const overview = unwrap(service.listMemberProfileOverview());
    // Still one: the import changed nothing, so it re-stamped nothing.
    expect(overview.members[0]?.self_filled_field_count).toBe(1);
  });
});
