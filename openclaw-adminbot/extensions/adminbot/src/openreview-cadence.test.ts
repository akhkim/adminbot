import { describe, expect, it } from "vitest";
import {
  dueMilestones,
  milestonesFor,
  missedMilestones,
  renderMilestoneMessage,
  requiresApproval,
  type AdminBotOpenReviewCycle,
} from "./openreview-cadence.js";

const DAY = 86_400_000;
const DEADLINE = Date.parse("2026-09-10T00:00:00.000Z");

function cycle(overrides: Partial<AdminBotOpenReviewCycle> = {}): AdminBotOpenReviewCycle {
  return {
    venue_id: "TestVenue.cc/2026/Conference",
    role: "ac",
    deadline_ms: DEADLINE,
    cycle_start_ms: DEADLINE - 20 * DAY,
    ...overrides,
  };
}

describe("milestonesFor", () => {
  it("lays out halfway, the five pre-deadline steps, and the four overdue steps in order", () => {
    const keys = milestonesFor(cycle()).map((milestone) => milestone.key);
    expect(keys).toEqual([
      "halfway",
      "pre-7",
      "pre-4",
      "pre-2",
      "pre-1",
      "pre-0.5",
      "overdue-1",
      "overdue-2",
      "overdue-4",
      "overdue-7",
    ]);
  });

  it("puts halfway exactly midway between the cycle start and the deadline", () => {
    const halfway = milestonesFor(cycle()).find((milestone) => milestone.key === "halfway");
    expect(halfway?.due_at_ms).toBe(DEADLINE - 10 * DAY);
  });

  it("places the pre-deadline steps at 7/4/2/1/0.5 days before and overdue at 1/2/4/7 days after", () => {
    const byKey = new Map(milestonesFor(cycle()).map((m) => [m.key, m.due_at_ms]));
    expect(byKey.get("pre-7")).toBe(DEADLINE - 7 * DAY);
    expect(byKey.get("pre-0.5")).toBe(DEADLINE - DAY / 2);
    expect(byKey.get("overdue-1")).toBe(DEADLINE + DAY);
    expect(byKey.get("overdue-7")).toBe(DEADLINE + 7 * DAY);
  });

  it("omits halfway when the cycle start is unknown or not before the deadline", () => {
    expect(milestonesFor(cycle({ cycle_start_ms: null })).some((m) => m.key === "halfway")).toBe(
      false,
    );
    expect(
      milestonesFor(cycle({ cycle_start_ms: DEADLINE + DAY })).some((m) => m.key === "halfway"),
    ).toBe(false);
  });
});

