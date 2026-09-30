/* @vitest-environment jsdom */
import { render } from "lit";
import { expect, it } from "vitest";
import { DEADLINE_VENUES, type DeadlineVenue } from "../data/deadlines.ts";
import { venueSchedule } from "./deadlines.ts";
import {
  renderWorkshopNotificationNotes,
  sharedWorkshopNotificationPolicy,
} from "./deadlines.workshop-notifications.ts";

function workshop(extra: Partial<DeadlineVenue> = {}): DeadlineVenue {
  return {
    ...DEADLINE_VENUES[0],
    id: "synthetic",
    venue_type: "workshop",
    schedule: [],
    notification_aoe: "",
    notification_policy: undefined,
    notification_status: undefined,
    notification_previous_aoe: undefined,
    ...extra,
  };
}

it("keeps the shared requirement and actual decision as separate milestones", () => {
  const stages = venueSchedule(
    workshop({
      schedule: [
        { milestone: "notification", label: "Decisions", kind: "date", date: "2035-09-25" },
      ],
      notification_policy: {
        milestone: "notification_by",
        label: "Shared rule",
        kind: "date",
        date: "2035-09-29",
        evidence: "Mandatory notification September 29",
        status: "source_backed",
      },
    }),
  );
  expect(stages.map((stage) => stage.label)).toContain("Decisions");
  expect(stages.map((stage) => stage.label)).toContain("Notify authors by");
  expect(stages.map((stage) => stage.date)).toEqual(
    expect.arrayContaining(["2035-09-25", "2035-09-29"]),
  );
});

it("keeps retained policy dates date-only and out of workshop-specific notes", () => {
  const stages = venueSchedule(
    workshop({
      notification_policy: {
        milestone: "notification_by",
        label: "Shared rule",
        kind: "date",
        date: "2035-09-29",
        status: "unverified",
      },
    }),
  );
  expect(stages[0].label).toBe("Notify authors by");
  expect(stages[0].kind).toBe("date");
  const target = document.createElement("div");
  render(
    renderWorkshopNotificationNotes(
      workshop({
        notification_policy: {
          milestone: "notification_by",
          label: "Shared rule",
          kind: "date",
          date: "2035-09-29",
          status: "unverified",
        },
      }),
    ),
    target,
  );
  expect(target.textContent).toBe("");
});

it("deduplicates a shared workshop notification requirement for the group", () => {
  const policy = {
    milestone: "notification_by",
    label: "Shared rule",
    kind: "date" as const,
    date: "2035-09-29",
    status: "unverified",
  };
  expect(
    sharedWorkshopNotificationPolicy([
      workshop({ id: "one", notification_policy: policy }),
      workshop({ id: "two", notification_policy: policy }),
    ]),
  ).toMatchObject({ date: "2035-09-29", status: "unverified" });
  expect(
    sharedWorkshopNotificationPolicy([
      workshop({ id: "one", notification_policy: policy }),
      workshop({
        id: "two",
        notification_policy: { ...policy, date: "2035-09-30" },
      }),
    ]),
  ).toBeUndefined();
});

it("retains an unverified decision date separately from supported dates", () => {
  const stages = venueSchedule(
    workshop({
      notification_previous_aoe: "2035-09-25 23:59:59",
      notification_status: "unverified",
    }),
  );
  expect(stages[0].label).toBe("Decision date (unverified)");
  expect(stages[0].date).toBe("2035-09-25");
});

it("does not label an unsupported legacy workshop timestamp Accept/reject", () => {
  expect(venueSchedule(workshop({ notification_aoe: "2035-09-25 23:59:59" }))).toEqual([]);
});

it("shows source uncertainty and policy conflicts in workshop details", () => {
  const target = document.createElement("div");
  render(
    renderWorkshopNotificationNotes(
      workshop({
        deadline_source_status: "legacy_unverified",
        notification_issues: [
          "Published decision date is later than the shared notification cutoff.",
        ],
      }),
    ),
    target,
  );
  expect(target.textContent).toContain("not yet verified");
  expect(target.textContent).toContain("later than");
});
