// What "finished" means for a paper, and who is allowed to say it.
import { describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "./controllers/admin.ts";
import {
  completedAt,
  completedOnLabel,
  completionReadiness,
  isPaperCompleted,
  partitionByCompletion,
} from "./paper-completion.ts";

function paper(overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "Causal abstraction",
    authors: ["Ada Lovelace"],
    current_step: "poster_making",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("paper completion", () => {
  it("reads the stamp off the record, and treats blank as still in flight", () => {
    expect(isPaperCompleted(paper())).toBe(false);
    expect(completedAt(paper())).toBeNull();
    // Reopening writes "", which has to read as not-completed rather than as a stamp.
    expect(isPaperCompleted(paper({ artifacts: { completed_at: "" } }))).toBe(false);
    expect(isPaperCompleted(paper({ artifacts: { completed_at: "   " } }))).toBe(false);
    const done = paper({ artifacts: { completed_at: "2026-07-14T18:03:11.000Z" } });
    expect(isPaperCompleted(done)).toBe(true);
    expect(completedOnLabel(done)).toBe("2026-07-14");
  });

  it("offers the control only once a venue has accepted, and says why when it does not", () => {
    expect(completionReadiness(paper({ venue_decision: "accept" }))).toEqual({ ready: true });
    // Not heard back yet: nothing to present.
    expect(completionReadiness(paper()).ready).toBe(false);
    expect(completionReadiness(paper()).reason).toMatch(/accepted/i);
    // A rejection is not an ending -- the paper goes back out, which is what `attempt` counts.
    const rejected = completionReadiness(paper({ venue_decision: "reject" }));
    expect(rejected.ready).toBe(false);
    expect(rejected.reason).toMatch(/another venue/i);
  });

  it("splits the list in one pass, keeping each half in the order it arrived", () => {
    const papers = [
      paper({ id: "a" }),
      paper({ id: "b", artifacts: { completed_at: "2026-07-14T00:00:00.000Z" } }),
      paper({ id: "c" }),
      paper({ id: "d", artifacts: { completed_at: "2026-05-01T00:00:00.000Z" } }),
    ];
    const { ongoing, completed } = partitionByCompletion(papers);
    expect(ongoing.map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(completed.map((entry) => entry.id)).toEqual(["b", "d"]);
    expect(partitionByCompletion([])).toEqual({ ongoing: [], completed: [] });
  });
});
