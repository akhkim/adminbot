import { describe, expect, it } from "vitest";
import { BASIC_WELCOME_MEMBER_TYPES } from "../workflows/onboarding/member-type-template.js";
import { adminBotMemberTypes } from "./actions.js";
import {
  adminBotDefaultEngagementPolicy,
  adminBotEmailAddressProblem,
  adminBotEngagementAudienceOf,
  adminBotEngagementAudiences,
  adminBotLongTermReminderGate,
  adminBotLongTermReminderKinds,
  adminBotMemberEngagement,
  adminBotUnclassifiedReminderCycleDays,
  renderEngagementReminder,
  resolveEngagementPolicy,
  validateEngagementPolicyOverrides,
} from "./engagement.js";

describe("adminBotMemberEngagement", () => {
  it("is empty for somebody never seen anywhere", () => {
    expect(adminBotMemberEngagement({})).toEqual({ channels: {} });
  });

  it("takes the latest sighting across every channel and names it", () => {
    const engagement = adminBotMemberEngagement(
      {
        last_login_at: "2026-03-01T00:00:00.000Z",
        last_seen_at: "2026-03-02T00:00:00.000Z",
        last_cli_at: "2026-03-05T00:00:00.000Z",
      },
      { lastSelfEditAt: "2026-03-03T00:00:00.000Z" },
    );
    expect(engagement.last_active_at).toBe("2026-03-05T00:00:00.000Z");
    expect(engagement.last_channel).toBe("cli");
    expect(Object.keys(engagement.channels).toSorted()).toEqual([
      "cli",
      "self_edit",
      "web_login",
      "web_seen",
    ]);
  });

  it("prefers the service's login over the record's, which a bulk write can overwrite", () => {
    const engagement = adminBotMemberEngagement(
      { last_login_at: "2026-01-01T00:00:00.000Z" },
      { lastLoginAt: "2026-03-01T00:00:00.000Z" },
    );
    expect(engagement.channels.web_login).toBe("2026-03-01T00:00:00.000Z");
  });

  it("counts Slack only when the member was measured as active", () => {
    const checked = { slack_user_id: "U1", slack_activity_checked_at: "2026-03-09T00:00:00.000Z" };
    expect(adminBotMemberEngagement({ ...checked, slack_messages_7d: 4 }).channels.slack).toBe(
      "2026-03-09T00:00:00.000Z",
    );
    // Quiet all week is not a sighting just because somebody looked.
    expect(adminBotMemberEngagement({ ...checked, slack_messages_7d: 0 }).channels.slack).toBe(
      undefined,
    );
  });

  it("drops an unparseable stamp rather than reading it as activity", () => {
    expect(adminBotMemberEngagement({ last_cli_at: "whenever" })).toEqual({ channels: {} });
  });
});

describe("adminBotEngagementAudienceOf", () => {
  const of = (fields: { status?: string; member_type?: string }) =>
    adminBotEngagementAudienceOf(fields as never);

  it("reads standing before type, so leaving or going part-time lowers the expectation", () => {
    expect(of({ status: "alumni", member_type: "full" })).toBe("alumni");
    expect(of({ member_type: "alumni, full" })).toBe("alumni");
    expect(of({ status: "part_time", member_type: "full" })).toBe("part_time");
  });

  it("lets the most engaged type win among several", () => {
    expect(of({ member_type: "mailing-list, full" })).toBe("full");
    expect(of({ member_type: "coauthor-minor,coauthor-major" })).toBe("coauthor-major");
  });

  it("accepts either spelling the roster uses", () => {
    expect(of({ member_type: "coauthor_minor" })).toBe("coauthor-minor");
  });

  it("leaves a type the table does not name unchased", () => {
    expect(of({})).toBeUndefined();
    expect(of({ member_type: "visiting-wizard" })).toBeUndefined();
  });
});

