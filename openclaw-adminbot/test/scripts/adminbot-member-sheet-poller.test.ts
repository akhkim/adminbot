import { describe, expect, it, vi } from "vitest";
import type { AdminBotLabMember } from "../../extensions/adminbot/src/contracts/actions.js";
import { parseMemberSheet, pollMemberSheet } from "../../scripts/adminbot-member-sheet-poller.js";

const member = (overrides: Partial<AdminBotLabMember> & { id: string }): AdminBotLabMember =>
  ({
    name: overrides.id,
    privilege_level: "member",
    access: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }) as AdminBotLabMember;

function api(members: AdminBotLabMember[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (!init?.method) {
      return new Response(JSON.stringify({ members }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("AdminBot member sheet poller", () => {
  it("parses supported fields and ignores governed columns", () => {
    expect(
      parseMemberSheet([
        ["AdminBot ID", "Name", "Research Topics", "Hours Per Week", "Privilege Level"],
        ["ada", "Ada Lovelace", "safety; interpretability", "20", "admin"],
      ]),
    ).toEqual({
      rows: [
        {
          memberId: "ada",
          rowNumber: 2,
          patch: {
            name: "Ada Lovelace",
            research_topics: ["safety", "interpretability"],
            hours_per_week: 20,
          },
        },
      ],
      ignoredHeaders: ["Privilege Level"],
    });
  });

  it("rejects missing, duplicate, and unknown stable ids before writing", async () => {
    expect(() => parseMemberSheet([["Name"], ["Ada"]])).toThrow(/AdminBot ID/u);
    expect(() =>
      parseMemberSheet([
        ["AdminBot ID", "Name"],
        ["ada", "Ada"],
        ["ada", "Ada Again"],
      ]),
    ).toThrow(/duplicate AdminBot ID ada/u);

    const { calls, fetchImpl } = api([member({ id: "ada" })]);
    await expect(
      pollMemberSheet({
        spreadsheetId: "sheet-1",
        range: "Members!A:Z",
        serviceBaseUrl: "http://127.0.0.1:8765",
        serviceToken: "secret",
        readRows: async () => [
          ["AdminBot ID", "Name"],
          ["unknown", "Unknown Person"],
        ],
        fetchImpl,
      }),
    ).rejects.toThrow(/unknown AdminBot member ids/u);
    expect(calls.filter((call) => call.init?.method === "PUT")).toEqual([]);
  });

  it("updates only changed, nonblank, safe fields through the service API", async () => {
    const { calls, fetchImpl } = api([
      member({ id: "ada", name: "Ada", location: "Toronto", projects: ["Alpha"] }),
      member({ id: "bob", name: "Bob", location: "Montreal" }),
    ]);
    const summary = await pollMemberSheet({
      spreadsheetId: "sheet-1",
      range: "Members!A:Z",
      serviceBaseUrl: "http://127.0.0.1:8765",
      serviceToken: "secret",
      readRows: async () => [
        ["AdminBot ID", "Name", "Location", "Projects", "Email"],
        ["ada", "Ada", "Vancouver", "Alpha, Beta", "new@example.test"],
        ["bob", "Bob", "", "", "other@example.test"],
      ],
      fetchImpl,
    });

    const writes = calls.filter((call) => call.init?.method === "PUT");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.url).toBe("http://127.0.0.1:8765/lab/members/ada");
    expect(JSON.parse(String(writes[0]?.init?.body))).toEqual({
      location: "Vancouver",
      projects: ["Alpha", "Beta"],
    });
    expect(summary).toMatchObject({
      rows_seen: 2,
      updated: 1,
      unchanged: 1,
      ignored_headers: ["Email"],
    });
  });

  it("reports a dry run without sending writes", async () => {
    const { calls, fetchImpl } = api([member({ id: "ada", location: "Toronto" })]);
    const summary = await pollMemberSheet({
      spreadsheetId: "sheet-1",
      range: "Members!A:Z",
      serviceBaseUrl: "http://127.0.0.1:8765",
      serviceToken: "secret",
      dryRun: true,
      readRows: async () => [
        ["AdminBot ID", "Location"],
        ["ada", "Vancouver"],
      ],
      fetchImpl,
    });

    expect(calls.filter((call) => call.init?.method === "PUT")).toEqual([]);
    expect(summary).toMatchObject({ dry_run: true, updated: 1 });
  });
});
