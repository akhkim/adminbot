import { describe, expect, it, vi } from "vitest";
import { createAdminBotReimbursementWorkflow } from "./reimbursement-workflow.js";

function modelResponse(value: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function completeDraft() {
  return {
    assistant_message: "Both forms are ready for review.",
    claimant_name: "Ada Lovelace",
    claimant_email: "ada@example.com",
    claimant_address: "1 King Street, Toronto, ON",
    claimant_title: "Researcher",
    personnel_number: null,
    travel_period: "2026-07-08 to 2026-07-10",
    purpose: "Attend the lab workshop.",
    currency: "CAD",
    other_currency: null,
    trip_title: "Montreal lab workshop",
    trip_dates: "2026-07-08 to 2026-07-10",
    trip_location: "Montreal, QC",
    expenses: [
      {
        receipt_number: "1",
        date: "2026-07-08",
        description: "Train to Montreal",
        category: "rail",
        amount: 125.5,
        currency: "CAD",
        region: "canada",
        tax_region: "other_canada",
        airfare_class: null,
        includes_tip: null,
      },
    ],
  };
}

describe("AdminBot reimbursement workflow", () => {
  it("keeps intake on the loopback model and marks a complete draft ready", async () => {
    const fetchImpl = vi.fn(async () => modelResponse(completeDraft()));
    const workflow = createAdminBotReimbursementWorkflow({
      formScriptPath: "/unused.py",
      fetchImpl: fetchImpl as typeof fetch,
      env: { ADMINBOT_LOCAL_BASE_URL: "http://127.0.0.1:8000/v1" },
    });

    const result = await workflow.converse({ message: "The trip was for our workshop." });

    expect(result.ready).toBe(true);
    expect(result.missing_fields).toEqual([]);
    expect(result.draft).not.toHaveProperty("assistant_message");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://127.0.0.1:8000/v1/chat/completions");
  });

  it("reports missing form fields without inventing them", async () => {
    const incomplete = completeDraft();
    incomplete.claimant_email = null;
    incomplete.expenses = [];
    const workflow = createAdminBotReimbursementWorkflow({
      formScriptPath: "/unused.py",
      fetchImpl: vi.fn(async () => modelResponse(incomplete)) as typeof fetch,
    });

    const result = await workflow.converse({ message: "Start my reimbursement." });

    expect(result.ready).toBe(false);
    expect(result.missing_fields).toEqual(["claimant_email", "expenses"]);
  });

  it("rejects uploaded data that is not actually a PDF before model use", async () => {
    const fetchImpl = vi.fn();
    const workflow = createAdminBotReimbursementWorkflow({
      formScriptPath: "/unused.py",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      workflow.converse({
        message: "Analyze this receipt.",
        receipts: [
          {
            name: "receipt.pdf",
            media_type: "application/pdf",
            data_base64: Buffer.from("not a pdf").toString("base64"),
          },
        ],
      }),
    ).rejects.toThrow("not a valid PDF");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
