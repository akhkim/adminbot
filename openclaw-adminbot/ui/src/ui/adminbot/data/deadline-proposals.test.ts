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
  it.each([
    ["old HTML page", () => new Response("<html>Deadlines</html>")],
    ["missing route", () => new Response("Not found", { status: 404 })],
    ["null payload", () => new Response("null")],
  ])("falls back to the legacy dataset for a %s", async (_name, response) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: "legacy" }] })));
    const store = new AdminBotDeadlineProposalStore(
      () => "https://admin.example",
      () => undefined,
      fetchImpl,
    );
    await expect(store.listPublished()).resolves.toEqual([{ id: "legacy" }]);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://admin.example/deadlines",
      "https://admin.example/deadlines/venues.json",
    ]);
  });

  it("keeps an empty current dataset without falling back", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] })));
    const store = new AdminBotDeadlineProposalStore(
      () => "https://admin.example",
      () => undefined,
      fetchImpl,
    );
    await expect(store.listPublished()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports a malformed dataset instead of silently clearing the board", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response("null"));
    const store = new AdminBotDeadlineProposalStore(
      () => "https://admin.example",
      () => undefined,
      fetchImpl,
    );
    await expect(store.listPublished()).rejects.toThrow("invalid dataset");
  });

  it.each([401, 403, 500])("does not hide HTTP %s with a legacy fallback", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status }));
    const store = new AdminBotDeadlineProposalStore(
      () => "https://admin.example",
      () => undefined,
      fetchImpl,
    );
    await expect(store.listPublished()).rejects.toThrow(`Deadline service returned ${status}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("loads public deadline data without a session", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [{ id: "example" }] }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    const store = new AdminBotDeadlineProposalStore(
      () => "https://admin.example",
      () => undefined,
      fetchImpl as typeof fetch,
    );
    await expect(store.listPublished()).resolves.toEqual([{ id: "example" }]);
    expect(fetchImpl).toHaveBeenCalledWith("https://admin.example/deadlines", {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  });

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

it("submits a visitor request without credentials and surfaces rate-limit failures", async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: "received" }), { status: 202 }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "Too many deadline proposals. Please try again later." },
        }),
        { status: 429 },
      ),
    );
  const store = new AdminBotDeadlineProposalStore(
    () => "https://admin.example",
    () => "unused-session",
    fetchImpl,
  );
  await store.submitPublic(input(), "public-key", { name: "Taylor", email: "taylor@example.org" });
  expect(fetchImpl).toHaveBeenCalledWith(
    "https://admin.example/public/deadline-proposals",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        ...input(),
        submitter_contact: { name: "Taylor", email: "taylor@example.org" },
      }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": "public-key",
      },
    }),
  );
  await expect(
    store.submitPublic(input(), "public-key", { name: "Taylor", email: "taylor@example.org" }),
  ).rejects.toThrow("Too many deadline proposals");
});
