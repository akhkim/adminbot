// Which past-due letters the student is asked about, and what the question says.
import { describe, expect, it } from "vitest";
import type { AdminBotLogisticsRequest } from "../../contracts/actions.js";
import {
  recLetterOverdueBody,
  recLetterOverdueConfirmationsDue,
  recLetterOverdueLedgerSubject,
  recLetterOverdueSubject,
} from "./rec-letter-overdue.js";

const NOW = new Date("2026-12-10T09:00:00Z");

function letters(
  overrides: Partial<AdminBotLogisticsRequest> & { id: string; at?: string },
): AdminBotLogisticsRequest {
  const { at = "2026-12-01T23:59:00Z", ...rest } = overrides;
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
    deadline_at: at,
    ...rest,
  };
}

describe("recLetterOverdueConfirmationsDue", () => {
  it("takes a letter past its deadline and leaves one still ahead", () => {
    const due = recLetterOverdueConfirmationsDue(
      [
        letters({ id: "past", at: "2026-12-01T23:59:00Z" }),
        letters({ id: "ahead", at: "2026-12-20T12:00:00Z" }),
      ],
      NOW,
    );

    expect(due.map((entry) => entry.request_id)).toEqual(["past"]);
    expect(due[0]).toMatchObject({
      member_id: "ada",
      deadline_at: "2026-12-01T23:59:00.000Z",
      deadline_label: "2026-12-01 23:59 UTC",
      days_overdue: 8,
      schools: ["MIT"],
    });
  });

  it("waits until the deadline instant itself has passed", () => {
    const at = "2026-12-10T09:00:00Z";
    expect(recLetterOverdueConfirmationsDue([letters({ id: "now", at })], NOW)).toEqual([]);
    expect(
      recLetterOverdueConfirmationsDue(
        [letters({ id: "now", at })],
        new Date("2026-12-10T09:01:00Z"),
      ),
    ).toHaveLength(1);
  });

  it("stops asking about 60 days after the deadline", () => {
    const due = recLetterOverdueConfirmationsDue(
      [
        letters({ id: "edge", at: "2026-10-11T09:00:00Z" }),
        letters({ id: "stale", at: "2026-10-10T08:00:00Z" }),
      ],
      NOW,
    );
    expect(due.map((entry) => entry.request_id)).toEqual(["edge"]);
  });

  it("skips settled requests and other kinds", () => {
    const due = recLetterOverdueConfirmationsDue(
      [
        letters({ id: "done", status: "completed" }),
        letters({ id: "declined", status: "declined" }),
        letters({ id: "withdrawn", status: "withdrawn" }),
        letters({ id: "working", status: "in_progress" }),
        letters({ id: "other", kind: "reimbursement" as AdminBotLogisticsRequest["kind"] }),
      ],
      NOW,
    );
    expect(due.map((entry) => entry.request_id)).toEqual(["working"]);
  });

  it("ignores a deadline whose year was never typed", () => {
    const request = letters({
      id: "no-year",
      deadline_at: undefined,
      schools: [{ school: "MIT", letter_deadline: "Dec 1", deadline_timezone: "UTC" }],
    });
    expect(recLetterOverdueConfirmationsDue([request], NOW)).toEqual([]);
  });

  it("ignores a request with no deadline at all", () => {
    expect(
      recLetterOverdueConfirmationsDue(
        [letters({ id: "none", deadline_at: undefined, schools: [] })],
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("the ledger subject", () => {
  it("is keyed by request and deadline, apart from the reminder's", () => {
    expect(
      recLetterOverdueLedgerSubject({ request_id: "r1", deadline_at: "2026-12-01T23:59:00Z" }),
    ).toBe("rec_letter_overdue|r1|2026-12-01T23:59:00Z");
  });
});

describe("the mail", () => {
  it("asks one student about one letter and links the requests page", () => {
    const due = recLetterOverdueConfirmationsDue([letters({ id: "past" })], NOW);
    const body = recLetterOverdueBody(due, "https://portal.example/rec-letters?view=requests");

    expect(recLetterOverdueSubject(due)).toBe("Did your recommendation letter go in?");
    expect(body).toContain("Hi Ada,");
    expect(body).toContain("still shows it as not submitted");
    expect(body).toContain("• MIT — due 2026-12-01 23:59 UTC");
    expect(body).toContain("Letter was submitted");
    expect(body).toContain("https://portal.example/rec-letters?view=requests");
  });

  it("counts several letters in the subject", () => {
    const due = recLetterOverdueConfirmationsDue(
      [letters({ id: "a" }), letters({ id: "b", at: "2026-12-02T12:00:00Z" })],
      NOW,
    );
    expect(recLetterOverdueSubject(due)).toBe("Did your 2 recommendation letters go in?");
    expect(recLetterOverdueBody(due, "u")).toContain("have passed");
  });
});
