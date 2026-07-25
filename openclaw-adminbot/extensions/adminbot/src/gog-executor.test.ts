import { describe, expect, it, vi } from "vitest";
import type { AdminBotStoredProposal } from "./contracts.js";
import { createGogAdminBotExecutor, readGogSheetRows } from "./gog-executor.js";
import { AdminBotService } from "./service-core.js";

function proposal(
  type: AdminBotStoredProposal["type"],
  proposedPayload: Record<string, unknown>,
): AdminBotStoredProposal {
  const result = new AdminBotService().createProposal({
    type,
    summary: `Test ${type}`,
    proposed_payload: proposedPayload,
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

describe("createGogAdminBotExecutor", () => {
  it("maps approved email sends to a non-interactive exact gog command", async () => {
    const run = vi.fn(async () => {});
    const executor = createGogAdminBotExecutor({ run });

    await expect(
      executor.execute(
        proposal("email.send", {
          account: "lab@example.com",
          to: ["one@example.com", "two@example.com"],
          subject: "Lab update",
          body: "The draft was approved.",
        }),
      ),
    ).resolves.toEqual({ handled: true });

    expect(run).toHaveBeenCalledWith([
      "--json",
      "--no-input",
      "--enable-commands-exact",
      "gmail.send",
      "--account",
      "lab@example.com",
      "gmail",
      "send",
      "--to",
      "one@example.com,two@example.com",
      "--subject",
      "Lab update",
      "--body",
      "The draft was approved.",
    ]);
  });

  it("maps calendar invites and cancellations with explicit notifications", async () => {
    const run = vi.fn(async () => {});
    const executor = createGogAdminBotExecutor({ run });

    await executor.execute(
      proposal("calendar.send_invite", {
        summary: "Paper review",
        from: "2026-06-22T14:00:00-04:00",
        to: "2026-06-22T14:30:00-04:00",
        attendees: ["reviewer@example.com"],
      }),
    );
    await executor.execute(
      proposal("calendar.cancel", {
        calendar_id: "primary",
        event_id: "event-1",
      }),
    );

    expect(run.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(["calendar.create", "--send-updates", "all"]),
    );
    expect(run.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining(["calendar.delete", "--force", "event-1", "--send-updates", "all"]),
    );
  });

  it("rejects incomplete gog payloads and declines unrelated actions", async () => {
    const run = vi.fn(async () => {});
    const executor = createGogAdminBotExecutor({ run });

    await expect(
      executor.execute(proposal("email.send", { to: "one@example.com" })),
    ).rejects.toThrow("proposed_payload.subject is required");
    await expect(
      executor.execute(proposal("slack.send_message", { message: "hello" })),
    ).resolves.toEqual({ handled: false });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("readGogSheetRows", () => {
  it("reads the applicant sheet through a read-only exact gog command", async () => {
    const capture = vi.fn(async () =>
      JSON.stringify({
        range: "Form Responses 1!A1:D3",
        majorDimension: "ROWS",
        values: [
          ["Timestamp", "Full Name", "Email", "Link to your CV"],
          ["2026-07-01T10:00:00Z", "Ada Lovelace", "ada@example.test", "https://drive/ada"],
        ],
      }),
    );

    await expect(readGogSheetRows("sheet-1", { capture, env: {} })).resolves.toEqual([
      ["Timestamp", "Full Name", "Email", "Link to your CV"],
      ["2026-07-01T10:00:00Z", "Ada Lovelace", "ada@example.test", "https://drive/ada"],
    ]);
    expect(capture).toHaveBeenCalledWith([
      "--json",
      "--no-input",
      "--enable-commands-exact",
      "sheets.get",
      "--readonly",
      "sheets",
      "get",
      "sheet-1",
      "A:ZZ",
    ]);
  });

  it("passes the configured account and range and unwraps enveloped results", async () => {
    const capture = vi.fn(async () =>
      JSON.stringify({ result: { values: [["Timestamp"], [""]] } }),
    );

    await expect(
      readGogSheetRows("sheet-2", {
        capture,
        env: { GOG_ACCOUNT: "lab@example.test" },
        range: "Form Responses 1!A:D",
      }),
    ).resolves.toEqual([["Timestamp"], [""]]);
    expect(capture.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        "--account",
        "lab@example.test",
        "--readonly",
        "Form Responses 1!A:D",
      ]),
    );
  });

  it("rejects an empty spreadsheet id and non-JSON gog output", async () => {
    const capture = vi.fn(async () => "not json");

    await expect(readGogSheetRows("  ", { capture, env: {} })).rejects.toThrow(
      "gog sheets get requires a spreadsheet id",
    );
    await expect(readGogSheetRows("sheet-3", { capture, env: {} })).rejects.toThrow(
      "gog sheets get did not return JSON output",
    );
    await expect(
      readGogSheetRows("sheet-3", { capture: async () => "", env: {} }),
    ).resolves.toEqual([]);
  });
});