describe("dueMilestones", () => {
  it("fires a milestone once its moment arrives", () => {
    const due = dueMilestones(cycle(), DEADLINE - 7 * DAY + 60_000, new Set());
    expect(due.map((m) => m.key)).toEqual(["pre-7"]);
  });

  it("does not fire before the moment arrives", () => {
    expect(dueMilestones(cycle(), DEADLINE - 8 * DAY, new Set()).map((m) => m.key)).toEqual([]);
  });

  it("is idempotent: an already-fired milestone never comes back", () => {
    const now = DEADLINE - 7 * DAY + 60_000;
    const first = dueMilestones(cycle(), now, new Set());
    expect(first).toHaveLength(1);
    const second = dueMilestones(cycle(), now, new Set(first.map((m) => m.key)));
    expect(second).toEqual([]);
  });

  it("still fires a milestone missed by a few hours, within the catch-up window", () => {
    const due = dueMilestones(cycle(), DEADLINE - 7 * DAY + 6 * 3600_000, new Set());
    expect(due.map((m) => m.key)).toEqual(["pre-7"]);
  });

  it("does not replay a whole ladder for a venue discovered late", () => {
    // Discovered a day after the deadline: only the milestone whose window is
    // genuinely open fires, not the five pre-deadline ones that were missed.
    const due = dueMilestones(cycle(), DEADLINE + DAY + 3600_000, new Set());
    expect(due.map((m) => m.key)).toEqual(["overdue-1"]);
  });

  it("reports the skipped ones as missed rather than silently dropping them", () => {
    const missed = missedMilestones(cycle(), DEADLINE + DAY + 3600_000, new Set()).map(
      (m) => m.key,
    );
    expect(missed).toContain("pre-7");
    expect(missed).toContain("pre-0.5");
    expect(missed).not.toContain("overdue-1");
    expect(missed).not.toContain("overdue-7");
  });

  it("never fires two milestones at once, however long the outage", () => {
    // The catch-up window is no wider than the tightest gap in the ladder
    // (pre-1 -> pre-0.5, 12h), so a single run can only ever owe one message per
    // cycle — an outage produces one reminder, not a burst.
    for (let now = DEADLINE - 25 * DAY; now <= DEADLINE + 9 * DAY; now += 3600_000) {
      expect(dueMilestones(cycle(), now, new Set()).length).toBeLessThanOrEqual(1);
    }
  });

  it("catches every milestone at least once when polled on the deployed 6-hourly cadence", () => {
    const fired = new Set<string>();
    for (let now = DEADLINE - 25 * DAY; now <= DEADLINE + 9 * DAY; now += 6 * 3600_000) {
      for (const milestone of dueMilestones(cycle(), now, fired)) {
        fired.add(milestone.key);
      }
    }
    expect([...fired].toSorted()).toEqual(
      milestonesFor(cycle())
        .map((m) => m.key)
        .toSorted(),
    );
  });
});

describe("requiresApproval", () => {
  it("lets routine reminders through and holds overdue warnings for a human", () => {
    const byKey = new Map(milestonesFor(cycle()).map((m) => [m.key, m]));
    expect(requiresApproval(byKey.get("halfway")!)).toBe(false);
    expect(requiresApproval(byKey.get("pre-1")!)).toBe(false);
    expect(requiresApproval(byKey.get("overdue-1")!)).toBe(true);
    expect(requiresApproval(byKey.get("overdue-7")!)).toBe(true);
  });
});

describe("renderMilestoneMessage", () => {
  const context = {
    venue_title: "NeurIPS 2026",
    submission_number: 42,
    submission_title: "A Paper",
    deadline_ms: DEADLINE,
    missing_count: 2,
  };
  const byKey = new Map(milestonesFor(cycle()).map((m) => [m.key, m]));

  it("tells an AC's reviewers to submit early at the halfway mark", () => {
    const message = renderMilestoneMessage("ac", byKey.get("halfway")!, context);
    expect(message.body).toContain("submit early");
    expect(message.subject).toContain("NeurIPS 2026");
  });

  it("tells an SAC to nudge their reviewers at the halfway mark, not the reviewers themselves", () => {
    const message = renderMilestoneMessage("sac", byKey.get("halfway")!, context);
    expect(message.body).toContain("your reviewers");
    expect(message.body).not.toContain("submit early");
  });

  it("names the submission and the deadline in every message", () => {
    for (const milestone of milestonesFor(cycle())) {
      for (const role of ["ac", "sac"] as const) {
        const message = renderMilestoneMessage(role, milestone, context);
        expect(message.body).toContain("Submission 42");
        expect(message.body).toContain("2026-09-10");
        expect(message.subject.length).toBeGreaterThan(0);
      }
    }
  });

  it("escalates in tone once the deadline has passed", () => {
    const overdue = renderMilestoneMessage("ac", byKey.get("overdue-2")!, context);
    expect(overdue.subject).toContain("OVERDUE");
    expect(overdue.body).toContain("2 days past");
  });

  it("describes the half-day step in hours rather than as '0.5 days'", () => {
    const message = renderMilestoneMessage("ac", byKey.get("pre-0.5")!, context);
    expect(message.body).toContain("about 12 hours");
    expect(message.body).not.toContain("0.5 days");
  });
});
