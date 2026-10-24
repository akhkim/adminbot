// The board re-renders every second and asks each row for its stages; the stages do not depend on
// the clock, only on the venue, the display zone and the dataset it came with.
import { describe, expect, it } from "vitest";
import { DEADLINE_VENUES } from "../data/deadlines.ts";
import { venueStages } from "./deadlines.ts";

describe("venueStages", () => {
  it("computes a venue's stages once per dataset and zone", () => {
    const venues = [...DEADLINE_VENUES];
    const venue = venues[0]!;
    const stages = venueStages(venue, "UTC", venues);
    expect(stages.length).toBeGreaterThan(0);
    expect(venueStages(venue, "UTC", venues)).toBe(stages);
    expect(venueStages(venue, "Asia/Tokyo", venues)).not.toBe(stages);
    // A reloaded dataset is a new array, and may carry a changed schedule.
    expect(venueStages(venue, "UTC", [...venues])).not.toBe(stages);
    expect(venueStages(venue, "UTC", [...venues])).toEqual(stages);
  });
});
