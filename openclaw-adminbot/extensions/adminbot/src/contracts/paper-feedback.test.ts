import { describe, expect, it } from "vitest";
import { applyPaperSlotWrite } from "../workflows/papers/paper-slots.js";
import { paperFeedbackQueue } from "../workflows/papers/pi-review.js";
import { parsePaperFeedback } from "./paper-feedback.js";

describe("paper feedback requests", () => {
  const request = {
    reason: "Check the submission argument",
    url: "https://overleaf.com/project/synthetic",
    soft_deadline: "2026-10-01T08:00:00Z",
    hard_deadline: "2026-10-02T08:00:00Z",
  };
  it("accepts a late request without converting it into approval", () => {
    const existing = { paper_id: "p", slot: "feedback_arr" as const, status: "missing" as const };
    const written = applyPaperSlotWrite({
      existing,
      input: { value_text: JSON.stringify(request) },
      memberId: "m",
      now: new Date("2026-10-03T00:00:00Z"),
    });
    expect(written.ok).toBe(true);
    if (!written.ok) {
      return;
    }
    const queue = paperFeedbackQueue([
      {
        paper: { id: "p", title: "Synthetic", authors: ["Author"] } as never,
        slots: [written.record],
      },
    ]);
    expect(queue[0]?.feedback?.reason).toBe(request.reason);
    expect(queue[0]?.feedback?.hard_deadline).toBe(new Date(request.hard_deadline).toISOString());
    expect(written.record.slot).toBe("feedback_arr");
    expect(
      paperFeedbackQueue([
        {
          paper: { id: "p", title: "Synthetic", authors: [] } as never,
          slots: [{ ...written.record, status: "missing" }],
        },
      ]),
    ).toEqual([]);
  });
  it("rejects missing reason, unsafe links, invalid times and reversed deadlines", () => {
    for (const patch of [
      { reason: "" },
      { url: "javascript:alert(1)" },
      { url: "https://user:password@example.com" },
      { hard_deadline: "invalid" },
      { soft_deadline: "2026-10-03T08:00:00Z" },
    ]) {
      expect(parsePaperFeedback(JSON.stringify({ ...request, ...patch }))).toBeNull();
    }
  });
  it("allows an unspecified official cutoff without inventing a date", () => {
    expect(
      parsePaperFeedback(JSON.stringify({ reason: request.reason, url: request.url })),
    ).toEqual({ reason: request.reason, url: request.url });
  });
});
