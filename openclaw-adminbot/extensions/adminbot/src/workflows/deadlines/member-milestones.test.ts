import { describe, expect, it } from "vitest";
import type { AdminBotMemberMilestone } from "../../contracts/actions.js";
import { DEADLINE_VENUES } from "./generated/dataset.js";
import { isDeadlineMilestoneId, reconcileDeadlineMilestones } from "./member-milestones.js";

describe("deadline-linked member milestones", () => {
  const deadline = DEADLINE_VENUES.find((entry) => entry.link)!;

  it("refreshes copied fields from the current accepted projection", () => {
    expect(
      reconcileDeadlineMilestones([
        {
          deadline_id: deadline.deadline_id,
          date: "2000-01-01",
          label: "Old label",
          link: "https://example.com/old",
          time: "00:00",
          timezone: "UTC",
        },
      ]),
    ).toEqual([
      {
        deadline_id: deadline.deadline_id,
        date: deadline.deadline_aoe.slice(0, 10),
        label: deadline.name,
        link: deadline.link,
        time: deadline.deadline_aoe.slice(11, 16),
        timezone: "Etc/GMT+12",
      },
    ]);
  });

  it("migrates an old copied row by its label and historical date", () => {
    const revised = DEADLINE_VENUES.find((entry) => entry.revisions.length > 1)!;
    const oldDate = revised.revisions.find(
      (revision) => revision.deadline_aoe !== revised.deadline_aoe,
    )!.deadline_aoe;
    const migrated = reconcileDeadlineMilestones([
      { date: oldDate.slice(0, 10), label: revised.name },
    ]);

    expect(migrated?.[0]).toMatchObject({
      deadline_id: revised.deadline_id,
      date: revised.deadline_aoe.slice(0, 10),
      label: revised.name,
    });
  });

  it("leaves personal and unresolvable rows intact", () => {
    const rows: AdminBotMemberMilestone[] = [
      { date: "2027-06-12", label: "Thesis defence" },
      { deadline_id: "retired_deadline", date: "2026-01-01", label: "Retired event" },
    ];
    expect(reconcileDeadlineMilestones(rows)).toBe(rows);
  });

  it("collapses duplicate additions by dated deadline identity", () => {
    expect(
      reconcileDeadlineMilestones([
        { deadline_id: deadline.deadline_id, date: "2000-01-01", label: "First" },
        { deadline_id: deadline.deadline_id, date: "2001-01-01", label: "Second" },
      ]),
    ).toHaveLength(1);
  });

  it("recognizes both the generated and compatibility dated ids", () => {
    expect(isDeadlineMilestoneId(deadline.deadline_id)).toBe(true);
    expect(isDeadlineMilestoneId(deadline.id)).toBe(true);
    expect(isDeadlineMilestoneId("missing")).toBe(false);
  });
});

it("labels a copied date-only boundary as a planning cutoff", () => {
  const record = {
    id: "example",
    deadline_id: "example",
    name: "Example",
    deadline_aoe: "2035-01-30 22:00:00",
    deadline_time_precision: "date_only",
  };
  expect(
    reconcileDeadlineMilestones(
      [{ deadline_id: "example", date: "2035-02-01", label: "Example" }],
      [record],
    )?.[0],
  ).toMatchObject({
    date: "2035-01-30",
    time: "22:00",
    label: "Example — planning cutoff (time unknown)",
  });
});
