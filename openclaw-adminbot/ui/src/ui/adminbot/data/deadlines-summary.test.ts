import { describe, expect, it } from "vitest";
import { DEADLINE_SUMMARIES } from "./deadlines-summary.ts";
import { DEADLINE_VENUES } from "./deadlines.ts";

describe("eager deadline summary", () => {
  it("tracks every full-board deadline without bundling history or source text", () => {
    expect(DEADLINE_SUMMARIES).toHaveLength(DEADLINE_VENUES.length);
    DEADLINE_SUMMARIES.forEach((summary, index) => {
      const full = DEADLINE_VENUES[index] as unknown as Record<string, unknown>;
      expect(summary).toEqual(
        Object.fromEntries(Object.keys(summary).map((key) => [key, full[key]])),
      );
    });
    expect(DEADLINE_SUMMARIES[0]).not.toHaveProperty("revisions");
    expect(DEADLINE_SUMMARIES[0]).not.toHaveProperty("deadline_official_evidence");
  });
});
