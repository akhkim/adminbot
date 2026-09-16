// The window, and what the mail says once something is inside it.
import { describe, expect, it } from "vitest";
import type { AdminBotLogisticsRequest } from "../../contracts/actions.js";
import {
  recLetterReminderBody,
  recLetterReminderLedgerSubject,
  recLetterReminderSubject,
  recLetterRemindersDue,
} from "./rec-letter-reminders.js";

const NOW = new Date("2026-11-28T09:00:00Z");

function letters(
  overrides: Partial<AdminBotLogisticsRequest> & { id: string },
): AdminBotLogisticsRequest {
  return {
    kind: "recommendation_letters",
    member_id: "ada",
    member_name: "Ada Lovelace",
    status: "submitted",
    submitted_at: "2026-11-01T09:00:00Z",
    updated_at: "2026-11-01T09:00:00Z",
    schools: [{ school: "MIT", letter_deadline: "2026-12-01" }],
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
      [letters({ id: "req_1", deadline_at: "2026-11-30T23:59:00Z" })],
      NOW,
    );

    expect(first && recLetterReminderLedgerSubject(first)).toBe(
      "rec_letter|req_1|2026-12-01T23:59:00Z",
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
    expect(recLetterReminderSubject(two)).toBe("2 recommendation letters due within 3 days");
  });

  it("lists each letter with its date, its schools and where to read the request", () => {
    const due = recLetterRemindersDue(
      [
        letters({
          id: "one",
          schools: [{ school: "MIT" }, { school: "Stanford" }],
        }),
      ],
      NOW,
    );

    const body = recLetterReminderBody(due, "https://portal.example");
    expect(body).toContain("• Ada Lovelace — due 2026-12-01 (in 3 days) — MIT, Stanford");
    expect(body).toContain("https://portal.example");
  });

  it("stops listing schools before the line becomes a paragraph", () => {
    const due = recLetterRemindersDue(
      [
        letters({
          id: "many",
          schools: ["MIT", "Stanford", "CMU", "Berkeley", "ETH", "Oxford", "UofT"].map(
            (school) => ({ school }),
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
