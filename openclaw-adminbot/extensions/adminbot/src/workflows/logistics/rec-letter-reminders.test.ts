// The window, and what the mail says once something is inside it.
import { describe, expect, it } from "vitest";
import type { AdminBotLogisticsRequest } from "../../contracts/actions.js";
import {
  adminBotRecLetterReminderMaxWithinDays,
  readableDeadline,
  recLetterReminderBody,
  recLetterReminderLedgerSubject,
  recLetterReminderSubject,
  recLetterRemindersDue,
} from "./rec-letter-reminders.js";

const NOW = new Date("2026-11-28T09:00:00Z");

function letters(
  overrides: Partial<AdminBotLogisticsRequest> & { id: string },
): AdminBotLogisticsRequest {
  const at = overrides.deadline_at ?? "2026-12-01T23:59:00Z";
  return {
    kind: "recommendation_letters",
    member_id: "ada",
    member_name: "Ada Lovelace",
    status: "submitted",
    submitted_at: "2026-11-01T09:00:00Z",
    updated_at: "2026-11-01T09:00:00Z",
    schools: [
      {
        school: "MIT",
        letter_deadline: at.slice(0, 10),
        letter_deadline_time: at.slice(11, 16),
        deadline_timezone: "UTC",
      },
    ],
    deadline_at: "2026-12-01T23:59:00Z",
    ...overrides,
  };
}

describe("recLetterRemindersDue", () => {
  it("takes a letter three days out and leaves one that is further away", () => {
    const due = recLetterRemindersDue(
      [
        letters({ id: "soon", deadline_at: "2026-12-01T12:00:00Z" }),
        letters({ id: "later", deadline_at: "2026-12-20T12:00:00Z" }),
      ],
      NOW,
    );

    expect(due.map((entry) => entry.request_id)).toEqual(["soon"]);
    expect(due[0]?.days_until).toBe(3);
  });

  it("opens Thursday for a Monday deadline and respects the deadline timezone", () => {
    const request = letters({
      id: "monday",
      schools: [
        {
          school: "Example",
          letter_deadline: "2026-11-30",
          letter_deadline_time: "12:00",
          deadline_timezone: "America/Toronto",
        },
      ],
    });
    const tierAt = (iso: string) =>
      recLetterRemindersDue([request], new Date(iso)).map((entry) => entry.tier);
    // The week heads-up opens at midnight Toronto seven days before, the last call Thursday.
    expect(tierAt("2026-11-23T04:59:00Z")).toEqual([]);
    expect(tierAt("2026-11-23T05:00:00Z")).toEqual(["week"]);
    expect(tierAt("2026-11-26T04:59:00Z")).toEqual(["week"]);
    expect(tierAt("2026-11-26T05:00:00Z")).toEqual(["final"]);
    expect(tierAt("2026-11-30T17:00:01Z")).toEqual([]);
  });

  it("still fires on a letter due tomorrow, so a pass that did not run yesterday is not a miss", () => {
    const due = recLetterRemindersDue(
      [letters({ id: "tight", deadline_at: "2026-11-29T12:00:00Z" })],
      NOW,
    );

    expect(due[0]?.days_until).toBe(1);
  });

  it("says nothing about a deadline that has already passed", () => {
    const due = recLetterRemindersDue(
      [letters({ id: "late", deadline_at: "2026-11-27T12:00:00Z" })],
      NOW,
    );

    expect(due).toEqual([]);
  });

  it("ignores settled requests and other kinds of request", () => {
    const due = recLetterRemindersDue(
      [
        letters({ id: "done", status: "completed" }),
        letters({ id: "withdrawn", status: "withdrawn" }),
        letters({ id: "signature", kind: "document_signature", schools: undefined }),
      ],
      NOW,
    );

    expect(due).toEqual([]);
  });

  it("skips a request that names no deadline at all", () => {
    const due = recLetterRemindersDue(
      [letters({ id: "undated", deadline_at: undefined, schools: [{ school: "MIT" }] })],
      NOW,
    );

    expect(due).toEqual([]);
  });

  it("orders by deadline, soonest first", () => {
    const due = recLetterRemindersDue(
      [
        letters({ id: "b", deadline_at: "2026-12-01T12:00:00Z" }),
        letters({ id: "a", deadline_at: "2026-11-30T12:00:00Z" }),
      ],
      NOW,
    );

    expect(due.map((entry) => entry.request_id)).toEqual(["a", "b"]);
  });
});

