import { describe, expect, it, vi } from "vitest";
import { createOpenReviewForumProbe } from "./openreview-notes.js";

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
