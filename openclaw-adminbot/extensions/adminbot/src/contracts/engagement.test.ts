import { describe, expect, it } from "vitest";
import {
  adminBotDefaultEngagementPolicy,
  adminBotEmailAddressProblem,
  adminBotEngagementAudienceOf,
  adminBotMemberEngagement,
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
    expect(enabled).toEqual(["alumni", "coauthor-major", "coauthor-minor", "full", "part_time"]);
    expect(adminBotDefaultEngagementPolicy.alumni).toMatchObject({
      channel: "email",
      max_reminders: 1,
      escalate: false,
    });
  });

  it("lays overrides over the defaults field by field", () => {
    const resolved = resolveEngagementPolicy({ full: { max_reminders: 2 } });
    expect(resolved.full).toEqual({ ...adminBotDefaultEngagementPolicy.full, max_reminders: 2 });
    expect(resolved.alumni).toEqual(adminBotDefaultEngagementPolicy.alumni);
    expect(resolveEngagementPolicy(undefined)).toEqual(adminBotDefaultEngagementPolicy);
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
