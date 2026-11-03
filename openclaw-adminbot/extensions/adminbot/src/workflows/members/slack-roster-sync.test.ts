import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import {
  classifySlackUser,
  planSlackRosterSync,
  slackRosterSyncRefusal,
  type SlackDirectoryUser,
} from "./slack-roster-sync.js";

// Synthetic people and accounts only.
const NOW = "2026-10-15T06:25:00.000Z";

function slack(id: string, extra: Partial<SlackDirectoryUser> = {}): SlackDirectoryUser {
  return {
    id,
    deleted: false,
    is_bot: false,
    is_app_user: false,
    is_restricted: false,
    is_ultra_restricted: false,
    real_name: `Person ${id}`,
    email: `${id.toLowerCase()}@lab.test`,
    tz: "America/Toronto",
    image: `https://avatars.test/${id}.png`,
    ...extra,
  };
}

function member(id: string, extra: Partial<AdminBotLabMember> = {}): AdminBotLabMember {
  return {
    id,
    name: `Member ${id}`,
    email: `${id}@lab.test`,
    privilege_level: "member",
    access: [],
    ...extra,
  } as AdminBotLabMember;
}

const plan = (users: SlackDirectoryUser[], members: AdminBotLabMember[], ids?: Set<string>) =>
  planSlackRosterSync({ users, members, now: NOW, ...(ids ? { placeholderIds: ids } : {}) });

describe("classifySlackUser", () => {
  it.each([
    [slack("USLACKBOT"), "slackbot"],
    [slack("B1", { is_bot: true }), "bot"],
    [slack("A1", { is_app_user: true }), "bot"],
    [slack("D1", { deleted: true }), "deleted"],
    [slack("G1", { is_ultra_restricted: true, is_restricted: true }), "single_channel_guest"],
    [slack("G2", { is_restricted: true }), "multi_channel_guest"],
    [slack("P1", { real_name: "Test User" }), "placeholder"],
    [slack("P2", { real_name: "undefined" }), "placeholder"],
    [slack("P3", { real_name: "Real Name", email: "someone@example.com" }), "placeholder"],
    [slack("P4", { real_name: "Placeholder (temp)" }), "placeholder"],
    [slack("O1", { real_name: "Null,do not contact" }), "opted_out"],
    [slack("O2", { real_name: "Jane Roe", title: "DNC" }), "opted_out"],
    [slack("O3", { real_name: "null" }), "opted_out"],
    [slack("M1"), "member"],
    // Substrings do not count: these are real names, not placeholders.
    [slack("M2", { real_name: "Tess Testa" }), "member"],
    [slack("M3", { real_name: "Nullah Contact", email: "n@example-lab.org" }), "member"],
  ] as const)("classifies %o as %s", (user, kind) => {
    expect(classifySlackUser(user)).toBe(kind);
  });

  it("honours the explicit flag", () => {
    expect(classifySlackUser(slack("M1"), new Set(["M1"]))).toBe("placeholder");
  });
});

