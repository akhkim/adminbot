import { describe, expect, it, vi } from "vitest";
import type { AdminBotLogisticsRequest } from "../contracts/actions.js";
import type { AdminBotService } from "../kernel/service.js";
import type { DocPrepProbe } from "../workflows/logistics/doc-prep-link.js";
import { resolveCallSheetConfig } from "./call-sheet-config.js";
import type { CallSheetSource } from "./call-sheet-config.js";
import { previewCallSheetPush, proposeCallSheetPush } from "./server.call-sheet.js";

const DOC = "https://docs.google.com/document/d/1DvlfAFPHplL5kGH9zjpOFKAx2D3cltnltzQdpIY43i0/edit";

const GRID: string[][] = [
  ["", "Note: additional whatsapp call requests with Zhijing.", "", "", "", "", "", "", ""],
  [
    "Name",
    "What topics do you want to go through?",
    "Your current city (or time range flexible for you tto receive calls)",
    "Doc prep of all the questions (before the call)",
    'Have you messaged Zhijing a "hello" on whatsapp?',
    "min_length of the call possible",
    "until when is it ok to make this call?",
    "time you entered this call request",
    "Zhijing's actual meeting with you",
  ],
  [
    "Gopal",
    "Future research plans",
    "IST time zone",
    "TODO",
    "",
    "15 min",
    "2026-09-15",
    "2026-09-03",
    "",
  ],
  ["", "", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", "", ""],
  ["Finished calls", "", "", "", "", "", "", "", ""],
];

function source(rows: string[][] = GRID): CallSheetSource {
  return {
    spreadsheetId: "1ZqdaRze",
    tab: "Whatsapp call requests",
    read: vi.fn(async () => rows),
  };
}

function request(overrides: Partial<AdminBotLogisticsRequest> = {}): AdminBotLogisticsRequest {
  return {
    id: "req-1",
    kind: "book_meeting",
    member_id: "mem-1",
    member_name: "Jiarui",
    status: "submitted",
    submitted_at: "2026-09-09T08:15:00.000Z",
    updated_at: "2026-09-09T08:15:00.000Z",
    meetings: [
      {
        purpose: "Research plans for the semester",
        city: "Boston",
        length_minutes: 30,
        latest_ok_date: "2026-09-30",
        whatsapp_hello: true,
        doc_prep_url: DOC,
      },
    ],
    ...overrides,
  } as AdminBotLogisticsRequest;
}

/** Just enough service to list requests and record what gets proposed. */
function fakeService(requests: AdminBotLogisticsRequest[]) {
  const proposals: { type: string; summary: string; payload: unknown }[] = [];
  const service = {
    listLogisticsRequests: () => ({
      ok: true as const,
      status: 200,
      payload: { requests },
    }),
    createProposal(proposal: { type: string; summary: string; proposed_payload?: unknown }) {
      proposals.push({
        type: proposal.type,
        summary: proposal.summary,
        payload: proposal.proposed_payload,
      });
      return {
        ok: true as const,
        status: 200,
        payload: { id: `act_${proposals.length}`, status: "pending" },
      };
    },
  };
  return { service: service as unknown as AdminBotService, proposals };
}

const opens: DocPrepProbe = vi.fn(async () => 200);
const restricted: DocPrepProbe = vi.fn(async () => 401);

describe("resolveCallSheetConfig", () => {
  it("defaults to the call tab of the lab workbook", () => {
    expect(resolveCallSheetConfig({})).toMatchObject({
      spreadsheetId: "1ZqdaRzev6fFHxGbaAn_NDAPgv-Wi-hklHrT5jB68m68",
      gid: 1633153118,
    });
  });

  it("reads the id and gid out of a pasted URL", () => {
    expect(
      resolveCallSheetConfig({
        ADMINBOT_CALL_SHEET_URL:
          "https://docs.google.com/spreadsheets/d/OTHER_BOOK/edit?gid=42#gid=42",
      }),
    ).toMatchObject({ spreadsheetId: "OTHER_BOOK", gid: 42 });
  });

  it("does not carry the lab's gid onto a different workbook", () => {
    expect(resolveCallSheetConfig({ ADMINBOT_CALL_SHEET_ID: "OTHER_BOOK" }).gid).toBeUndefined();
  });
});

describe("previewCallSheetPush", () => {
  it("reports what would be written without proposing anything", async () => {
    const { service, proposals } = fakeService([request()]);
    const result = await previewCallSheetPush(service, source(), {
      probe: opens,
    });
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.placed).toEqual([{ request_id: "req-1", member_name: "Jiarui", sheet_row: 4 }]);
    expect(proposals).toEqual([]);
    expect(result.proposal).toBeUndefined();
  });
});

