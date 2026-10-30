import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../extensions/adminbot/src/contracts/actions.js";
import { vectorSponsorRoster } from "../../extensions/adminbot/src/workflows/members/collaborator-subgroups.js";
import {
  buildSheetValues,
  describeGogFailure,
  syncVectorRoster,
} from "../../scripts/adminbot-vector-roster-sync.js";

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
  member({ id: "ada", name: "Ada", email: "ada@utoronto.ca", dcs_username: "adaex" } as never),
  member({ id: "bob", name: "Bob", email: "bob@utoronto.ca", dcs_username: " bobex " } as never),
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
      member({
        id: "gone",
        name: "Gone",
        email: "gone@cs.toronto.edu",
        member_type: "full, alumni",
      } as never),
      member({ id: "here", name: "Here", email: "here@cs.toronto.edu" } as never),
    ]);
    expect(roster.entries.map((entry) => entry.id)).toEqual(["here"]);
  });

  it("carries coauthor-major and own-pace-advisee, and nobody the type column does not name", () => {
    const roster = vectorSponsorRoster([
      member({
        id: "major",
        name: "Major",
        email: "m@x.test",
        member_type: "coauthor-major",
      } as never),
      member({
        id: "advisee",
        name: "Advisee",
        email: "a@x.test",
        member_type: "own-pace-advisee",
      } as never),
      member({
        id: "minor",
        name: "Minor",
        email: "n@x.test",
        member_type: "coauthor-minor",
      } as never),
      // privilege_level alone is what used to put 184 people on a sheet meant for 62.
      member({ id: "blank", name: "Blank", email: "b@x.test", member_type: "" } as never),
    ]);
    expect(roster.entries.map((entry) => entry.id)).toEqual(["advisee", "major"]);
  });
});

describe("vector roster sheet sync", () => {
  // The sponsor's sheet keys accounts by DCS username; nothing else about the person goes on it.
  it("writes the sheet's own three columns and nothing else", () => {
    expect(buildSheetValues(roster)).toEqual([
      ["full_name", "adminbot_internal_id", "dcs_username"],
      ["Ada", "ada", "adaex"],
      ["Bob", "bob", "bobex"],
    ]);
    expect(JSON.stringify(buildSheetValues(roster))).not.toMatch(/utoronto/u);
  });

  // Leaving someone off reads to the sponsor as "remove this account", which is not what a missing
  // username means.
  it("keeps a member with no DCS username, with that cell empty, and reports the gap", async () => {
    const gapped = vectorSponsorRoster([
      member({ id: "ada", name: "Ada", email: "ada@utoronto.ca", dcs_username: "adaex" } as never),
      member({ id: "new", name: "New", email: "new@utoronto.ca" }),
    ]);
    expect(buildSheetValues(gapped).at(-1)).toEqual(["New", "new", ""]);
    const { gog } = recordingGog();
    expect(await syncVectorRoster({ roster: gapped, gog })).toMatchObject({
      written_rows: 2,
      missing_dcs_username: ["new"],
    });
  });

  // Clearing before the write would blank the shared sheet if the write then failed, and a blank
  // sheet tells the sponsor to remove every account.
  it("writes the roster before clearing the stale tail", async () => {
    const { calls, gog } = recordingGog();
    await syncVectorRoster({ roster, gog });

    expect(calls.map((call) => `${call[0]} ${call[1]}`)).toEqual(["sheets update", "sheets clear"]);
    // The bot-owned sheet the sponsor reads, not the read-only one this used to 403 against.
    expect(calls[0]?.[2]).toBe("1DFDiFTfhXGDb5S4EKWLVEcj-3_NaxyHHjoUwawizs88");
    expect(calls[0]).toContain("A1:C3");
    expect(calls[0]?.at(-1)).toBe(JSON.stringify(buildSheetValues(roster)));
    // The tail starts one row past what was just written, so a shrinking roster leaves nothing.
    expect(calls[1]).toContain("A4:C");
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

  it("keeps a member with no email on the sheet, reports them, and fails only under --strict", async () => {
    const gapped = vectorSponsorRoster([
      member({ id: "ada", name: "Ada", email: "ada@utoronto.ca" }),
      member({ id: "noemail", name: "No Email" }),
    ]);
    const { gog } = recordingGog();

    expect(buildSheetValues(gapped).at(-1)).toEqual(["No Email", "noemail", ""]);
    expect(await syncVectorRoster({ roster: gapped, gog })).toMatchObject({
      written_rows: 2,
      missing_email: ["noemail"],
    });
    await expect(syncVectorRoster({ roster: gapped, gog, strict: true })).rejects.toThrow(
      /no email: noemail/u,
    );
  });
});

describe("gog failure reporting", () => {
  const updateArgs = [
    "sheets",
    "update",
    "sheet-id",
    "A1:B3",
    "--input",
    "RAW",
    "--values-json",
    JSON.stringify(buildSheetValues(roster)),
  ];
  // What execFile rejects with: its message is the full command line, roster JSON included.
  const execFailure = (stderr: string) =>
    Object.assign(new Error(`Command failed: gog ${updateArgs.join(" ")}\n${stderr}`), {
      stderr,
      code: 1,
    });

  // The live failure: 56 nights of the whole roster, emails and all, in the cron run log.
  it("never echoes the roster it was writing", () => {
    const message = describeGogFailure(
      updateArgs,
      execFailure("Google API error (403 forbidden): The caller does not have permission\n"),
      "bot@example.test",
    );
    expect(message).not.toMatch(/utoronto|Ada|Bob|values-json/u);
    expect(message).toMatch(/^gog sheets update failed: Google API error \(403 forbidden\)/u);
  });

  it("names the sharing fix on a 403", () => {
    const message = describeGogFailure(
      updateArgs,
      execFailure("Google API error (403 forbidden): The caller does not have permission"),
      "bot@example.test",
    );
    expect(message).toMatch(/bot@example\.test needs Editor access on spreadsheet \S+/u);
  });

  it("adds no sharing hint to failures that are not permission errors", () => {
    const message = describeGogFailure(
      ["sheets", "clear", "sheet-id", "A4:B", "--force"],
      execFailure("Google API error (500): backend error"),
    );
    expect(message).toBe("gog sheets clear failed: Google API error (500): backend error");
  });

  it("reports a timeout as one", () => {
    const killed = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
    expect(describeGogFailure(updateArgs, killed)).toBe("gog sheets update timed out after 60s");
  });
});
