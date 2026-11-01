import { describe, expect, it, vi } from "vitest";
import { createOpenReviewForumProbe, createOpenReviewNotesReader } from "./openreview-notes.js";

describe("OpenReview submission identity", () => {
  it("queries the submission id, not a reply, and reads explicit ARR history", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            notes: [
              {
                id: "Paper123",
                forum: "Paper123",
                content: {
                  title: { value: "Renamed paper" },
                  previous_url: { value: "https://openreview.net/forum?id=Older123" },
                },
              },
            ],
          }),
        ),
    );
    const probe = createOpenReviewForumProbe({ fetchImpl });
    await expect(probe("Paper123")).resolves.toEqual({
      status: "found",
      title: "Renamed paper",
      previous_submission_id: "Older123",
      identity_review: {
        status: "insufficient",
        examined: 0,
        abstract_excerpt: "",
        candidates: [],
      },
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://api2.openreview.net/notes?id=Paper123&limit=1",
    );
  });

  it.each([
    { notes: [] },
    {
      notes: [
        { id: "Reply123", forum: "Paper123", content: { title: { value: "Official Review" } } },
      ],
    },
    { notes: [{ id: "Paper123", replyto: "Parent123", content: { title: { value: "Comment" } } }] },
    { notes: [{ id: "Paper123", content: {} }] },
    { notes: "malformed" },
  ])("does not verify an unavailable or non-submission record: %j", async (body) => {
    const probe = createOpenReviewForumProbe({
      fetchImpl: async () => new Response(JSON.stringify(body)),
    });
    await expect(probe("Paper123")).resolves.toMatchObject({ status: "unreadable" });
  });

  it.each([
    "",
    "javascript:alert(1)",
    "https://example.org/forum?id=Older123",
    "https://openreview.net/forum?id=Paper123",
  ])("does not invent history from %s", async (previous) => {
    const probe = createOpenReviewForumProbe({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            notes: [
              {
                id: "Paper123",
                content: { title: "Paper title", previous_url: previous },
              },
            ],
          }),
        ),
    });
    await expect(probe("Paper123")).resolves.toMatchObject({
      status: "found",
      title: "Paper title",
    });
    expect(await probe("Paper123")).not.toHaveProperty("previous_submission_id");
  });

  it("keeps private/rate-limited records unreadable and rejects malformed ids without fetching", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 429 }));
    const probe = createOpenReviewForumProbe({ fetchImpl });
    await expect(probe("../bad")).resolves.toMatchObject({ status: "unreadable" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(probe("Paper123")).resolves.toMatchObject({ status: "unreadable" });
  });
});

describe("OpenReview venue reader", () => {
  it("logs in again when a kept token has expired, and only once", async () => {
    let logins = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/login")) {
        logins += 1;
        return new Response(JSON.stringify({ token: `token-${logins}` }));
      }
      const auth = new Headers(init?.headers).get("Authorization");
      if (auth === "Bearer token-1") {
        return new Response("{}", { status: 401 });
      }
      return new Response(
        JSON.stringify({ notes: [{ id: "Paper1", content: { title: { value: "A paper" } } }] }),
      );
    });
    const reader = createOpenReviewNotesReader({
      env: { OPENREVIEW_USERNAME: "reader@example.org", OPENREVIEW_PASSWORD: "synthetic" },
      fetchImpl,
    });
    await expect(reader?.("Venue.cc/2026/Conference")).resolves.toHaveLength(1);
    await expect(reader?.("Other.cc/2026/Conference")).resolves.toHaveLength(1);
    expect(logins).toBe(2);
  });

  it("still fails when a fresh token is refused too", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/login")
        ? new Response(JSON.stringify({ token: "token" }))
        : new Response("{}", { status: 401 }),
    );
    const reader = createOpenReviewNotesReader({
      env: { OPENREVIEW_USERNAME: "reader@example.org", OPENREVIEW_PASSWORD: "synthetic" },
      fetchImpl,
    });
    await expect(reader?.("Venue.cc/2026/Conference")).rejects.toThrow(
      "OpenReview returned 401 for Venue.cc/2026/Conference",
    );
    // login, refused page, one more login, refused again: no loop.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