describe("recLetterReminderLedgerSubject", () => {
  it("carries the deadline, so a date that moves re-arms the reminder", () => {
    const [first] = recLetterRemindersDue([letters({ id: "req_1" })], NOW);
    const [moved] = recLetterRemindersDue(
      [letters({ id: "req_1", deadline_at: "2026-11-30T23:59:00.000Z" })],
      NOW,
    );

    expect(first && recLetterReminderLedgerSubject(first)).toBe(
      "rec_letter|req_1|2026-12-01T23:59:00.000Z",
    );
    expect(moved && recLetterReminderLedgerSubject(moved)).not.toBe(
      first && recLetterReminderLedgerSubject(first),
    );
  });
});

describe("the mail", () => {
  it("names the member when there is one letter, and counts them when there are several", () => {
    const one = recLetterRemindersDue([letters({ id: "one" })], NOW);
    const two = recLetterRemindersDue(
      [letters({ id: "one" }), letters({ id: "two", member_name: "Grace Hopper" })],
      NOW,
    );

    expect(recLetterReminderSubject(one)).toBe(
      "Recommendation letter for Ada Lovelace is due in 3 days",
    );
    expect(recLetterReminderSubject(two)).toBe(
      "2 recommendation letters due within 2 business days",
    );
  });

  it("lists each letter with its date, its schools and where to read the request", () => {
    const due = recLetterRemindersDue(
      [
        letters({
          id: "one",
          schools: [
            { school: "MIT", letter_deadline: "2026-12-01", deadline_timezone: "UTC" },
            { school: "Stanford", letter_deadline: "2026-12-01", deadline_timezone: "UTC" },
          ],
        }),
      ],
      NOW,
    );

    const body = recLetterReminderBody(due, "https://portal.example", {
      recipientName: "Zhijing Jin",
    });
    expect(body.startsWith("Hi Zhijing,\n")).toBe(true);
    expect(body).toContain("• Ada Lovelace — due Tue 1 Dec, 23:59 UTC (in 3 days) — MIT, Stanford");
    expect(body).toContain("https://portal.example");
    expect(body.endsWith("— AdminBot, Jinesis AI Lab")).toBe(true);
  });

  it("stops listing schools before the line becomes a paragraph", () => {
    const due = recLetterRemindersDue(
      [
        letters({
          id: "many",
          schools: ["MIT", "Stanford", "CMU", "Berkeley", "ETH", "Oxford", "UofT"].map(
            (school) => ({ school, letter_deadline: "2026-12-01", deadline_timezone: "UTC" }),
          ),
        }),
      ],
      NOW,
    );

    expect(recLetterReminderBody(due, "https://portal.example")).toContain(
      "MIT, Stanford, CMU, Berkeley, ETH and 2 more",
    );
  });
});

