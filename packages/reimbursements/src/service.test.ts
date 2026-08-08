import { describe, expect, it, vi } from "vitest";
import type { TransactionBoundary } from "@adminbot/ports";
import { ReimbursementService } from "./service.js";
import type { ReimbursementRuntime } from "./types.js";

const COMPLETE_DRAFT = {
  claimantName: "Synthetic Claimant",
  claimantEmail: "claimant@example.com",
  claimantAddress: "1 Example Street",
  claimantTitle: "Researcher",
  tripTitle: "Systems Workshop",
  tripDates: "2026-07-08 to 2026-07-10",
  tripLocation: "Montreal, Canada",
  purpose: "Present synthetic research",
  currency: "CAD",
  expenses: [
    {
      date: "2026-07-08",
      description: "Train to workshop",
      category: "rail",
      amount: 40,
      currency: "CAD",
    },
  ],
} as const;

describe("ReimbursementService", () => {
  it("validates receipt content and returns a derived, reviewable draft", async () => {
    const runtime = fakeRuntime({
      claimantName: "Synthetic Claimant",
      expenses: [
        { date: "2026-07-10", description: "Hotel", category: "hotel", amount: 100, currency: "CAD" },
        { date: "2026-07-08", description: "Rail", category: "rail", amount: 40, currency: "CAD" },
      ],
    });
    const service = createService(runtime);
    const result = await service.converse({
      message: "Here is my receipt",
      receipts: [
        {
          filename: "receipt.pdf",
          mediaType: "application/pdf",
          dataBase64: Buffer.from("%PDF-synthetic").toString("base64"),
        },
      ],
    }, { remoteAddress: "127.0.0.1" });

    expect(result).toMatchObject({
      ok: true,
      body: {
        draft: { currency: "CAD", tripDates: "2026-07-08 to 2026-07-10" },
        receiptNames: ["receipt.pdf"],
        ready: false,
      },
    });
    expect(runtime.reason).toHaveBeenCalledWith(expect.objectContaining({
      receipts: [expect.objectContaining({ filename: "receipt.pdf" })],
    }));
  });

  it("fails closed for spoofed receipt media and unsupported input fields", async () => {
    const service = createService(fakeRuntime(COMPLETE_DRAFT));
    await expect(service.converse({ message: "test", actorRole: "administrator" }))
      .resolves.toMatchObject({ ok: false, status: 400 });
    await expect(service.converse({
      message: "test",
      receipts: [{
        filename: "receipt.pdf",
        mediaType: "application/pdf",
        dataBase64: Buffer.from("not a pdf").toString("base64"),
      }],
    })).resolves.toMatchObject({ ok: false, status: 400 });
  });

  it("generates exactly two local artifacts and warns about mixed currencies", async () => {
    const runtime = fakeRuntime(COMPLETE_DRAFT);
    const service = createService(runtime);
    const result = await service.generate({
      packId: "waterloo_travel_v1",
      draft: {
        ...COMPLETE_DRAFT,
        expenses: [
          ...COMPLETE_DRAFT.expenses,
          { date: "2026-07-09", description: "Hotel", category: "hotel", amount: 90, currency: "USD" },
        ],
      },
    });

    expect(result).toMatchObject({
      ok: true,
      body: { artifacts: [{ filename: "expense.xlsx" }, { filename: "trip.docx" }] },
    });
    if (result.ok && "warnings" in result.body) {
      expect(result.body.warnings[0]).toContain("multiple currencies");
    }
  });

  it("does not call dependencies for incomplete packets", async () => {
    const runtime = fakeRuntime({ expenses: [] });
    const service = createService(runtime);
    await expect(service.generate({ packId: "waterloo_travel_v1", draft: { expenses: [] } }))
      .resolves.toMatchObject({ ok: false, status: 400, body: { code: "payload_invalid" } });
    expect(runtime.generate).not.toHaveBeenCalled();
  });

  it("maps local dependency failures to a redacted availability error", async () => {
    const runtime = fakeRuntime(COMPLETE_DRAFT);
    runtime.reason.mockRejectedValueOnce(new Error("secret host detail"));
    const service = createService(runtime);
    await expect(service.converse({ message: "start" })).resolves.toMatchObject({
      ok: false,
      status: 503,
      body: { code: "dependency_unavailable", message: expect.not.stringContaining("secret") },
    });
  });
});

function fakeRuntime(draft: unknown) {
  return {
    reason: vi.fn(async () => ({ assistantMessage: "Review the extracted facts.", draft })),
    generate: vi.fn(async () => [
      { filename: "expense.xlsx", mediaType: "application/xlsx", dataBase64: "eA==" },
      { filename: "trip.docx", mediaType: "application/docx", dataBase64: "eA==" },
    ]),
  } as unknown as ReimbursementRuntime & {
    reason: ReturnType<typeof vi.fn>;
    generate: ReturnType<typeof vi.fn>;
  };
}

function createService(runtime: ReimbursementRuntime): ReimbursementService {
  const unit = {
    rateLimits: { consume: vi.fn(async () => undefined) },
  };
  const transactions = {
    read: vi.fn(),
    write: async (work: (value: typeof unit) => Promise<unknown>) => work(unit),
  } as unknown as TransactionBoundary;
  return new ReimbursementService({ transactions, runtime, keySecret: "k".repeat(32) });
}
