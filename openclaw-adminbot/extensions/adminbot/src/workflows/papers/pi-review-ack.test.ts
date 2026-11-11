// "Reviewed" on a My Desk row: which rows can be put away, and that a changed row comes back.
import { describe, expect, it } from "vitest";
import { applyPiReviewAcks, isPiReviewRowAckable, piReviewAckKey } from "./pi-review-ack.js";
import type { PiReviewRow } from "./pi-review.js";

function row(fields: Partial<PiReviewRow> = {}): PiReviewRow {
  return {
    paper_id: "p1",
    title: "Causal Garden Planning",
    authors: ["Ada"],
    package_complete: true,
    ...fields,
  } as PiReviewRow;
}

const openreview = { status: "accepted", stage: "camera_ready", note: "Camera-ready due" };

describe("pi review acknowledgements", () => {
  it("never puts away a decision only she can make", () => {
    expect(isPiReviewRowAckable(row({ category: "arxiv_release" }))).toBe(false);
    expect(isPiReviewRowAckable(row({ feedback: {} as never }))).toBe(false);
    expect(isPiReviewRowAckable(row({ impact: {} as never }))).toBe(false);
    expect(isPiReviewRowAckable(row({ category: "camera_ready", openreview } as never))).toBe(true);
    expect(isPiReviewRowAckable(row({ category: "arxiv_release", openreview } as never))).toBe(
      true,
    );
  });

  it("moves an acknowledged row to history and keeps its key for undo", () => {
    const seen = row({ category: "camera_ready", openreview } as never);
    const other = row({
      paper_id: "p2",
      category: "proofreading",
      proofreading: { venue: "ICML", note: "" },
    } as never);
    const gate = row({ paper_id: "p3", category: "arxiv_release" });
    const { open, reviewed } = applyPiReviewAcks(
      [seen, other, gate],
      new Set([piReviewAckKey(seen)]),
    );
    expect(reviewed).toEqual([
      { ...seen, ack_key: piReviewAckKey(seen), history_reason: "reviewed" },
    ]);
    expect(open.map((r) => [r.paper_id, r.ack_key])).toEqual([
      ["p2", piReviewAckKey(other)],
      ["p3", undefined],
    ]);
  });

  it("brings a row back when its state changes", () => {
    const before = row({ category: "camera_ready", openreview } as never);
    const after = row({
      category: "camera_ready",
      openreview: { ...openreview, stage: "published" },
    } as never);
    const { open } = applyPiReviewAcks([after], new Set([piReviewAckKey(before)]));
    expect(open).toHaveLength(1);
  });
});
