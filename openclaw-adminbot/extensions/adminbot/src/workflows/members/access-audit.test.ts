// The access audit's own test cases: does it grade correctly, and -- more important -- does it
// refuse to grade what it cannot see?
//
// The failure this file exists to prevent is a report that looks clean. Every rule here is one
// where a lazier checker would have said "pass": a member with no Slack account, an item nobody
// can observe, a connector that failed rather than never ran.
import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import {
  type AccessAuditEvidence,
  auditMemberAccess,
  resolveSubgroup,
  summarizeAccessAudit,
} from "./access-audit.js";

function member(overrides: Partial<AdminBotLabMember> = {}): AdminBotLabMember {
  return {
    id: "ada",
    name: "Ada Lovelace",
    email: "ada@cs.toronto.edu",
    privilege_level: "external_collaborator",
    access: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Everything present and successful, so a test can take away exactly the one thing it is about. */
function evidence(overrides: Partial<AccessAuditEvidence> = {}): AccessAuditEvidence {
  return {
    slack_channels: [
      "jinesis-with-friends-and-collaborators",
      "jinesis-active",
      "random-active",
      "discussion-causality",
      "proj-adminbot",
      "meeting-causality",
      "group-toronto",
    ],
    slack_export_available: true,
    slack_account_known: true,
    portal_credential: true,
    calendar_invite: "succeeded",
    dcs_form: "succeeded",
    approval_email: "succeeded",
    onboarding_guide: "succeeded",
    audit_trail_available: true,
    ...overrides,
  };
}

function finding(row: ReturnType<typeof auditMemberAccess>, item: string) {
  const match = row.findings.find((entry) => entry.item === item);
  if (!match) {
    throw new Error(`no finding for ${item}`);
  }
  return match;
}

describe("resolveSubgroup", () => {
  it("prefers the record's own field when it is set", () => {
    const resolved = resolveSubgroup(
      member({ collaborator_subgroup: "coauthor_minor", member_type: "coauthor-major" }),
    );
    expect(resolved).toEqual({ subgroup: "coauthor_minor", source: "record" });
  });

  it("falls back to the member-type column, and says that it did", () => {
    // This is the live case: `collaborator_subgroup` is unset on every roster row, so grading on
    // it alone would report the whole lab as entitled to nothing. The source is reported so the
    // reader knows the matrix is being applied to a field nothing populates.
    const resolved = resolveSubgroup(member({ member_type: "coauthor-major" }));
    expect(resolved).toEqual({ subgroup: "coauthor_major", source: "member_type" });
  });

  it("grades a multi-token row by its most committed role", () => {
    // "alumni, coauthor-major" is a real value on the roster. The coauthor onboarding is the
    // bigger one, and it is the one whose items are worth checking.
    expect(resolveSubgroup(member({ member_type: "alumni, coauthor-major" })).subgroup).toBe(
      "coauthor_major",
    );
  });

  it("marks a full member as one rather than picking a collaborator row for them", () => {
    const resolved = resolveSubgroup(member({ member_type: "full, coauthor-minor" }));
    expect(resolved).toEqual({ source: "full_member" });
  });

  it("resolves nothing at all when the type column is empty", () => {
    // 93 of 199 roster rows are in this state. Reporting `unknown` keeps them visible as a gap;
    // defaulting them to a subgroup would invent entitlements nobody granted.
    expect(resolveSubgroup(member()).source).toBe("unknown");
  });
});

describe("auditMemberAccess — grading what can be seen", () => {
  const coauthor = member({ member_type: "coauthor-major" });

  it("passes a Slack row the member is actually in", () => {
    const row = auditMemberAccess(coauthor, evidence());
    expect(finding(row, "slack_connect_friends_channel")).toMatchObject({
      verdict: "pass",
      cell: "yes",
    });
    expect(finding(row, "active_channels").verdict).toBe("pass");
  });

  it("fails a Slack row the member is missing, naming the channel", () => {
    const row = auditMemberAccess(
      coauthor,
      evidence({ slack_channels: ["jinesis-active", "proj-adminbot"] }),
    );
    const active = finding(row, "active_channels");
    expect(active.verdict).toBe("fail");
    // Naming the missing half matters: "not in both" sends somebody to check the one they have.
    expect(active.detail).toContain("random-active");
    expect(finding(row, "slack_connect_friends_channel").verdict).toBe("fail");
  });

  it("fails every Slack row when there is no Slack account at all", () => {
    const row = auditMemberAccess(
      coauthor,
      evidence({ slack_account_known: false, slack_channels: [] }),
    );
    // Not "unverifiable": an entitlement to a channel, for somebody with no account, is a thing
    // that demonstrably did not happen.
    expect(finding(row, "slack_connect_friends_channel").verdict).toBe("fail");
    expect(finding(row, "slack_connect_friends_channel").detail).toContain("no Slack account");
  });
});

describe("auditMemberAccess — refusing to grade what it cannot see", () => {
  const coauthor = member({ member_type: "coauthor-major" });

  it("reports rows with no machine-readable trace as unverifiable, with the reason", () => {
    const row = auditMemberAccess(coauthor, evidence());
    for (const item of [
      "welcome_linkedin_twitter",
      "what_to_expect_stories",
      "rec_letter_button",
    ]) {
      const entry = finding(row, item);
      expect(entry.verdict).toBe("unverifiable");
      // A blank would leave the reader to guess. The reason is the useful half of the row.
      expect(entry.detail.length).toBeGreaterThan(0);
    }
  });

  it("goes silent on Slack rows rather than failing them when no export was loaded", () => {
    // The distinction that keeps the report honest: "this person is in no channels" is a finding
    // about the person; "nobody asked Slack" is not.
    const row = auditMemberAccess(coauthor, evidence({ slack_export_available: false }));
    expect(finding(row, "active_channels").verdict).toBe("unverifiable");
    expect(finding(row, "active_channels").detail).toContain("no Slack export");
  });

  it("goes silent on trail-backed rows rather than failing them with no trail", () => {
    const row = auditMemberAccess(coauthor, evidence({ audit_trail_available: false }));
    expect(finding(row, "baseline_calendar_invite").verdict).toBe("unverifiable");
  });

  it("does not grade a cell that is a decision rather than an action", () => {
    // `coauthor_minor`'s rec-letter cell is case_by_case, and `disappearing_coauthor`'s is
    // auto_decline. Neither names something that was supposed to have been executed.
    const row = auditMemberAccess(member({ member_type: "coauthor-minor" }), evidence());
    const rec = finding(row, "rec_letter_button");
    expect(rec.cell).toBe("case_by_case");
    expect(rec.verdict).toBe("unverifiable");
  });
});

describe("auditMemberAccess — entitlement boundaries", () => {
  it("marks rows the subgroup is not granted as not_applicable, not as passes", () => {
    // An acquaintance is not entitled to the active channels. Scoring that as a pass would let
    // "we did not have to" and "we did it" share a symbol, and the report would stop meaning
    // anything.
    const row = auditMemberAccess(member({ member_type: "acquaintance" }), evidence());
    const active = finding(row, "active_channels");
    expect(active.verdict).toBe("not_applicable");
    expect(active.cell).toBeUndefined();
  });

  it("keeps ungranted rows in the report rather than dropping them", () => {
    const acquaintance = auditMemberAccess(member({ member_type: "acquaintance" }), evidence());
    const coauthor = auditMemberAccess(member({ member_type: "coauthor-major" }), evidence());
    // Same shape for everybody: confirming somebody is *not* on a surface is invisible if the row
    // is absent, and that is a thing people read this report to confirm.
    expect(acquaintance.findings.length).toBe(coauthor.findings.length);
  });

  it("still audits the baseline for a full member, who has no matrix row at all", () => {
    const row = auditMemberAccess(member({ member_type: "full" }), evidence());
    expect(row.subgroup_source).toBe("full_member");
    // Every collaborator row is N/A, but the four things approveRegistration fires for anybody
    // still get checked -- otherwise the audit would say nothing about the largest group.
    expect(finding(row, "baseline_calendar_invite").verdict).toBe("pass");
    expect(finding(row, "baseline_portal_login").verdict).toBe("pass");
  });
});

describe("auditMemberAccess — attempted versus never attempted", () => {
  it("distinguishes a failed side effect from one that never ran", () => {
    const failed = auditMemberAccess(
      member({ member_type: "full" }),
      evidence({
        calendar_invite: "failed",
      }),
    );
    const never = auditMemberAccess(
      member({ member_type: "full" }),
      evidence({
        calendar_invite: "no_record",
      }),
    );
    // Both fail, but they need different fixes: one is a broken connector, the other is a member
    // who never went through onboarding. A report that collapsed them would send someone to the
    // wrong place.
    expect(finding(failed, "baseline_calendar_invite").detail).toContain("FAILED");
    expect(finding(never, "baseline_calendar_invite").detail).toContain("no lab calendar invite");
  });

  it("fails the portal row for somebody with no credential", () => {
    const row = auditMemberAccess(
      member({ member_type: "alumni" }),
      evidence({ portal_credential: false }),
    );
    expect(finding(row, "adminbot_portal_access").verdict).toBe("fail");
  });
});

describe("auditMemberAccess — roster-backed rows", () => {
  it("names which profile fields are missing rather than just failing", () => {
    const row = auditMemberAccess(
      member({ member_type: "alumni", location: "Toronto" }),
      evidence(),
    );
    const profile = finding(row, "spreadsheet_full_details");
    expect(profile.verdict).toBe("fail");
    expect(profile.detail).toContain("research topics");
    expect(profile.detail).toContain("joined month");
    // The one field that *is* filled must not be listed as missing.
    expect(profile.detail).not.toContain("location");
  });

  it("passes a complete profile", () => {
    const row = auditMemberAccess(
      member({
        member_type: "alumni",
        correspondence_email: "ada@example.com",
        location: "Toronto",
        research_topics: ["causality"],
        joined_month: "2026-01",
      }),
      evidence(),
    );
    expect(finding(row, "spreadsheet_full_details").verdict).toBe("pass");
  });

  it("reports the sponsor-roster contradiction instead of quietly picking a side", () => {
    // The matrix grants vector_roster_share to own_pace_advisee; VECTOR_ROSTER_MEMBER_TYPES does
    // not include them. That disagreement is documented in collaborator-subgroups.ts as a live
    // question, and putting somebody's address in front of a sponsor is not a thing to resolve by
    // guessing -- so the audit surfaces it.
    const row = auditMemberAccess(member({ member_type: "own-pace-advisee" }), evidence());
    const vector = finding(row, "vector_roster_share");
    expect(vector.verdict).toBe("fail");
    expect(vector.detail).toContain("VECTOR_ROSTER_MEMBER_TYPES");
  });
});

describe("summarizeAccessAudit", () => {
  it("counts members with failures, not just failing rows", () => {
    const rows = [
      auditMemberAccess(member({ id: "a", member_type: "full" }), evidence()),
      auditMemberAccess(
        member({ id: "b", member_type: "full" }),
        evidence({ calendar_invite: "failed", dcs_form: "failed" }),
      ),
    ];
    const summary = summarizeAccessAudit(rows);
    expect(summary.members).toBe(2);
    // Two failing rows on one person is one person to chase, which is the number a reader acts on.
    expect(summary.members_with_failures).toBe(1);
    expect(summary.fail).toBeGreaterThanOrEqual(2);
  });
});
