// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  aoeDateLabel,
  aoeInstantMs,
  countdownLabel,
  upcomingMajorDeadlines,
  urgencyOf,
} from "./deadline-time.ts";
import { DEADLINE_VENUES } from "./deadlines.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("aoeInstantMs", () => {
  // AoE is UTC-12, so a deadline "at midnight" is really noon UTC the following day. Getting this
  // wrong shifts every countdown on both surfaces by half a day.
  it("shifts an AoE wall-clock time by twelve hours", () => {
    expect(aoeInstantMs("2026-09-19 23:59:59")).toBe(Date.UTC(2026, 8, 19, 23, 59, 59) + 12 * HOUR);
  });

  it("returns NaN for an unparseable stamp rather than a bogus instant", () => {
    expect(Number.isNaN(aoeInstantMs("soon"))).toBe(true);
  });
});

describe("aoeDateLabel", () => {
  // The label must be the AoE calendar date, not the +12h-shifted UTC one that would print Sep 20.
  it("prints the calendar date the deadline is written as", () => {
    expect(aoeDateLabel("2026-09-19 23:59:59")).toBe("Sep 19, 2026");
  });
});

describe("countdownLabel", () => {
  it("drops the leading 0d inside the last day", () => {
    expect(countdownLabel(2 * HOUR + 3 * 60_000 + 4000)).toBe("02:03:04");
  });

  it("shows whole days ahead of the clock beyond a day", () => {
    expect(countdownLabel(3 * DAY + HOUR)).toBe("3d 01:00:00");
  });

  it("floors at zero rather than counting up past a passed deadline", () => {
    expect(countdownLabel(-5000)).toBe("00:00:00");
  });
});

describe("urgencyOf", () => {
  it("bands by days remaining", () => {
    const now = Date.UTC(2026, 7, 10);
    expect(urgencyOf(now + 2 * DAY, now)).toBe("critical");
    expect(urgencyOf(now + 5 * DAY, now)).toBe("soon");
    expect(urgencyOf(now + 20 * DAY, now)).toBe("planned");
    expect(urgencyOf(now + 90 * DAY, now)).toBe("distant");
  });
});

describe("upcomingMajorDeadlines", () => {
  const now = Date.UTC(2026, 7, 10);

  it("returns the soonest upcoming conference deadlines, earliest first", () => {
    const picked = upcomingMajorDeadlines(now, 2);
    expect(picked).toHaveLength(2);
    expect(picked[0].venue.name).toContain("ICLR 2027");
    expect(picked[1].venue.name).toContain("NAACL 2027");
    expect(picked[0].instant).toBeLessThan(picked[1].instant);
  });

  // The snapshot is 101 workshops to 4 conferences, so without this filter the summary would be
  // two NeurIPS workshop rows every time and never name a conference anyone is submitting to.
  it("ignores workshops and rebuttals", () => {
    const picked = upcomingMajorDeadlines(now, 10);
    expect(picked.every((entry) => entry.venue.venue_type === "conference")).toBe(true);
    expect(DEADLINE_VENUES.some((venue) => venue.venue_type === "workshop")).toBe(true);
  });

  it("skips deadlines that have already passed", () => {
    // EMNLP 2026's commitment deadline is Aug 2, a week before `now`.
    const picked = upcomingMajorDeadlines(now, 10);
    expect(picked.every((entry) => entry.instant > now)).toBe(true);
    expect(picked.map((entry) => entry.venue.id)).not.toContain("emnlp2026_commitment");
  });

  // A conference with both an abstract and a full-paper deadline would otherwise fill both slots
  // and answer "what is next" with one venue twice.
  it("shows each conference at most once", () => {
    const picked = upcomingMajorDeadlines(now, 10);
    const groups = picked.map((entry) => entry.venue.venue_group);
    expect(new Set(groups).size).toBe(groups.length);
  });

  it("returns fewer than the limit rather than padding when the snapshot runs out", () => {
    // Far past every deadline in the bundled snapshot.
    expect(upcomingMajorDeadlines(Date.UTC(2030, 0, 1), 2)).toEqual([]);
  });
});
