import { describe, expect, it } from "vitest";
import type { DeadlineWorkshopRecord } from "../papers/workshop-nudges.js";
import { conferenceCatalog, lodgingNeedFrom } from "./catalog.js";

const NOW = new Date("2026-09-09T00:00:00.000Z");

function workshop(overrides: Partial<DeadlineWorkshopRecord> = {}): DeadlineWorkshopRecord {
  return {
    id: "w1",
    venue_id: "w1",
    name: "Workshop on Causality",
    entry_type: "workshop",
    venue_group: "EMNLP 2026 Workshops",
    venue_family: "EMNLP",
    parent_conference_key: "emnlp-2026",
    conference_location: "Budapest, Hungary",
    deadline_label: "Direct submission",
    deadline_aoe: "2026-10-01 23:59:59",
    ...overrides,
  };
}

describe("conferenceCatalog", () => {
  it("names the conference rather than its workshop group, and locates it", () => {
    const [emnlp] = conferenceCatalog([workshop()], NOW);
    expect(emnlp?.key).toBe("emnlp-2026");
    // "EMNLP 2026 Workshops" is a fact about the rows, not about the event somebody flies to.
    expect(emnlp?.label).toBe("EMNLP 2026");
    expect(emnlp?.year).toBe(2026);
    expect(emnlp?.location).toBe("Budapest, Hungary");
  });

  it("carries a description for a venue it knows", () => {
    const [emnlp] = conferenceCatalog([workshop()], NOW);
    expect(emnlp?.description).toContain("Empirical Methods");
  });

  it("says so rather than going blank for a venue it does not know", () => {
    const [other] = conferenceCatalog(
      [
        workshop({
          venue_family: "QUUX",
          parent_conference_key: "quux-2026",
          venue_group: "QUUX 2026 Workshops",
        }),
      ],
      NOW,
    );
    // A card with an empty description reads as a card that failed to load.
    expect(other?.description).toContain("No description on file");
  });

  it("counts the workshops and names the next open call", () => {
    const [emnlp] = conferenceCatalog(
      [
        workshop({ id: "a", venue_id: "a", deadline_aoe: "2026-11-01 23:59:59" }),
        workshop({ id: "b", venue_id: "b", name: "NLP4PI", deadline_aoe: "2026-09-20 23:59:59" }),
      ],
      NOW,
    );
    expect(emnlp?.workshop_count).toBe(2);
    expect(emnlp?.next_deadline_aoe).toBe("2026-09-20 23:59:59");
    expect(emnlp?.next_deadline_label).toContain("NLP4PI");
  });

  it("keeps a conference whose calls have all closed, unlike the workshop nudge schedule", () => {
    // Still ahead of the lab and still worth signing up to attend; it simply has no next call.
    const [emnlp] = conferenceCatalog([workshop({ deadline_aoe: "2026-01-01 23:59:59" })], NOW);
    expect(emnlp?.key).toBe("emnlp-2026");
    expect(emnlp?.next_deadline_aoe).toBeUndefined();
  });

  it("sorts by the soonest open call, with the closed ones last", () => {
    const catalog = conferenceCatalog(
      [
        workshop({ deadline_aoe: "2026-11-01 23:59:59" }),
        workshop({
          id: "n",
          venue_id: "n",
          venue_family: "NeurIPS",
          parent_conference_key: "neurips-2026",
          venue_group: "NeurIPS 2026 Workshops",
          deadline_aoe: "2026-09-15 23:59:59",
        }),
        workshop({
          id: "c",
          venue_id: "c",
          venue_family: "ACL",
          parent_conference_key: "acl-2027",
          venue_group: "ACL 2027 Workshops",
          deadline_aoe: "2026-01-01 23:59:59",
        }),
      ],
      NOW,
    );
    expect(catalog.map((entry) => entry.key)).toEqual([
      "neurips-2026",
      "emnlp-2026",
      // No open call left, so nothing about it is urgent any more.
      "acl-2027",
    ]);
  });

  it("ignores rows that are not workshops, which carry no parent conference", () => {
    expect(
      conferenceCatalog(
        [workshop({ entry_type: "main_conference", venue_type: "conference" })],
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("lodgingNeedFrom", () => {
  const nameOf = (id: string) => ({ ada: "Ada", bob: "Bob", jo: "Jo" })[id] ?? id;

  it("counts only people who are going and asked for a bed", () => {
    const need = lodgingNeedFrom(
      [
        { member_id: "ada", intent: "going", needs_lodging: true },
        // Wants a bed but has not decided: booking against maybes is how the lab pays for
        // empty rooms.
        { member_id: "bob", intent: "undecided", needs_lodging: true },
        { member_id: "jo", intent: "going", needs_lodging: false },
      ],
      nameOf,
    );
    expect(need.guests).toBe(1);
    expect(need.members.map((entry) => entry.name)).toEqual(["Ada"]);
  });

  it("spans the earliest arrival and the latest departure, because one booking covers everyone", () => {
    const need = lodgingNeedFrom(
      [
        {
          member_id: "ada",
          intent: "going",
          needs_lodging: true,
          arrival_on: "2026-11-04",
          departure_on: "2026-11-08",
        },
        {
          member_id: "bob",
          intent: "going",
          needs_lodging: true,
          arrival_on: "2026-11-02",
          departure_on: "2026-11-07",
        },
      ],
      nameOf,
    );
    expect(need.guests).toBe(2);
    expect(need.first_night).toBe("2026-11-02");
    expect(need.last_night).toBe("2026-11-08");
  });

  it("still gives a headcount when nobody has filled in dates", () => {
    const need = lodgingNeedFrom(
      [{ member_id: "ada", intent: "going", needs_lodging: true }],
      nameOf,
    );
    expect(need.guests).toBe(1);
    expect(need.first_night).toBeUndefined();
  });
});
