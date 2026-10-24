// Reading the author-results snapshot for the paper sync, and saying when it cannot be trusted.
import { describe, expect, it } from "vitest";
import { gatherOpenReviewPaperEvidence } from "./openreview-paper-sync-sources.js";

const NOW = new Date("2026-10-24T08:55:00Z");

function snapshot(fetchedAt?: string) {
  return {
    ok: true,
    ...(fetchedAt ? { fetched_at: fetchedAt } : {}),
    submissions: [
      {
        id: "Acc111",
        title: "Accepted One",
        status: "accepted",
        venue_id: "ICLR.cc/2026/Conference",
      },
    ],
  };
}

describe("gathering the paper sync's evidence", () => {
  it("reads a fresh snapshot without a warning", async () => {
    const sources = await gatherOpenReviewPaperEvidence({
      snapshotPath: "/state/snapshot.json",
      readFile: async () => JSON.stringify(snapshot("2026-10-24T07:35:00Z")),
      now: () => NOW,
    });
    expect(sources.read).toEqual(["author_results"]);
    expect(sources.evidence).toHaveLength(1);
    expect(sources.warnings).toEqual([]);
  });

  it("prefers the snapshot the caller posts over the file", async () => {
    const sources = await gatherOpenReviewPaperEvidence(
      {
        snapshotPath: "/state/snapshot.json",
        readFile: async () => {
          throw new Error("must not be read");
        },
        now: () => NOW,
      },
      { author_results: snapshot("2026-10-24T07:35:00Z") },
    );
    expect(sources.evidence.map((item) => item.reference)).toEqual(["Acc111"]);
  });

  it("warns when the results cron has stopped refreshing the snapshot", async () => {
    const old = await gatherOpenReviewPaperEvidence(
      { now: () => NOW },
      { author_results: snapshot("2026-10-23T07:35:00Z") },
    );
    expect(old.read).toEqual(["author_results"]);
    expect(old.warnings).toEqual([expect.stringContaining("25 hours old")]);
    const undated = await gatherOpenReviewPaperEvidence(
      { now: () => NOW },
      { author_results: snapshot() },
    );
    expect(undated.warnings).toEqual([expect.stringContaining("age is unknown")]);
  });

  it("reads nothing, and says why, when the snapshot is missing", async () => {
    const missing = await gatherOpenReviewPaperEvidence({
      snapshotPath: "/state/snapshot.json",
      readFile: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    expect(missing).toEqual({
      evidence: [],
      read: [],
      warnings: [expect.stringContaining("not found")],
    });
    expect((await gatherOpenReviewPaperEvidence({})).read).toEqual([]);
  });
});
