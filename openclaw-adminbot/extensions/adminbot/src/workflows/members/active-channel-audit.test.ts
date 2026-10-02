// Who the active-channel audit would remove, and — more importantly — who it refuses to.
import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import {
  ACTIVE_CHANNEL_TOKENS,
  auditActiveChannels,
  classifyChannelMember,
  findMemberTypeDivergence,
  holdsActiveChannels,
} from "./active-channel-audit.js";
import { adminBotCollaboratorAccessItems } from "./collaborator-subgroups.js";

function member(overrides: Partial<AdminBotLabMember> = {}): AdminBotLabMember {
  return {
    id: "m1",
    name: "Ada Lovelace",
    email: "ada@example.org",
    privilege_level: "member",
    status: "active",
    access: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as AdminBotLabMember;
}

function row(memberType: string | undefined, slackUserId = "U1") {
  return classifyChannelMember({
    slackUserId,
    displayName: "Ada",
    member: member({ ...(memberType === undefined ? {} : { member_type: memberType }) }),
    channels: ["jinesis-active"],
  });
}

describe("the entitlement rule", () => {
  it("mirrors the access matrix rather than restating it", () => {
    // The matrix is the authority on who gets the active channels; this list has to agree with it
    // or the audit and the invite sweep will disagree about the same people.
    const cells = adminBotCollaboratorAccessItems.find(
      (item) => item.id === "active_channels",
    )?.cells;
    const granted = Object.entries(cells ?? {})
      .filter(([, value]) => value === "yes")
      .map(([subgroup]) => subgroup.replace(/_/gu, "-"));
    for (const subgroup of granted) {
      expect(ACTIVE_CHANNEL_TOKENS).toContain(subgroup);
    }
    // Plus full members, who are not an external subgroup at all.
    expect(ACTIVE_CHANNEL_TOKENS).toContain("full");
  });

  it("reads the column as tokens, because it is multi-valued", () => {
    expect(holdsActiveChannels("full")).toBe(true);
    expect(holdsActiveChannels("coauthor-major")).toBe(true);
    expect(holdsActiveChannels("own-pace-advisee")).toBe(true);
    // Three rows in the current sheet look like this. Exact string matching would drop all of
    // them, and they are the people whose entitlement is least obvious.
    expect(holdsActiveChannels("alumni, coauthor-major")).toBe(true);
    expect(holdsActiveChannels("coauthor-major, top2-only-invite-to-theme-meeting-and-slack")).toBe(
      true,
    );
    expect(holdsActiveChannels("alumni")).toBe(false);
    expect(holdsActiveChannels("coauthor-minor")).toBe(false);
    expect(holdsActiveChannels("interviewee, acquaintance")).toBe(false);
  });
});

describe("classification", () => {
  it("keeps the entitled", () => {
    expect(row("full").verdict).toBe("entitled");
    expect(row("alumni, coauthor-major").verdict).toBe("entitled");
  });

  it("marks somebody the roster positively excludes", () => {
    const classified = row("coauthor-minor");
    expect(classified.verdict).toBe("not_entitled");
    expect(classified.reason).toContain("coauthor-minor");
  });

  it("refuses to decide on a blank Member Type", () => {
    // Twelve rows in the current sheet are blank. Treating blank as "no" removes all of them.
    expect(row(undefined).verdict).toBe("unknown");
    expect(row("").verdict).toBe("unknown");
    expect(row("   ").verdict).toBe("unknown");
  });

  it("leaves a Slack account no roster row claims", () => {
    const classified = classifyChannelMember({
      slackUserId: "UBOT",
      displayName: "AdminBot (bot)",
      channels: ["random-active"],
    });
    expect(classified.verdict).toBe("unmatched");
    expect(classified.reason).toContain("gap in the roster");
  });
});

describe("the audit", () => {
  it("offers only the positively not-entitled for removal", () => {
    const audit = auditActiveChannels([
      row("full", "U1"),
      row("coauthor-minor", "U2"),
      row(undefined, "U3"),
      classifyChannelMember({
        slackUserId: "U4",
        displayName: "Guest",
        channels: ["random-active"],
      }),
    ]);
    expect(audit.removable.map((entry) => entry.slack_user_id)).toEqual(["U2"]);
    // The two it cannot decide on are surfaced for a person rather than dropped or removed.
    expect(audit.needs_review.map((entry) => entry.slack_user_id)).toEqual(["U3", "U4"]);
    expect(audit.counts).toEqual({ entitled: 1, not_entitled: 1, unknown: 1, unmatched: 1 });
  });
});

describe("the spreadsheet cross-check", () => {
  it("says nothing when the two agree, whatever the order or spacing", () => {
    const divergence = findMemberTypeDivergence({
      members: [member({ slack_user_id: "U1", member_type: "full, coauthor-minor" })],
      sheetTypesBySlackId: new Map([["U1", "coauthor-minor,full"]]),
    });
    expect(divergence).toEqual([]);
  });

  it("reports a real disagreement", () => {
    const divergence = findMemberTypeDivergence({
      members: [member({ slack_user_id: "U1", member_type: "coauthor-minor" })],
      sheetTypesBySlackId: new Map([["U1", "coauthor-major"]]),
    });
    expect(divergence).toHaveLength(1);
    expect(divergence[0]).toMatchObject({
      database: "coauthor-minor",
      spreadsheet: "coauthor-major",
    });
  });

  it("ignores members the sheet has nothing to say about", () => {
    expect(
      findMemberTypeDivergence({
        members: [member({ slack_user_id: "U9", member_type: "full" })],
        sheetTypesBySlackId: new Map(),
      }),
    ).toEqual([]);
  });
});