describe("the shipped policy", () => {
  it("chases the working groups and offers alumni one quiet note", () => {
    const enabled = Object.entries(adminBotDefaultEngagementPolicy)
      .filter(([, entry]) => entry.enabled)
      .map(([group]) => group)
      .toSorted();
    expect(enabled).toEqual([
      "alumni",
      "coauthor-discussant-or-designer",
      "coauthor-major",
      "coauthor-minor",
      "disappearing-coauthor",
      "full",
      "interviewee",
      "own-pace-advisee",
      "part_time",
      "slightly-better-than-emails",
    ]);
    expect(adminBotDefaultEngagementPolicy.alumni).toMatchObject({
      channel: "email",
      max_reminders: 1,
      escalate: false,
    });
  });

  it("gives alumni the periodic check-in and nothing else", () => {
    expect(adminBotDefaultEngagementPolicy.alumni.reminders).toEqual({
      dormant_login: false,
      onboarding_chase: false,
      profile_fields: false,
      weekly_notes: false,
      alumni_checkin: true,
    });
  });

  it("sends nothing long-term to the operational and mailing-list types", () => {
    for (const group of [
      "external-prof",
      "benefit-partner",
      "benefit-direct-relative",
      "acquaintance",
      "adminbot-admin",
      "adminbot-developer",
      "mailing-list",
    ] as const) {
      expect(adminBotDefaultEngagementPolicy[group].enabled, group).toBe(false);
      expect(Object.values(adminBotDefaultEngagementPolicy[group].reminders), group).not.toContain(
        true,
      );
    }
  });

  it("lays reminder switches over the defaults one kind at a time", () => {
    const resolved = resolveEngagementPolicy({ full: { reminders: { weekly_notes: false } } });
    expect(resolved.full.reminders).toEqual({
      ...adminBotDefaultEngagementPolicy.full.reminders,
      weekly_notes: false,
    });
  });

  it("lays overrides over the defaults field by field", () => {
    const resolved = resolveEngagementPolicy({ full: { max_reminders: 2 } });
    expect(resolved.full).toEqual({ ...adminBotDefaultEngagementPolicy.full, max_reminders: 2 });
    expect(resolved.alumni).toEqual(adminBotDefaultEngagementPolicy.alumni);
    expect(resolveEngagementPolicy(undefined)).toEqual(adminBotDefaultEngagementPolicy);
  });
});

describe("policy coverage", () => {
  // The compile-time check in engagement.ts already refuses a member type with no row. This pins
  // the same thing at runtime, through the classifier the sweeps actually call, for every type a
  // welcome template or the basic welcome names and for the standings that outrank a type.
  const everyType = [
    ...new Set<string>([
      ...adminBotMemberTypes,
      ...BASIC_WELCOME_MEMBER_TYPES,
      "own-pace-advisee",
      "interviewee",
      "mailing-list",
    ]),
  ];

  it.each(everyType)("maps %s to its own policy row", (type) => {
    const audience = adminBotEngagementAudienceOf({ member_type: type } as never);
    expect(audience).toBe(type);
    const entry = adminBotDefaultEngagementPolicy[audience!];
    expect(Object.keys(entry.reminders).toSorted()).toEqual(
      [...adminBotLongTermReminderKinds].toSorted(),
    );
    expect(entry.cycle_days).toBeGreaterThan(0);
  });

  it("maps part-time standing to its own row whatever the type says", () => {
    const audience = adminBotEngagementAudienceOf({
      status: "part_time",
      member_type: "full",
    } as never);
    expect(audience).toBe("part_time");
    expect(adminBotDefaultEngagementPolicy.part_time.enabled).toBe(true);
  });

  it("has a row for every audience and no audience without one", () => {
    expect(Object.keys(adminBotDefaultEngagementPolicy).toSorted()).toEqual(
      [...adminBotEngagementAudiences].toSorted(),
    );
  });
});