describe("planSlackRosterSync", () => {
  it("creates an unmatched full member at least privilege", () => {
    const result = plan([slack("UNEW", { real_name: "Ada Example" })], []);
    expect(result.creates).toEqual([
      {
        slack_user_id: "UNEW",
        member: {
          id: "ada-example",
          name: "Ada Example",
          email: "unew@lab.test",
          slack_user_id: "UNEW",
          privilege_level: "external_collaborator",
          avatar_url: "https://avatars.test/UNEW.png",
          timezone: "America/Toronto",
          notes: "Created from the Slack roster sync.",
        },
      },
    ]);
  });

  it("does not collide with an existing id", () => {
    const result = plan(
      [slack("UNEW", { real_name: "Ada Example" })],
      [member("ada-example", { email: "other@lab.test" })],
    );
    expect(result.creates[0]?.member.id).toBe("ada-example-2");
  });

  it("does not import bots, guests, deactivated accounts or placeholders", () => {
    const result = plan(
      [
        slack("USLACKBOT"),
        slack("B1", { is_bot: true }),
        slack("G1", { is_ultra_restricted: true }),
        slack("G2", { is_restricted: true }),
        slack("D1", { deleted: true }),
        slack("P1", { real_name: "Test" }),
      ],
      [],
    );
    expect(result.creates).toEqual([]);
    expect(result.skipped.map((row) => row.kind)).toEqual([
      "slackbot",
      "bot",
      "single_channel_guest",
      "multi_channel_guest",
      "deleted",
      "placeholder",
    ]);
  });

  it("links by email and fills empty Slack-derived fields", () => {
    const result = plan([slack("U1")], [member("m1", { email: "U1@lab.test" })]);
    expect(result.updates).toEqual([
      {
        member_id: "m1",
        slack_user_id: "U1",
        matched_by: "email",
        changes: [
          { field: "slack_user_id", from: "", to: "U1" },
          { field: "avatar_url", from: "", to: "https://avatars.test/U1.png" },
          { field: "timezone", from: "", to: "America/Toronto" },
        ],
      },
    ]);
  });

  it("refreshes an import-written avatar but never a member- or admin-written field", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const result = plan(
      [slack("U1"), slack("U2"), slack("U3")],
      [
        member("m1", { slack_user_id: "U1", avatar_url: "old", timezone: "Europe/Paris" }),
        member("m2", {
          slack_user_id: "U2",
          avatar_url: "mine",
          timezone: "America/Toronto",
          field_provenance: { avatar_url: { source: "member", at } },
        }),
        member("m3", {
          slack_user_id: "U3",
          field_provenance: {
            avatar_url: { source: "admin", at },
            timezone: { source: "member", at },
          },
        }),
      ],
    );
    expect(result.updates).toEqual([
      {
        member_id: "m1",
        slack_user_id: "U1",
        matched_by: "slack_user_id",
        // Timezone is only filled when empty; the directory refresh owns the live value.
        changes: [{ field: "avatar_url", from: "old", to: "https://avatars.test/U1.png" }],
      },
    ]);
    expect(result.unchanged).toBe(2);
  });

  it("does not overwrite an existing link or match an email already linked elsewhere", () => {
    const result = plan(
      [slack("U9", { email: "m1@lab.test" })],
      [member("m1", { slack_user_id: "U1" })],
    );
    expect(result.updates).toEqual([]);
    // U9 is a different account: it is a new person, not m1.
    expect(result.creates.map((row) => row.slack_user_id)).toEqual(["U9"]);
  });

  it("reports an email shared by two unlinked records as a conflict", () => {
    const result = plan(
      [slack("U1", { email: "shared@lab.test" })],
      [member("a", { email: "shared@lab.test" }), member("b", { email: "shared@lab.test" })],
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.updates).toEqual([]);
    expect(result.creates).toEqual([]);
  });

  it("flags a deactivated account once and clears the flag on return", () => {
    const deactivated = plan(
      [slack("U1", { deleted: true })],
      [member("m1", { slack_user_id: "U1" })],
    );
    expect(deactivated.deactivations).toEqual([{ member_id: "m1", slack_user_id: "U1" }]);
    expect(deactivated.removals).toEqual([]);
    const flagged = member("m1", {
      slack_user_id: "U1",
      slack_deactivated_at: NOW,
      avatar_url: "https://avatars.test/U1.png",
      timezone: "America/Toronto",
    });
    expect(plan([slack("U1", { deleted: true })], [flagged]).deactivations).toEqual([]);
    expect(plan([slack("U1")], [flagged]).reactivations).toEqual([
      { member_id: "m1", slack_user_id: "U1" },
    ]);
  });

  it("proposes removal for a test account in the roster, not for one outside it", () => {
    const result = plan(
      [slack("UT", { real_name: "Test User" }), slack("UX", { email: "x@example.org" })],
      [member("m-test", { slack_user_id: "UT" })],
    );
    expect(result.removals).toEqual([
      {
        member_id: "m-test",
        member_name: "Member m-test",
        slack_user_id: "UT",
        reason: 'name "Test User" is a placeholder',
      },
    ]);
    expect(result.skipped).toEqual([{ slack_user_id: "UX", kind: "placeholder" }]);
  });

  it("proposes removal for an unmatched roster test record", () => {
    const result = plan(
      [slack("U1")],
      [member("m-ph", { name: "placeholder", email: "ph@example.com" })],
    );
    expect(result.removals.map((row) => row.member_id)).toEqual(["m-ph"]);
  });

  it("repairs a stand-in roster name from a real Slack account", () => {
    const result = plan(
      [slack("U1", { real_name: "Grace Example" })],
      [member("m1", { name: "Test User", slack_user_id: "U1" })],
    );
    expect(result.removals).toEqual([]);
    expect(result.updates[0]?.changes).toContainEqual({
      field: "name",
      from: "Test User",
      to: "Grace Example",
    });
  });

  // The live case: a real member renamed themselves "Null,do not contact". That is an opt-out, not a
  // test row. Nothing is written to the record and nothing is proposed for removal.
  it('treats "Null,do not contact" as an opt-out for admin review, never a removal', () => {
    const optedOut = member("mem_synthetic_dnc", {
      name: "Null,do not contact",
      slack_user_id: "UDNC",
      privilege_level: "external_collaborator",
      receives_nudges: false,
      field_provenance: {
        name: { source: "member", at: "2026-09-29T00:00:00.000Z", actor: "mem_synthetic_dnc" },
      },
    });
    const users = [slack("UDNC", { real_name: "Original Export Name" })];
    const result = plan(users, [optedOut]);
    expect(result.opted_out).toEqual([
      {
        member_id: "mem_synthetic_dnc",
        member_name: "Null,do not contact",
        slack_user_id: "UDNC",
        reason: 'roster name "Null,do not contact" asks not to be contacted',
        action: "opted out; admin review",
      },
    ]);
    expect(result.removals).toEqual([]);
    expect(result.updates).toEqual([]);
    expect(result.deactivations).toEqual([]);
    // Unmatched, deactivated or flagged, the answer is the same.
    expect(plan([], [optedOut]).removals).toEqual([]);
    expect(plan([], [optedOut]).opted_out).toHaveLength(1);
    expect(plan([slack("UDNC", { deleted: true })], [optedOut]).deactivations).toEqual([]);
    expect(plan(users, [optedOut], new Set(["UDNC"])).removals).toEqual([]);
  });

  it("does not import a do-not-contact Slack account", () => {
    const result = plan([slack("U1", { real_name: "Null,do not contact" })], []);
    expect(result.creates).toEqual([]);
    expect(result.opted_out.map((row) => row.slack_user_id)).toEqual(["U1"]);
  });

  it("is idempotent: the roster after applying a plan yields an empty plan", () => {
    const users = [slack("U1"), slack("U2", { deleted: true })];
    const members = [
      member("m1", {
        slack_user_id: "U1",
        avatar_url: "https://avatars.test/U1.png",
        timezone: "America/Toronto",
      }),
      member("m2", { slack_user_id: "U2", slack_deactivated_at: NOW }),
    ];
    const result = plan(users, members);
    expect(result).toMatchObject({
      creates: [],
      updates: [],
      deactivations: [],
      reactivations: [],
      removals: [],
      unchanged: 2,
    });
  });
});

