import { describe, expect, it, vi } from "vitest";
import {
  AdminBotDeadlineProposalStore,
  type DeadlineProposalInput,
  validateDeadlineProposal,
} from "./deadline-proposals.ts";

function input(overrides: Partial<DeadlineProposalInput> = {}): DeadlineProposalInput {
  return {
    name: "Example Workshop",
    parentConference: "EMNLP",
    parentYear: "2026",
    entryType: "workshop",
    deadlineDate: "2026-09-14",
    deadlineTime: "23:59",
    timezone: "Etc/GMT+12",
    homepageUrl: "https://example.org/workshop",
    cfpUrl: "https://example.org/cfp",
    openReviewUrl: "https://openreview.net/group?id=example",
    note: "Please verify the archival route.",
    ...overrides,
  };
}

describe("deadline proposal validation", () => {
  it("accepts AoE and trims the submitted fields", () => {
    expect(validateDeadlineProposal(input({ name: "  Example   Workshop  " }))).toMatchObject({
      ok: true,
      value: { name: "Example Workshop", timezone: "Etc/GMT+12" },
    });
  });

  it("stores the human-readable AoE label as its IANA value", () => {
    expect(
      validateDeadlineProposal(input({ timezone: "Anywhere on Earth (AoE, UTC−12)" })),
    ).toMatchObject({
      ok: true,
      value: { timezone: "Etc/GMT+12" },
    });
  });

  it("rejects invalid dates, time zones, and URLs", () => {
    expect(
      validateDeadlineProposal(
        input({
          deadlineDate: "2026-02-30",
          deadlineTime: "25:00",
          timezone: "Zurich-ish",
          homepageUrl: "not a URL",
          cfpUrl: "javascript:alert(1)",
          openReviewUrl: "not a URL",
        }),
      ),
    ).toMatchObject({
      ok: false,
      errors: {
        deadlineDate: expect.any(String),
        deadlineTime: expect.any(String),
        timezone: expect.any(String),
        homepageUrl: expect.any(String),
        cfpUrl: expect.any(String),
        openReviewUrl: expect.any(String),
      },
    });
  });
});

describe("AdminBot deadline proposal store", () => {
  it("submits through the authenticated API with a stable idempotency key", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "dlp-1",
            status: "pending",
            deadline: input(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
    );
    const store = new AdminBotDeadlineProposalStore(
      () => "https://admin.example",
      () => "session-token",
      fetchImpl as typeof fetch,
    );

    await store.submit(input(), "submit-key-1");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://admin.example/deadline-proposals",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer session-token",
          "Idempotency-Key": "submit-key-1",
        }),
      }),
    );
  });

  it("does not attempt an authenticated write without a member session", async () => {
    const fetchImpl = vi.fn();
    const store = new AdminBotDeadlineProposalStore(
      () => "https://admin.example",
      () => undefined,
      fetchImpl as typeof fetch,
    );
    await expect(store.submit(input(), "submit-key-1")).rejects.toThrow("Sign in");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