describe("adminBotLongTermReminderGate", () => {
  const policy = adminBotDefaultEngagementPolicy;
  const now = new Date("2026-03-11T09:20:00.000Z");
  const gate = (
    member: { status?: string; member_type?: string },
    kind: (typeof adminBotLongTermReminderKinds)[number],
    lastLongTermReminderAt?: string,
  ) =>
    adminBotLongTermReminderGate({
      member: member as never,
      kind,
      policy,
      lastLongTermReminderAt,
      now,
    });

  it("lets a full member through when nothing went out before", () => {
    expect(gate({ member_type: "full" }, "dormant_login")).toEqual({
      allowed: true,
      audience: "full",
    });
  });

  it("holds any second reminder inside the cycle, whichever kind went first", () => {
    // Full's cycle is two days: a profile reminder on Tuesday holds Wednesday's weekly ask.
    expect(gate({ member_type: "full" }, "weekly_notes", "2026-03-10T10:50:00.000Z")).toEqual({
      allowed: false,
      reason: "cycle",
      audience: "full",
    });
  });

  it("counts the cycle in calendar days, so a later time of day does not shift it", () => {
    // Monday 10:50 and a two-day cycle: Wednesday 09:20 is allowed, though under 48 hours.
    expect(gate({ member_type: "full" }, "profile_fields", "2026-03-09T10:50:00.000Z")).toEqual({
      allowed: true,
      audience: "full",
    });
  });

  it("says off for a kind the row does not send", () => {
    expect(gate({ member_type: "alumni" }, "weekly_notes")).toMatchObject({
      allowed: false,
      reason: "off",
    });
    expect(gate({ member_type: "mailing-list" }, "profile_fields")).toMatchObject({
      allowed: false,
      reason: "off",
    });
  });

  it("reads standing first, so an alumnus typed full gets only the check-in", () => {
    expect(gate({ status: "alumni", member_type: "full" }, "dormant_login")).toMatchObject({
      reason: "off",
    });
    expect(gate({ status: "alumni", member_type: "full" }, "alumni_checkin")).toMatchObject({
      allowed: true,
    });
  });

  it("refuses an untyped member the reminders only a type can justify", () => {
    expect(gate({}, "dormant_login")).toEqual({ allowed: false, reason: "unclassified" });
    expect(gate({ member_type: "visiting-wizard" }, "alumni_checkin")).toEqual({
      allowed: false,
      reason: "unclassified",
    });
  });

  it("sends an untyped member the evidence reminders on the fallback cycle", () => {
    expect(gate({}, "profile_fields")).toEqual({ allowed: true });
    const held = new Date(now.getTime() - (adminBotUnclassifiedReminderCycleDays - 1) * 86_400_000);
    expect(gate({}, "weekly_notes", held.toISOString())).toEqual({
      allowed: false,
      reason: "cycle",
    });
    const clear = new Date(now.getTime() - adminBotUnclassifiedReminderCycleDays * 86_400_000);
    expect(gate({}, "onboarding_chase", clear.toISOString())).toEqual({ allowed: true });
  });

  it("follows an override that turns a kind off", () => {
    expect(
      adminBotLongTermReminderGate({
        member: { member_type: "full" } as never,
        kind: "weekly_notes",
        policy: resolveEngagementPolicy({ full: { reminders: { weekly_notes: false } } }),
        now,
      }),
    ).toMatchObject({ allowed: false, reason: "off" });
  });

  it("ignores an unparseable stamp rather than treating it as recent", () => {
    expect(gate({ member_type: "full" }, "dormant_login", "whenever")).toMatchObject({
      allowed: true,
    });
  });
});

describe("validateEngagementPolicyOverrides", () => {
  it("accepts a valid partial override and nothing at all", () => {
    expect(validateEngagementPolicyOverrides(undefined)).toBeUndefined();
    expect(
      validateEngagementPolicyOverrides({
        acquaintance: { enabled: true, channel: "email", interval_days: 60 },
      }),
    ).toBeUndefined();
  });

  it.each([
    ["a list", []],
    ["an unknown group", { wizards: { enabled: true } }],
    ["a misspelled field", { full: { enabeld: false } }],
    ["a zero interval", { full: { interval_days: 0 } }],
    ["a fractional threshold", { full: { inactive_after_days: 1.5 } }],
    ["an unknown channel", { full: { channel: "sms" } }],
    ["a blank template", { full: { template: "  " } }],
    ["too many reminders", { full: { max_reminders: 99 } }],
    ["a zero cycle", { full: { cycle_days: 0 } }],
    ["an unknown reminder kind", { full: { reminders: { birthday: true } } }],
    ["a non-boolean reminder switch", { full: { reminders: { weekly_notes: "yes" } } }],
    ["reminders as a list", { full: { reminders: ["weekly_notes"] } }],
  ])("refuses %s", (_label, value) => {
    expect(validateEngagementPolicyOverrides(value)).toEqual(expect.any(String));
  });
});

describe("adminBotEmailAddressProblem", () => {
  it("passes an ordinary address", () => {
    expect(adminBotEmailAddressProblem("ada@lab.test")).toBeUndefined();
    expect(adminBotEmailAddressProblem(" ada.l@cs.lab.test ")).toBeUndefined();
  });

  it("names the stray dot pasted from the end of a sentence", () => {
    expect(adminBotEmailAddressProblem("ada@lab.test.")).toBe("trailing_dot");
  });

  it("calls anything else undeliverable malformed", () => {
    for (const address of ["ada", "ada@", "ada@lab", "ada lovelace@lab.test", "ada@@lab.test"]) {
      expect(adminBotEmailAddressProblem(address)).toBe("malformed");
    }
  });
});

describe("renderEngagementReminder", () => {
  it("fills the name and says when AdminBot last saw them, as a date", () => {
    expect(
      renderEngagementReminder("Hi {first_name}, {last_seen}.", {
        firstName: "Ada",
        lastActiveAt: "2026-03-01T09:00:00.000Z",
      }),
    ).toBe("Hi Ada, AdminBot last saw you on March 1, 2026.");
  });

  it("says they have not signed in yet when there is no sighting", () => {
    expect(renderEngagementReminder("{last_seen}", { firstName: "Ada" })).toBe(
      "you have not signed in to AdminBot yet",
    );
  });
});
