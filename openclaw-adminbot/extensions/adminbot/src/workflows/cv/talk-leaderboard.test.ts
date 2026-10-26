// The talk leaderboard over a synthetic roster: who is counted, what counts, and how ties read.
import { describe, expect, it } from "vitest";
import type { AdminBotCvEntry, AdminBotLabMember } from "../../contracts/actions.js";
import { buildTalkLeaderboard, renderTalkLeaderboardMarkdown } from "./talk-leaderboard.js";

function talk(title: string, start: string, invited?: boolean): AdminBotCvEntry {
  return {
    kind: "talk",
    title,
    organization: `${title} host`,
    start,
    ...(invited === undefined ? {} : { invited }),
  };
}

function member(
  id: string,
  entries: AdminBotCvEntry[] | null,
  extra: Partial<AdminBotLabMember> = {},
): AdminBotLabMember {
  return {
    id,
    name: id.toUpperCase(),
    privilege_level: "member",
    access: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    cv_url: `https://example.com/${id}.pdf`,
    ...(entries
      ? { cv_snapshot: { fetched_at: "2026-10-01T00:00:00.000Z", content_hash: id, entries } }
      : {}),
    ...extra,
  };
}

describe("buildTalkLeaderboard", () => {
  it("ranks on invited talks this year, then all talks, then name", () => {
    const board = buildTalkLeaderboard(
      [
        member("ada", [talk("A1", "2026", true), talk("A2", "Mar 2026", false)]),
        member("ben", [talk("B1", "2026", true), talk("B2", "2026", true)]),
        member("cy", [talk("C1", "2026", true)]),
        member("dee", [talk("D1", "2025", true)]),
      ],
      2026,
    );
    expect(board.rows.map((row) => [row.member_name, row.invited, row.total])).toEqual([
      ["BEN", 2, 2],
      ["ADA", 1, 2],
      ["CY", 1, 1],
    ]);
  });

  it("reads the year from the normalized date before the printed one", () => {
    const board = buildTalkLeaderboard(
      [member("ada", [{ ...talk("A1", "Fall term", true), start_iso: "2026-10" }])],
      2026,
    );
    expect(board.rows).toHaveLength(1);
  });

  it("counts a talk listed twice once, as invited if either listing says so", () => {
    const board = buildTalkLeaderboard(
      [member("ada", [talk("Same talk", "2026"), talk("Same  talk", "2026", true)])],
      2026,
    );
    expect(board.rows[0]).toMatchObject({ invited: 1, total: 1 });
  });

  it("counts an unclassified talk in the total but not as invited", () => {
    const board = buildTalkLeaderboard([member("ada", [talk("A1", "2026")])], 2026);
    expect(board.rows[0]).toMatchObject({ invited: 0, total: 1 });
  });

  it("leaves out alumni and external collaborators, and names CVs not read yet", () => {
    const board = buildTalkLeaderboard(
      [
        member("gone", [talk("G1", "2026", true)], { status: "alumni" }),
        member("ext", [talk("E1", "2026", true)], { status: "external" }),
        member("new", null),
        member("nolink", null, { cv_url: undefined }),
      ],
      2026,
    );
    expect(board.rows).toEqual([]);
    expect(board.unscanned).toEqual(["NEW"]);
  });
});

describe("renderTalkLeaderboardMarkdown", () => {
  it("gives tied members the same rank", () => {
    const markdown = renderTalkLeaderboardMarkdown(
      buildTalkLeaderboard(
        [
          member("ada", [talk("A1", "2026", true), talk("A2", "2026", false)]),
          member("ben", [talk("B1", "2026", true), talk("B2", "2026", false)]),
          member("cy", [talk("C1", "2026", true)]),
        ],
        2026,
      ),
    ).join("\n");
    expect(markdown).toContain("## Invited talks 2026");
    expect(markdown).toContain("- #1 **ADA** — 1 invited (+1 other)");
    expect(markdown).toContain("- #1 **BEN** — 1 invited (+1 other)");
    expect(markdown).toContain("- #3 **CY** — 1 invited");
  });

  it("says so when no talks are on record rather than showing an empty list", () => {
    const markdown = renderTalkLeaderboardMarkdown({ year: 2026, rows: [], unscanned: ["NEW"] });
    expect(markdown.join("\n")).toContain("No talks dated 2026");
    expect(markdown.join("\n")).toContain("Not counted yet (CV not read): NEW");
  });
});
