import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../extensions/adminbot/src/contracts/actions.js";
import { vectorSponsorRoster } from "../../extensions/adminbot/src/workflows/members/collaborator-subgroups.js";
import { buildSheetValues, syncVectorRoster } from "../../scripts/adminbot-vector-roster-sync.js";

const member = (overrides: Partial<AdminBotLabMember> & { id: string }): AdminBotLabMember =>
  ({ name: overrides.id, privilege_level: "member", ...overrides }) as AdminBotLabMember;

function recordingGog() {
  const calls: string[][] = [];
  return { calls, gog: async (args: string[]) => void calls.push(args) };
}

const roster = vectorSponsorRoster([
  member({ id: "ada", name: "Ada", email: "ada@utoronto.ca" }),
  member({ id: "bob", name: "Bob", email: "bob@utoronto.ca" }),
]);

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
