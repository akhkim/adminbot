import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import {
  adoptionSummary,
  isSelfFilled,
  lastSelfEditAt,
  projectAdoption,
  selfFilledFieldCount,
  stampFieldProvenance,
} from "./adoption.js";

function member(fields: Partial<AdminBotLabMember> = {}): AdminBotLabMember {
  return {
    id: "ada",
    name: "Ada Lovelace",
    privilege_level: "member",
    access: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...fields,
  } as AdminBotLabMember;
}

const now = "2026-08-25T10:00:00.000Z";

describe("stampFieldProvenance", () => {
  it("stamps only the fields whose value actually changed", () => {
    const existing = member({ location: "Toronto", whatsapp: "+1" });
    const provenance = stampFieldProvenance({
      existing,
      next: { location: "Toronto", whatsapp: "+2" },
      source: "member",
      at: now,
      actor: "ada",
    });
    // An unchanged value is not an edit -- otherwise re-saving a form would credit the member with
    // every field on it, and a nightly importer would launder its own writes into member-authored.
    expect(provenance.location).toBeUndefined();
    expect(provenance.whatsapp).toEqual({ source: "member", at: now, actor: "ada" });
  });

  it("treats undefined in a patch as 'not sent', never as a change", () => {
    const existing = member({ availability: [{ label: "x" }] as never });
    const provenance = stampFieldProvenance({
      existing,
      next: { availability: undefined },
      source: "member",
      at: now,
    });
    expect(provenance.availability).toBeUndefined();
  });

  it("compares arrays and objects by value, not by identity", () => {
    const existing = member({ research_topics: ["nlp", "causality"] });
    const provenance = stampFieldProvenance({
      existing,
      next: { research_topics: ["nlp", "causality"] },
      source: "member",
      at: now,
    });
    expect(provenance.research_topics).toBeUndefined();
  });

  it("leaves the service's own bookkeeping fields alone", () => {
    const provenance = stampFieldProvenance({
      existing: member(),
      next: { updated_at: now, last_login_at: now, slack_messages_7d: 4 },
      source: "import",
      at: now,
    });
    expect(provenance).toEqual({});
  });

  it("keeps an earlier stamp on a field this write did not touch", () => {
    const existing = member({
      location: "Toronto",
      field_provenance: { location: { source: "member", at: "2026-02-01T00:00:00.000Z" } },
    });
    const provenance = stampFieldProvenance({
      existing,
      next: { whatsapp: "+1" },
      source: "import",
      at: now,
    });
    expect(provenance.location?.source).toBe("member");
    expect(provenance.whatsapp?.source).toBe("import");
  });
});

describe("selfFilledFieldCount", () => {
  const fields = ["location", "whatsapp", "cv_url"];

  it("counts a field only when the member wrote it and it still has a value", () => {
    const row = member({
      location: "Toronto",
      whatsapp: "",
      cv_url: "https://example.com/cv.pdf",
      field_provenance: {
        location: { source: "member", at: now },
        whatsapp: { source: "member", at: now },
        cv_url: { source: "import", at: now },
      },
    });
    // location counts; whatsapp was cleared so there is nothing adopted; cv_url was imported.
    expect(selfFilledFieldCount(row, fields)).toBe(1);
  });

  it("counts a field with no provenance at all as not-self", () => {
    // Everything written before provenance existed is in this state, so adoption starts low and
    // climbs rather than starting wrong and high.
    expect(selfFilledFieldCount(member({ location: "Toronto" }), fields)).toBe(0);
  });
});

describe("isSelfFilled / lastSelfEditAt", () => {
  it("reports the most recent member-authored stamp, ignoring admin and import ones", () => {
    const row = member({
      field_provenance: {
        location: { source: "member", at: "2026-03-01T00:00:00.000Z" },
        whatsapp: { source: "member", at: "2026-06-01T00:00:00.000Z" },
        cv_url: { source: "admin", at: "2026-08-01T00:00:00.000Z" },
      },
    });
    expect(isSelfFilled(row, "cv_url")).toBe(false);
    expect(lastSelfEditAt(row)).toBe("2026-06-01T00:00:00.000Z");
  });

  it("is undefined for somebody who has never edited anything themselves", () => {
    expect(lastSelfEditAt(member())).toBeUndefined();
  });
});

describe("projectAdoption", () => {
  it("counts papers carrying a weekly update from this member", () => {
    const updates = [
      {
        paper_id: "p1",
        member_id: "ada",
        week_start: "2026-08-17",
        body: "wrote the intro",
        created_at: now,
        updated_at: now,
      },
      // Somebody else's update on ada's paper is not ada adopting it.
      {
        paper_id: "p2",
        member_id: "mei",
        week_start: "2026-08-17",
        body: "ran the eval",
        created_at: now,
        updated_at: now,
      },
      // An empty body is a row, not an update.
      {
        paper_id: "p3",
        member_id: "ada",
        week_start: "2026-08-17",
        body: "   ",
        created_at: now,
        updated_at: now,
      },
    ];
    expect(projectAdoption({ memberId: "ada", paperIds: ["p1", "p2", "p3"], updates })).toEqual({
      total: 3,
      self_updated: 1,
    });
  });
});

describe("adoptionSummary", () => {
  it("rates over every field of every member rather than averaging percentages", () => {
    const summary = adoptionSummary(
      [
        {
          self_filled_field_count: 10,
          last_login_at: now,
          projects: { total: 2, self_updated: 2 },
        },
        { self_filled_field_count: 0, projects: { total: 2, self_updated: 0 } },
      ],
      10,
    );
    expect(summary.members).toBe(2);
    expect(summary.profile_rate).toBe(0.5);
    expect(summary.project_rate).toBe(0.5);
    expect(summary.signed_in_ever).toBe(1);
  });

  it("is zero rather than NaN for an empty lab", () => {
    expect(adoptionSummary([], 12)).toEqual({
      members: 0,
      profile_rate: 0,
      project_rate: 0,
      signed_in_ever: 0,
      active_ever: 0,
    });
  });

  it("counts somebody active who has no surviving sign-in", () => {
    // The exact row the audit window creates: their sign-in aged out, but they edited a paper last
    // week. signed_in_ever cannot see them, which is the reason active_ever exists.
    const summary = adoptionSummary(
      [
        {
          self_filled_field_count: 0,
          projects: { total: 0, self_updated: 0 },
          activity: { logins: 0, profile_edits: 0, paper_updates: 3 },
        },
      ],
      12,
    );
    expect(summary.signed_in_ever).toBe(0);
    expect(summary.active_ever).toBe(1);
  });

  it("does not count a member with nothing recorded at all", () => {
    const summary = adoptionSummary(
      [
        {
          self_filled_field_count: 0,
          projects: { total: 0, self_updated: 0 },
          activity: { logins: 0, profile_edits: 0, paper_updates: 0 },
        },
      ],
      12,
    );
    expect(summary.active_ever).toBe(0);
  });
});
