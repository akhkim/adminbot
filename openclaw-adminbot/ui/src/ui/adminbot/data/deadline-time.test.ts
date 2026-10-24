// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  deadlineInstantMs,
  deadlineDateTimeLabel,
  planningCountdownLabel,
  aoeDateLabel,
  aoeDateTimeLabel,
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

  it.each([
    "2026-02-29 12:00:00",
    "2026-04-31 12:00:00",
    "2026-00-01 12:00:00",
    "2026-13-01 12:00:00",
    "2026-01-00 12:00:00",
    "2026-01-01 24:00:00",
    "2026-01-01 12:60:00",
    "2026-01-01 12:00:60",
    "prefix 2026-01-01 12:00:00",
    "2026-01-01 12:00:00Z",
    "2026-01-01 12:00:00\n",
  ])("rejects malformed or impossible dates: %s", (stamp) => {
    expect(aoeInstantMs(stamp)).toBeNaN();
  });

  it("accepts leap days and preserves years below 100", () => {
    expect(aoeInstantMs("2024-02-29T23:59:59")).toBe(Date.parse("2024-03-01T11:59:59Z"));
    expect(aoeInstantMs("0099-01-01 00:00:00")).toBe(Date.parse("0099-01-01T12:00:00Z"));
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

  it("keeps the AoE wall-clock time with the displayed date", () => {
    expect(aoeDateTimeLabel("2026-09-19 17:30:59")).toBe("Sep 19, 2026 · 17:30 AoE");
  });
});

describe("countdownLabel", () => {
  it("keeps the leading 0d inside the last day", () => {
    expect(countdownLabel(2 * HOUR + 3 * 60_000 + 4000)).toBe("0d 02:03:04");
  });

  it("shows whole days ahead of the clock beyond a day", () => {
    expect(countdownLabel(3 * DAY + HOUR)).toBe("3d 01:00:00");
  });

  it("floors at zero rather than counting up past a passed deadline", () => {
    expect(countdownLabel(-5000)).toBe("0d 00:00:00");
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

  // Named venues would pin this to whichever CFPs the snapshot happened to carry the day it was
  // regenerated; the behavior is that the soonest conference deadlines come back in order.
  it("returns the soonest upcoming conference deadlines, earliest first", () => {
    const picked = upcomingMajorDeadlines(now, 2);
    expect(picked).toHaveLength(2);
    expect(picked[0].instant).toBeGreaterThan(now);
    expect(picked[0].instant).toBeLessThan(picked[1].instant);
    // Nothing sooner was skipped over: no other conference deadline sits before the first pick.
    const soonest = Math.min(
      ...DEADLINE_VENUES.filter((venue) => venue.venue_type === "conference")
        .map((venue) => aoeInstantMs(venue.deadline_aoe))
        .filter((instant) => instant > now),
    );
    expect(picked[0].instant).toBe(soonest);
  });

  // Workshops dominate the snapshot, so without this filter they would bury conference targets.
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

describe("source precision", () => {
  const dateOnly = {
    ...DEADLINE_VENUES[0],
    deadline_aoe: "2035-01-30 22:00:00",
    deadline_at: "",
    deadline_date: "2035-02-01",
    deadline_timezone: "",
    deadline_time_precision: "date_only",
  };
  it("shows the source day instead of the earlier planning day", () => {
    expect(deadlineDateTimeLabel(dateOnly)).toBe("Feb 1, 2035 · time unknown");
    expect(deadlineInstantMs(dateOnly)).toBe(Date.parse("2035-01-31T10:00:00Z"));
  });
  it("labels a passed planning cutoff without claiming submissions closed", () => {
    expect(planningCountdownLabel(dateOnly, Date.parse("2035-01-31T11:00:00Z"))).toBe(
      "Planning cutoff passed · check source",
    );
  });
  it("formats the exact UTC instant in AoE in the UI", () => {
    expect(
      deadlineDateTimeLabel({
        ...dateOnly,
        deadline_time_precision: "exact",
        deadline_at: "2035-02-02T11:59:59Z",
      }),
    ).toBe("Feb 1, 2035 · 23:59 AoE");
  });
});

describe("calculated planning cutoff", () => {
  it.each([
    ["2035-01-15", "America/Toronto", "2035-01-15T05:00:00Z"],
    ["2035-07-15", "America/Toronto", "2035-07-15T04:00:00Z"],
    ["2035-07-15", "GMT+2", "2035-07-14T22:00:00Z"],
    ["2035-07-15", "UTC-03:30", "2035-07-15T03:30:00Z"],
    ["2035-07-15", "AoE", "2035-07-15T12:00:00Z"],
    ["2035-07-15", "", "2035-07-14T10:00:00Z"],
  ])("resolves %s in %s", (date, zone, expected) => {
    expect(
      deadlineInstantMs({
        deadline_aoe: "",
        deadline_date: date,
        deadline_timezone: zone,
        deadline_time_precision: "date_only",
      }),
    ).toBe(Date.parse(expected));
  });
  it.each([
    ["2035-02-30", "UTC"],
    ["2035-07-15", "GMT+25"],
    ["2035-07-15", "invalid"],
  ])("rejects invalid date/zone %s %s", (date, zone) => {
    expect(
      deadlineInstantMs({
        deadline_aoe: "",
        deadline_date: date,
        deadline_timezone: zone,
        deadline_time_precision: "date_only",
      }),
    ).toBeNaN();
  });
});
