// When a conference becomes due, and the rule that it stops being due once it has been announced.
import { describe, expect, it } from "vitest";
import type { DeadlineWorkshopRecord } from "./workshop-nudges.js";
import {
  conferencesDueForWorkshopNudge,
  WORKSHOP_NUDGE_LEAD_DAYS,
  workshopConferenceSchedules,
} from "./workshop-schedule.js";

const NOW = new Date("2026-09-09T00:00:00.000Z");

function workshop(overrides: Partial<DeadlineWorkshopRecord> = {}): DeadlineWorkshopRecord {
  return {
    id: "w1",
    venue_id: "w1",
    name: "Workshop on Causality",
    entry_type: "workshop",
    venue_group: "EMNLP Workshops",
    venue_family: "emnlp",
    parent_conference_key: "emnlp",
    deadline_label: "Direct submission",
    deadline_aoe: "2026-09-30 23:59:59",
    ...overrides,
  };
}

describe("workshopConferenceSchedules", () => {
  it("reports the earliest open deadline under each conference", () => {
    const schedules = workshopConferenceSchedules(
      [
        workshop({ id: "a", venue_id: "a", deadline_aoe: "2026-10-20 23:59:59" }),
        workshop({ id: "b", venue_id: "b", deadline_aoe: "2026-09-20 23:59:59" }),
        workshop({
          id: "c",
          venue_id: "c",
          deadline_aoe: "2026-11-01 23:59:59",
          parent_conference_key: "acl",
          venue_group: "ACL Workshops",
          venue_family: "acl",
        }),
      ],
      NOW,
    );
    expect(schedules.map((entry) => [entry.key, entry.first_deadline_aoe])).toEqual([
      // Soonest first, which is the order the sweep spends its one pass in.
      ["emnlp", "2026-09-20 23:59:59"],
      ["acl", "2026-11-01 23:59:59"],
    ]);
    expect(schedules[0]?.workshop_count).toBe(2);
  });

  it("ignores deadlines that have already passed, so 'first' means the next one", () => {
    const schedules = workshopConferenceSchedules(
      [
        workshop({ id: "gone", venue_id: "gone", deadline_aoe: "2026-08-01 23:59:59" }),
        workshop({ id: "next", venue_id: "next", deadline_aoe: "2026-10-05 23:59:59" }),
      ],
      NOW,
    );
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.first_deadline_aoe).toBe("2026-10-05 23:59:59");
  });

  it("counts the days left to the moment the deadline actually expires", () => {
    // AoE is UTC-12, so a deadline dated the 19th is still open until the 20th at 11:59:59Z --
    // eleven and a half days from `NOW`, which rounds up to twelve. Measuring to midnight on the
    // printed date instead would have the sweep treat a deadline as closer than it is.
    const schedules = workshopConferenceSchedules(
      [workshop({ deadline_aoe: "2026-09-19 23:59:59" })],
      NOW,
    );
    expect(schedules[0]?.days_until).toBe(12);
  });

  it("leaves out anything that is not a workshop", () => {
    expect(
      workshopConferenceSchedules(
        [workshop({ entry_type: "conference", venue_type: "conference" })],
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("conferencesDueForWorkshopNudge", () => {
  const records = [
    workshop({ id: "soon", venue_id: "soon", deadline_aoe: "2026-09-18 23:59:59" }),
    workshop({
      id: "later",
      venue_id: "later",
      deadline_aoe: "2026-12-01 23:59:59",
      parent_conference_key: "acl",
      venue_group: "ACL Workshops",
      venue_family: "acl",
    }),
  ];

  it("returns only the conference inside the fortnight", () => {
    const due = conferencesDueForWorkshopNudge({
      records,
      now: NOW,
      alreadyNudged: new Set(),
    });
    expect(due.map((entry) => entry.key)).toEqual(["emnlp"]);
  });

  it("never returns a conference already announced, whatever the window says", () => {
    // The whole guarantee: the window is true on every tick inside it, so the ledger is the only
    // thing standing between a daily cron and a fortnight of daily repeats.
    const due = conferencesDueForWorkshopNudge({
      records,
      now: NOW,
      alreadyNudged: new Set(["emnlp"]),
    });
    expect(due).toEqual([]);
  });

  it("still returns a conference discovered late, because late beats never", () => {
    const due = conferencesDueForWorkshopNudge({
      records: [workshop({ deadline_aoe: "2026-09-11 23:59:59" })],
      now: NOW,
      alreadyNudged: new Set(),
    });
    expect(due.map((entry) => entry.key)).toEqual(["emnlp"]);
  });

  it("holds off while the deadline is further out than the lead time", () => {
    const due = conferencesDueForWorkshopNudge({
      records: [workshop({ deadline_aoe: "2026-09-30 23:59:59" })],
      now: NOW,
      alreadyNudged: new Set(),
    });
    expect(due).toEqual([]);
  });

  it("opens on the day the deadline comes inside the lead window, and not before", () => {
    expect(WORKSHOP_NUDGE_LEAD_DAYS).toBe(14);
    const due = (deadline: string) =>
      conferencesDueForWorkshopNudge({
        records: [workshop({ deadline_aoe: deadline })],
        now: NOW,
        alreadyNudged: new Set(),
      }).map((entry) => entry.key);
    // Both sides of the boundary, because an off-by-one here is a conference announced a day late
    // or a fortnight early and nothing in the output would say which.
    expect(due("2026-09-21 23:59:59")).toEqual(["emnlp"]);
    expect(due("2026-09-22 23:59:59")).toEqual([]);
  });

  it("orders several due conferences soonest first", () => {
    const due = conferencesDueForWorkshopNudge({
      records: [
        workshop({ id: "e", venue_id: "e", deadline_aoe: "2026-09-20 23:59:59" }),
        workshop({
          id: "a",
          venue_id: "a",
          deadline_aoe: "2026-09-12 23:59:59",
          parent_conference_key: "acl",
          venue_group: "ACL Workshops",
          venue_family: "acl",
        }),
      ],
      now: NOW,
      alreadyNudged: new Set(),
    });
    expect(due.map((entry) => entry.key)).toEqual(["acl", "emnlp"]);
  });
});
