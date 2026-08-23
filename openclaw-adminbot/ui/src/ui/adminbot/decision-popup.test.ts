import { describe, expect, it } from "vitest";
import { PRESENTATION_TYPES, pendingDecision } from "./decision-popup.ts";
import type { AdminBotPaperRecord } from "./controllers/admin.ts";

function paper(fields: Record<string, unknown>): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "A paper",
    authors: [],
    current_step: "submission",
    ...fields,
  } as never;
}

describe("when the popup should open", () => {
  it("stays shut while the venue has not answered", () => {
    expect(pendingDecision(paper({}))).toBeNull();
    expect(pendingDecision(paper({ venue_decision: "pending" }))).toBeNull();
  });

  it("opens on an accept and on a reject", () => {
    expect(pendingDecision(paper({ venue_decision: "accept" }))).toBe("accept");
    expect(pendingDecision(paper({ venue_decision: "reject" }))).toBe("reject");
  });

  it("never reopens on a decision the author already answered", () => {
    const answered = paper({
      venue_decision: "accept",
      accepted_venue: "EMNLP 2026",
      artifacts: { decision_seen: "accept:EMNLP 2026" },
    });
    expect(pendingDecision(answered)).toBeNull();
  });

  it("opens again for the next decision after a resubmission", () => {
    // Rejected at one venue, revised, resubmitted, decided again -- same record, and the second
    // decision deserves telling too. A bare boolean flag would have swallowed it.
    const resubmitted = paper({
      venue_decision: "accept",
      accepted_venue: "ICLR 2027",
      artifacts: { decision_seen: "reject:EMNLP 2026" },
    });
    expect(pendingDecision(resubmitted)).toBe("accept");
  });

  it("offers the tracks the lab actually publishes in", () => {
    expect([...PRESENTATION_TYPES]).toEqual([
      "main",
      "findings",
      "poster",
      "spotlight",
      "oral",
      "award",
    ]);
  });
});