describe("slackRosterSyncRefusal", () => {
  it("refuses a pass that would sweep too much of the roster", () => {
    const users = Array.from({ length: 12 }, (_, i) => slack(`UN${i}`));
    expect(slackRosterSyncRefusal(plan(users, []), 20)).toMatch(/refusing to apply 12/);
    expect(slackRosterSyncRefusal(plan(users.slice(0, 3), []), 20)).toBeUndefined();
  });
});

// The account behind a duplicate an admin merged away. Before merges remembered it, every one of
// these was imported again the next morning as `name-2`.
describe("a merged person's second Slack account", () => {
  it("is recognized by its Slack id and neither creates nor rewrites anything", () => {
    const result = plan(
      [
        slack("UKEEP", { real_name: "Eric Example" }),
        slack("USECOND", { real_name: "Eric Example", email: "eric@cs.lab.test" }),
      ],
      [
        member("eric", {
          slack_user_id: "UKEEP",
          alternate_slack_user_ids: ["USECOND"],
          former_member_ids: ["eric-example"],
        }),
      ],
    );
    expect(result.creates).toEqual([]);
    // Only the record's own account may refresh it; the other account's avatar is not theirs.
    expect(result.updates.every((update) => update.slack_user_id === "UKEEP")).toBe(true);
    expect(result.deactivations).toEqual([]);
  });

  it("is recognized by an absorbed address when no Slack id was remembered", () => {
    const result = plan(
      [slack("UOTHER", { real_name: "Yara Example", email: "Yara@CS.Lab.Test" })],
      [member("yara", { slack_user_id: "UYARA", alternate_emails: ["yara@cs.lab.test"] })],
    );
    expect(result.creates).toEqual([]);
    expect(result.updates).toEqual([]);
  });

  it("does not hand a retired id out again to a new account", () => {
    const result = plan(
      [slack("UNEW", { real_name: "Ada Example" })],
      [member("someone", { former_member_ids: ["ada-example"] })],
    );
    expect(result.creates.map((create) => create.member.id)).toEqual(["ada-example-2"]);
  });
});
