import { apiRoutes } from "@adminbot/api-contracts";
import { describe, expect, it, vi } from "vitest";
import { createReimbursementRoutes, type ReimbursementApplication } from "./reimbursement-routes.js";

describe("reimbursement routes", () => {
  it("exposes public versioned routes and forwards only the transport address", async () => {
    const application = fakeApplication();
    const route = createReimbursementRoutes(application)[0];
    const body = { message: "synthetic claim" };
    const result = await route?.handle({
      body,
      pathname: apiRoutes.converseReimbursement.build(),
      query: new URLSearchParams(),
      remoteAddress: "127.0.0.1",
      sessionToken: "must-not-be-forwarded",
    });

    expect(route?.maximumBodyBytes).toBe(49 * 1_024 * 1_024);
    expect(result?.status).toBe(200);
    expect(application.converse).toHaveBeenCalledWith(body, { remoteAddress: "127.0.0.1" });
  });

  it("converts durable rate-limit timing into a Retry-After header", async () => {
    const application = fakeApplication();
    application.generate.mockResolvedValueOnce({
      ok: false, status: 429, retryAfterSeconds: 37,
      body: { code: "rate_limited", message: "too many requests", retryable: true },
    });
    const route = createReimbursementRoutes(application)[1];
    const result = await route?.handle({
      body: {}, pathname: apiRoutes.generateReimbursementPacket.build(), query: new URLSearchParams(),
    });
    expect(result?.headers).toEqual({ "retry-after": "37" });
  });
});

function fakeApplication() {
  return {
    converse: vi.fn<ReimbursementApplication["converse"]>(async () => ({
      ok: true as const, status: 200 as const,
      body: { assistantMessage: "Review", draft: { expenses: [] }, missingFields: [], ready: false, receiptNames: [] },
    })),
    generate: vi.fn<ReimbursementApplication["generate"]>(async () => ({
      ok: true as const, status: 200 as const, body: { artifacts: [], warnings: [] },
    })),
  } satisfies ReimbursementApplication;
}
