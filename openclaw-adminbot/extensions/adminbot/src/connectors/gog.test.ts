import fs from "node:fs";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { AdminBotEmailPayload, AdminBotStoredProposal } from "../contracts/actions.js";
import { emailPayloadSchema } from "../contracts/tool-schemas.js";
import { AdminBotService } from "../kernel/service.js";
import { renderEmailBodyHtml } from "./email-html.js";
import { createGogAdminBotExecutor, readGogSheetRows } from "./gog.js";

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
      "--body-html",
      "<p>The draft was approved.</p>",
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

  // Inviting people to a standing meeting must not uninvite everyone already on it, which is what
  // --attendees (replace) would do. The add path also passes nothing else, so an invite can never
  // move the event or rewrite its title as a side effect.
  it("adds attendees to an existing event without replacing the guest list", async () => {
    const run = vi.fn(async () => {});
    const executor = createGogAdminBotExecutor({ run });

    await executor.execute(
      proposal("calendar.add_attendees", {
        calendar_id: "jinesis.lab@gmail.com",
        event_id: "event-9",
        attendees: ["ada@cs.toronto.edu", "mei@cs.toronto.edu"],
      }),
    );

    const args = run.mock.calls[0]?.[0] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        "calendar.update",
        "jinesis.lab@gmail.com",
        "event-9",
        "--add-attendee",
        "ada@cs.toronto.edu,mei@cs.toronto.edu",
        "--send-updates",
        "all",
      ]),
    );
    expect(args).not.toContain("--attendees");
    expect(args).not.toContain("--summary");
    expect(args).not.toContain("--from");
  });

  it("refuses an add-attendees action that names nobody", async () => {
    const executor = createGogAdminBotExecutor({ run: vi.fn(async () => {}) });
    await expect(
      executor.execute(proposal("calendar.add_attendees", { event_id: "event-9", attendees: [] })),
    ).rejects.toThrow(/attendees is required/u);
  });

  // The wrap the operator sees mid-paragraph comes from delivering text/plain, so an approved
  // payload may carry an html alternative. It is optional and additive: the flag appears only when
  // the payload has one, immediately after --body and before the recipient flags, and the payload
  // that predates the field still builds the exact command it used to.
  it("passes an html alternative through on the send and the draft path", async () => {
    const run = vi.fn(async () => {});
    const executor = createGogAdminBotExecutor({ run });
    const payload = {
      to: "one@example.com",
      subject: "Lab update",
      body: "The draft was approved.",
      body_html: "<p>The draft was approved.</p>",
      cc: "cc@example.com",
    } satisfies AdminBotEmailPayload;

    await executor.execute(proposal("email.send", payload));
    await executor.execute(proposal("email.draft", payload));

    for (const call of run.mock.calls) {
      const args = call[0] as string[];
      expect(args.slice(args.indexOf("--body"))).toEqual([
        "--body",
        "The draft was approved.",
        "--body-html",
        "<p>The draft was approved.</p>",
        "--cc",
        "cc@example.com",
      ]);
    }
    expect(run.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining(["gmail.drafts.create", "drafts", "create"]),
    );

    // Same payload minus the field: the connector renders the alternative itself rather than
    // falling back to text/plain, because the agent's proposal pipeline never supplies one and a
    // text-only send is exactly what wraps mid-paragraph.
    const { body_html: _omitted, ...legacy } = payload;
    run.mockClear();
    await executor.execute(proposal("email.send", legacy));
    const rendered = run.mock.calls[0]?.[0] as string[];
    expect(
      rendered.slice(rendered.indexOf("--body-html"), rendered.indexOf("--body-html") + 2),
    ).toEqual(["--body-html", renderEmailBodyHtml(legacy.body)]);

    // The schema round-trips both shapes, and still refuses a non-string html body.
    expect(Value.Check(emailPayloadSchema, payload)).toBe(true);
    expect(Value.Check(emailPayloadSchema, legacy)).toBe(true);
    expect(Value.Check(emailPayloadSchema, { ...payload, body_html: 12 })).toBe(false);
    // An email-channel member nudge carries a discriminator alongside the email fields, so the
    // schema must not reject what the connector already sends.
    expect(Value.Check(emailPayloadSchema, { ...legacy, channel: "email" })).toBe(true);
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

  it("maps email-channel member nudges to gmail send and declines the Slack-channel half", async () => {
    const run = vi.fn(async () => {});
    const executor = createGogAdminBotExecutor({ run });

    await expect(
      executor.execute(
        proposal("member_nudge.send", {
          channel: "email",
          to: "person@example.test",
          subject: "Deadline reminder",
          body: "Please submit your draft by Friday.",
        }),
      ),
    ).resolves.toEqual({ handled: true });
    expect(run).toHaveBeenCalledWith(
      expect.arrayContaining(["--to", "person@example.test", "--subject", "Deadline reminder"]),
    );

    await expect(
      executor.execute(
        proposal("member_nudge.send", {
          channel: "slack",
          tool: "message",
          action: "send",
          target: "U123",
          message: "hi",
        }),
      ),
    ).resolves.toEqual({ handled: false });
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

describe("logistics.send_signed_document", () => {
  it("writes the attachment to a file and hands gog its path", async () => {
    const calls: string[][] = [];
    const executor = createGogAdminBotExecutor({ run: async (args) => void calls.push(args) });
    const result = await executor.execute({
      id: "act_1",
      type: "logistics.send_signed_document",
      summary: "Email the signed document",
      status: "approved",
      risk_tier: "T1",
      created_at: "2026-08-19T00:00:00.000Z",
      payload_hash: "hash",
      approval_requirement: { requires_approval: false, approver_roles: [], min_approvals: 0 },
      approvals: [],
      proposed_payload: {
        to: "ada@cs.toronto.edu",
        subject: "Signed: Visa letter",
        body: "Your document has been signed.",
        attachments: [
          {
            name: "form signed.pdf",
            content_type: "application/pdf",
            data_base64: Buffer.from("%PDF-1.4 signed").toString("base64"),
          },
        ],
      },
    } as never);

    expect(result).toEqual({ handled: true });
    const [args] = calls;
    expect(args).toContain("send");
    expect(args).toContain("ada@cs.toronto.edu");
    const attachAt = args.indexOf("--attach");
    expect(attachAt).toBeGreaterThan(-1);
    // A real path, with the spaces in the member's file name preserved and the directory ours.
    expect(args[attachAt + 1]).toMatch(/adminbot-signed-.*form signed\.pdf$/u);
  });

  it("takes the scratch copy of somebody's signed paperwork away again", async () => {
    let attached = "";
    const executor = createGogAdminBotExecutor({
      run: async (args) => {
        attached = args[args.indexOf("--attach") + 1] ?? "";
      },
    });
    await executor.execute({
      id: "act_1",
      type: "logistics.send_signed_document",
      summary: "Email the signed document",
      status: "approved",
      risk_tier: "T1",
      created_at: "2026-08-19T00:00:00.000Z",
      payload_hash: "hash",
      approval_requirement: { requires_approval: false, approver_roles: [], min_approvals: 0 },
      approvals: [],
      proposed_payload: {
        to: "ada@cs.toronto.edu",
        subject: "Signed",
        body: "Attached.",
        attachments: [{ name: "signed.pdf", data_base64: Buffer.from("x").toString("base64") }],
      },
    } as never);
    expect(attached).toBeTruthy();
    expect(fs.existsSync(attached)).toBe(false);
  });

  it("refuses to send an email that was supposed to carry a document and does not", async () => {
    const executor = createGogAdminBotExecutor({ run: async () => {} });
    await expect(
      executor.execute({
        id: "act_1",
        type: "logistics.send_signed_document",
        summary: "Email the signed document",
        status: "approved",
        risk_tier: "T1",
        created_at: "2026-08-19T00:00:00.000Z",
        payload_hash: "hash",
        approval_requirement: { requires_approval: false, approver_roles: [], min_approvals: 0 },
        approvals: [],
        proposed_payload: { to: "ada@cs.toronto.edu", subject: "Signed", body: "Attached." },
      } as never),
    ).rejects.toThrow(/attachment/u);
  });
});

describe("sheet.update_cells", () => {
  it("writes every edited range in one batch-update, restricted to that exact command", async () => {
    const run = vi.fn(async () => {});
    const executor = createGogAdminBotExecutor({ run });

    await expect(
      executor.execute(
        proposal("sheet.update_cells", {
          spreadsheet_id: "1ZqdaRze",
          updates: [
            { range: "Full Slack Member List!S169", values: [["coauthor-minor"]] },
            { range: "Full Slack Member List!R170", values: [["3"]] },
          ],
          // Carried for the approval card, so it can show what is being overwritten. Never sent.
          before: [{ range: "Full Slack Member List!S169", values: [["alumni"]] }],
        }),
      ),
    ).resolves.toEqual({ handled: true });

    expect(run).toHaveBeenCalledWith([
      "--json",
      "--no-input",
      "--enable-commands-exact",
      "sheets.batch-update",
      "sheets",
      "batch-update",
      "--data-json",
      JSON.stringify([
        { range: "Full Slack Member List!S169", values: [["coauthor-minor"]] },
        { range: "Full Slack Member List!R170", values: [["3"]] },
      ]),
      "--input",
      "RAW",
      "1ZqdaRze",
    ]);
  });

  // USER_ENTERED would turn this into a live formula reaching into whatever sheet the text names.
  it("writes a leading-equals cell as text rather than as a formula", async () => {
    const calls: string[][] = [];
    const executor = createGogAdminBotExecutor({ run: async (args) => void calls.push(args) });

    await executor.execute(
      proposal("sheet.update_cells", {
        spreadsheet_id: "1ZqdaRze",
        updates: [{ range: "Sheet1!A1", values: [['=IMPORTRANGE("other","A1")']] }],
      }),
    );

    expect(calls[0]).toContain("RAW");
    expect(calls[0]).not.toContain("USER_ENTERED");
  });

  it("refuses an empty or malformed edit rather than calling gog", async () => {
    const run = vi.fn(async () => {});
    const executor = createGogAdminBotExecutor({ run });

    await expect(
      executor.execute(proposal("sheet.update_cells", { spreadsheet_id: "1ZqdaRze", updates: [] })),
    ).rejects.toThrow(/non-empty/u);

    await expect(
      executor.execute(
        proposal("sheet.update_cells", {
          spreadsheet_id: "1ZqdaRze",
          updates: [{ range: "Sheet1!A1", values: "not a matrix" }],
        }),
      ),
    ).rejects.toThrow(/row matrix/u);

    await expect(
      executor.execute(
        proposal("sheet.update_cells", {
          spreadsheet_id: "1ZqdaRze",
          updates: [{ range: "   ", values: [["x"]] }],
        }),
      ),
    ).rejects.toThrow(/range is required/u);

    expect(run).not.toHaveBeenCalled();
  });
});