describe("proposeCallSheetPush", () => {
  it("raises one sheet.update_cells proposal rather than writing", async () => {
    const { service, proposals } = fakeService([request()]);
    const result = await proposeCallSheetPush(service, source(), "andrew", {
      probe: opens,
    });
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.type).toBe("sheet.update_cells");
    expect(proposals[0]?.summary).toContain("Jiarui");
    expect(result.proposal).toMatchObject({ status: "pending" });
  });

  it("writes the member's answers into the columns their headings name", async () => {
    const { service, proposals } = fakeService([request()]);
    await proposeCallSheetPush(service, source(), "andrew", { probe: opens });
    const payload = proposals[0]?.payload as {
      updates: { range: string; values: string[][] }[];
    };
    const byRange = new Map(payload.updates.map((u) => [u.range, u.values[0]?.[0]]));
    expect(byRange.get("'Whatsapp call requests'!A4")).toBe("Jiarui");
    expect(byRange.get("'Whatsapp call requests'!C4")).toBe("Boston");
    expect(byRange.get("'Whatsapp call requests'!D4")).toBe(DOC);
    expect(byRange.get("'Whatsapp call requests'!E4")).toBe("Yes");
    expect(byRange.get("'Whatsapp call requests'!F4")).toBe("30 min");
    expect(byRange.get("'Whatsapp call requests'!G4")).toBe("2026-09-30");
    expect(byRange.get("'Whatsapp call requests'!H4")).toBe("2026-09-09");
  });

  // The feature, stated as a test: an unshared doc does not reach her sheet.
  it("proposes nothing when the doc prep link is not openable, and says why", async () => {
    const { service, proposals } = fakeService([request()]);
    const result = await proposeCallSheetPush(service, source(), "andrew", {
      probe: restricted,
    });
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(proposals).toEqual([]);
    expect(result.placed).toEqual([]);
    expect(result.skipped[0]).toMatchObject({
      reason: "doc_prep_invalid",
      detail: "restricted",
    });
    expect(result.candidates[0]?.message).toContain("anyone-with-the-link");
  });

  it("never probes, and never queues, a settled request", async () => {
    const probe = vi.fn(async () => 200);
    const { service, proposals } = fakeService([
      request({ status: "completed" }),
      request({ id: "req-2", status: "withdrawn" }),
      request({ id: "req-3", status: "declined" }),
    ]);
    const result = await proposeCallSheetPush(service, source(), "andrew", {
      probe,
    });
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.candidates).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
    expect(proposals).toEqual([]);
  });

  it("ignores requests that are not meeting bookings", async () => {
    const { service } = fakeService([request({ kind: "document_signature", meetings: undefined })]);
    const result = await proposeCallSheetPush(service, source(), "andrew", {
      probe: opens,
    });
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.candidates).toEqual([]);
  });

  it("can be narrowed to one request", async () => {
    const { service } = fakeService([request(), request({ id: "req-2", member_name: "Sekai" })]);
    const result = await proposeCallSheetPush(service, source(), "andrew", {
      probe: opens,
      request_ids: ["req-2"],
    });
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.placed).toEqual([{ request_id: "req-2", member_name: "Sekai", sheet_row: 4 }]);
  });

  it("falls back to the request's own timestamp when the row carries none", async () => {
    const { service, proposals } = fakeService([
      request({
        meetings: [{ purpose: "Topic", doc_prep_url: DOC }],
        submitted_at: "2026-07-01T00:00:00.000Z",
      }),
    ]);
    await proposeCallSheetPush(service, source(), "andrew", { probe: opens });
    const payload = proposals[0]?.payload as {
      updates: { range: string; values: string[][] }[];
    };
    expect(payload.updates).toContainEqual({
      range: "'Whatsapp call requests'!H4",
      values: [["2026-07-01"]],
    });
  });

  // A read failure must not look like "nothing to push".
  it("surfaces a failed sheet read as an error", async () => {
    const { service } = fakeService([request()]);
    const broken: CallSheetSource = {
      spreadsheetId: "1ZqdaRze",
      tab: "Whatsapp call requests",
      read: vi.fn(async () => {
        throw new Error("gog command failed: 403");
      }),
    };
    const result = await proposeCallSheetPush(service, broken, "andrew", {
      probe: opens,
    });
    expect(result).toMatchObject({
      error: {
        status: 502,
        message: expect.stringContaining("could not read the call sheet"),
      },
    });
  });

  it("refuses a tab that is not the call sheet rather than writing into it", async () => {
    const { service } = fakeService([request()]);
    const result = await proposeCallSheetPush(service, source([["Title", "Venue"]]), "andrew", {
      probe: opens,
    });
    expect(result).toMatchObject({
      error: {
        status: 502,
        message: expect.stringContaining("no call-request heading row"),
      },
    });
  });
});
