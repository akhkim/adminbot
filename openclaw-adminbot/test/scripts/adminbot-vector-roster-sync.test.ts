import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../extensions/adminbot/src/contracts/actions.js";
import { vectorSponsorRoster } from "../../extensions/adminbot/src/workflows/members/collaborator-subgroups.js";
import { buildSheetValues, syncVectorRoster } from "../../scripts/adminbot-vector-roster-sync.js";

// `member_type` is what puts somebody on this sheet, not `privilege_level`: privilege says what a
// person may do, and almost every imported row defaults to `member`.
const member = (overrides: Partial<AdminBotLabMember> & { id: string }): AdminBotLabMember =>
  ({
    name: overrides.id,
    privilege_level: "member",
    member_type: "full",
    ...overrides,
  }) as AdminBotLabMember;

function recordingGog() {
  const calls: string[][] = [];
  return { calls, gog: async (args: string[]) => void calls.push(args) };
}

const roster = vectorSponsorRoster([
  member({ id: "ada", name: "Ada", email: "ada@utoronto.ca" }),
  member({ id: "bob", name: "Bob", email: "bob@utoronto.ca" }),
]);

describe("who the sponsor sheet carries", () => {
  // The sponsor reads this against university accounts, so the cs address is the one that means
  // something to him -- and it is not always the address filed as primary.
  it("prefers a cs.toronto.edu address wherever the member has one", () => {
    const roster = vectorSponsorRoster([
      member({
        id: "ada",
        name: "Ada",
        email: "ada@gmail.com",
        correspondence_email: "ada@cs.toronto.edu",
      } as never),
    ]);
    expect(roster.entries[0]?.email).toBe("ada@cs.toronto.edu");
  });

  // Somebody without a DCS account is still reachable, and a real address beats an empty cell.
  it("falls back to the professional address when there is no cs account", () => {
    const roster = vectorSponsorRoster([
      member({ id: "bob", name: "Bob", email: "bob@ethz.ch" } as never),
    ]);
    expect(roster.entries[0]?.email).toBe("bob@ethz.ch");
  });

  // The live failure this replaced: alumni keep privilege_level `member` and often keep `full` in
  // their type, so nothing ever took them off. Twenty-two were on the sheet, which is the sponsor
  // being told to keep twenty-two accounts that should have been closed.
  it("drops alumni even when their member type still says full", () => {
    const roster = vectorSponsorRoster([
      member({ id: "gone", name: "Gone", email: "gone@cs.toronto.edu", member_type: "full, alumni" } as never),
      member({ id: "here", name: "Here", email: "here@cs.toronto.edu" } as never),
    ]);
    expect(roster.entries.map((entry) => entry.id)).toEqual(["here"]);
  });

  it("carries coauthor-major, and nobody the type column does not name", () => {
    const roster = vectorSponsorRoster([
      member({ id: "major", name: "Major", email: "m@x.test", member_type: "coauthor-major" } as never),
      member({ id: "minor", name: "Minor", email: "n@x.test", member_type: "coauthor-minor" } as never),
      // privilege_level alone is what used to put 184 people on a sheet meant for 62.
      member({ id: "blank", name: "Blank", email: "b@x.test", member_type: "" } as never),
    ]);
    expect(roster.entries.map((entry) => entry.id)).toEqual(["major"]);
  });
});

describe("vector roster sheet sync", () => {
  it("writes a header plus name and email only", () => {
    expect(buildSheetValues(roster)).toEqual([
      ["Name", "Email"],
      ["Ada", "ada@utoronto.ca"],
      ["Bob", "bob@utoronto.ca"],
    ]);
  });

  // Clearing before the write would blank the shared sheet if the write then failed, and a blank
  // sheet tells the sponsor to remove every account.
  it("writes the roster before clearing the stale tail", async () => {
    const { calls, gog } = recordingGog();
    await syncVectorRoster({ roster, gog });

    expect(calls.map((call) => `${call[0]} ${call[1]}`)).toEqual(["sheets update", "sheets clear"]);
    expect(calls[0]).toContain("A1:B3");
    expect(calls[0]?.at(-1)).toBe(JSON.stringify(buildSheetValues(roster)));
    // The tail starts one row past what was just written, so a shrinking roster leaves nothing.
    expect(calls[1]).toContain("A4:B");
  });

  it("refuses to write an empty roster instead of blanking the sheet", async () => {
    const { calls, gog } = recordingGog();
    await expect(
      syncVectorRoster({ roster: { entries: [], missing_email: [] }, gog }),
    ).rejects.toThrow(/refusing to write an empty roster/u);
    expect(calls).toEqual([]);
  });

  it("touches nothing on a dry run", async () => {
    const { calls, gog } = recordingGog();
    const summary = await syncVectorRoster({ roster, gog, dryRun: true });

    expect(calls).toEqual([]);
    expect(summary).toMatchObject({ dry_run: true, written_rows: 2 });
  });

  it("reports missing emails in the summary, and fails the run only under --strict", async () => {
    const gapped = vectorSponsorRoster([
      member({ id: "ada", name: "Ada", email: "ada@utoronto.ca" }),
      member({ id: "noemail", name: "No Email" }),
    ]);
    const { gog } = recordingGog();

    expect(await syncVectorRoster({ roster: gapped, gog })).toMatchObject({
      written_rows: 1,
      missing_email: ["noemail"],
    });
    await expect(syncVectorRoster({ roster: gapped, gog, strict: true })).rejects.toThrow(
      /no email: noemail/u,
    );
  });
});