describe("every school deadline, in two tiers", () => {
  // ELLIS on the 25th, Toronto on the 1st: the shape that went unreminded when only the soonest
  // date on a request counted.
  const ellisThenToronto = letters({
    id: "two-dates",
    schools: [
      {
        school: "ELLIS",
        letter_deadline: "2026-11-25",
        letter_deadline_time: "23:59",
        deadline_timezone: "Etc/GMT+12",
      },
      {
        school: "University of Toronto",
        letter_deadline: "2026-12-01",
        letter_deadline_time: "23:59",
        deadline_timezone: "America/Toronto",
      },
      { school: "Later", letter_deadline: "2027-01-07", deadline_timezone: "America/Toronto" },
    ],
  });
  const at = (iso: string) =>
    recLetterRemindersDue([ellisThenToronto], new Date(iso)).map((entry) => [
      entry.schools.join("+"),
      entry.tier,
    ]);

  it("reminds about the later school once the earlier one has passed", () => {
    expect(at("2026-11-21T12:00:00Z")).toEqual([["ELLIS", "week"]]);
    expect(at("2026-11-23T12:00:00Z")).toEqual([["ELLIS", "final"]]);
    expect(at("2026-11-25T12:00:00Z")).toEqual([
      ["ELLIS", "final"],
      ["University of Toronto", "week"],
    ]);
    // ELLIS has closed (AoE), Toronto's last call opens Friday 27th at midnight Toronto.
    expect(at("2026-11-26T13:00:00Z")).toEqual([["University of Toronto", "week"]]);
    expect(at("2026-11-27T05:00:00Z")).toEqual([["University of Toronto", "final"]]);
    expect(at("2026-12-02T05:00:00Z")).toEqual([]);
  });

  it("skips a school whose letter is already in", () => {
    const request = letters({
      id: "half-done",
      schools: [
        { school: "Done", letter_deadline: "2026-11-30", letter_status: "Submitted" },
        { school: "Open", letter_deadline: "2026-11-30" },
      ],
    });
    expect(recLetterRemindersDue([request], NOW).map((entry) => entry.schools)).toEqual([["Open"]]);
  });

  it("puts schools with the same deadline on one line", () => {
    const due = recLetterRemindersDue(
      [
        letters({
          id: "same",
          schools: [
            { school: "MIT", letter_deadline: "2026-12-01", deadline_timezone: "UTC" },
            { school: "Stanford", letter_deadline: "2026-12-01", deadline_timezone: "UTC" },
          ],
        }),
      ],
      NOW,
    );
    expect(due).toHaveLength(1);
    expect(due[0]?.schools).toEqual(["MIT", "Stanford"]);
  });

  it("stamps the two tiers apart, the final one under the old key", () => {
    const base = { request_id: "r", deadline_at: "2026-12-01T23:59:00Z" };
    expect(recLetterReminderLedgerSubject({ ...base, tier: "final" })).toBe(
      "rec_letter|r|2026-12-01T23:59:00Z",
    );
    expect(recLetterReminderLedgerSubject({ ...base, tier: "week" })).toBe(
      "rec_letter_week|r|2026-12-01T23:59:00Z",
    );
  });

  it("looks further ahead on a manual run, as a heads-up only", () => {
    const later = letters({ id: "later", deadline_at: "2026-12-20T12:00:00Z" });
    expect(recLetterRemindersDue([later], NOW)).toEqual([]);
    expect(
      recLetterRemindersDue([later], NOW, undefined, { withinDays: 30 }).map((e) => e.tier),
    ).toEqual(["week"]);
    expect(recLetterRemindersDue([later], NOW, undefined, { withinDays: 10 })).toEqual([]);
    expect(
      recLetterRemindersDue([later], NOW, undefined, {
        withinDays: adminBotRecLetterReminderMaxWithinDays + 1,
      }),
    ).toEqual([]);
  });

  it("splits a mixed mail into the last calls and the heads-ups", () => {
    const due = recLetterRemindersDue([ellisThenToronto], new Date("2026-11-25T12:00:00Z"));
    expect(recLetterReminderSubject(due)).toBe("2 recommendation letters due within a week");
    const body = recLetterReminderBody(due, "https://portal.example");
    expect(body).toContain(
      "Due within 2 business days:\n• Ada Lovelace — due Wed 25 Nov, 23:59 AoE",
    );
    expect(body).toContain("Coming up later:\n• Ada Lovelace — due Tue 1 Dec, 23:59 Toronto time");
  });
});

describe("readableDeadline", () => {
  it("names the day and spells zones for a person, not a computer", () => {
    expect(readableDeadline({ date: "2026-11-25", time: "23:59", timezone: "Etc/GMT+12" })).toBe(
      "Wed 25 Nov, 23:59 AoE",
    );
    expect(readableDeadline({ date: "2026-11-25", time: "23:59", timezone: "Europe/Berlin" })).toBe(
      "Wed 25 Nov, 23:59 Berlin time",
    );
    expect(
      readableDeadline({ date: "2026-12-15", time: "12:00", timezone: "America/New_York" }),
    ).toBe("Tue 15 Dec, 12:00 New York time");
    expect(readableDeadline({ date: "2026-11-23", time: "23:59", timezone: "PST" })).toBe(
      "Mon 23 Nov, 23:59 PST",
    );
  });
});
