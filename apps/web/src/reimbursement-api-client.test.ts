import { apiRoutes } from "@adminbot/api-contracts";
import { describe, expect, it, vi } from "vitest";
import { encodeReceipt, ReimbursementApiClient } from "./reimbursement-api-client.js";

describe("ReimbursementApiClient", () => {
  it("uses the centralized versioned route and includes browser credentials", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      assistantMessage: "Review", draft: { expenses: [] }, missingFields: [], ready: false, receiptNames: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new ReimbursementApiClient("http://127.0.0.1:8765", fetch);
    await client.converse({ message: "synthetic claim" });
    expect(fetch).toHaveBeenCalledWith(
      new URL(`http://127.0.0.1:8765${apiRoutes.converseReimbursement.build()}`),
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("encodes only supported, bounded receipt files", async () => {
    const receipt = new File(["%PDF-synthetic"], "receipt.pdf", { type: "application/pdf" });
    await expect(encodeReceipt(receipt)).resolves.toMatchObject({
      filename: "receipt.pdf", mediaType: "application/pdf",
    });
    await expect(encodeReceipt(new File(["x"], "receipt.txt", { type: "text/plain" })))
      .rejects.toThrow("PDF, PNG, or JPEG");
  });
});
