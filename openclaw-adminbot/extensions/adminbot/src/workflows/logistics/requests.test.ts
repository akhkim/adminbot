import { describe, expect, it } from "vitest";
import type { AdminBotLogisticsRequest } from "../../contracts/actions.js";
import {
  MAX_ATTACHMENT_BYTES,
  base64ByteLength,
  byUrgency,
  deadlineInstant,
  meetingInstant,
  normalizeLogisticsRequestInput,
  prepareLogisticsRequest,
  requestDeadline,
  validateLogisticsRequest,
  withoutAttachmentBytes,
} from "./requests.js";

const identity = { id: "logreq_1", member_id: "m1", member_name: "Ada" };
const NOW = "2026-08-19T10:00:00.000Z";

function base64OfBytes(count: number): string {
  return Buffer.alloc(count, 1).toString("base64");
}

describe("base64ByteLength", () => {
  it("measures the decoded size without decoding it", () => {
    expect(base64ByteLength(Buffer.from("hello").toString("base64"))).toBe(5);
    expect(base64ByteLength(base64OfBytes(3000))).toBe(3000);
  });

  it("refuses anything that is not base64, which is what keeps the cap honest", () => {
    expect(base64ByteLength("not base64!!")).toBe(-1);
    expect(base64ByteLength("abc")).toBe(-1);
  });
});

describe("deadlineInstant", () => {
  it("treats a date with no time as due at the end of that day, not the start", () => {
    expect(deadlineInstant("2026-12-01", "", "UTC")).toBe("2026-12-01T23:59:00.000Z");
  });

  it("reads a time in the zone the row names, daylight saving included", () => {
    // 17:00 in New York is 22:00 UTC in December and 21:00 UTC in June.
    expect(deadlineInstant("2026-12-01", "17:00", "America/New_York")).toBe(
      "2026-12-01T22:00:00.000Z",
    );
    expect(deadlineInstant("2026-06-01", "17:00", "America/New_York")).toBe(
      "2026-06-01T21:00:00.000Z",
    );
  });

  it("falls back to UTC when the row names no zone", () => {
    expect(deadlineInstant("2026-12-01", "09:00")).toBe("2026-12-01T09:00:00.000Z");
  });

  it("has no instant for something that is not a date", () => {
    expect(deadlineInstant("next Tuesday", "17:00", "UTC")).toBeUndefined();
    expect(deadlineInstant("", "", "UTC")).toBeUndefined();
  });
});

describe("meetingInstant", () => {
  it("resolves a proposed slot against the requester's own clock", () => {
    expect(
      meetingInstant({
        purpose: "check-in",
        preferred_time: "2026-09-01T14:30",
        timezone: "Europe/London",
      }),
    ).toBe("2026-09-01T13:30:00.000Z");
  });

  it("has no instant for a row with no proposed time", () => {
    expect(meetingInstant({ purpose: "check-in" })).toBeUndefined();
  });
});

describe("requestDeadline", () => {
  it("takes the soonest of every date on every school -- either one passing makes a letter late", () => {
    expect(
      requestDeadline({
        kind: "recommendation_letters",
        schools: [
          {
            school: "A",
            application_deadline: "2026-12-01",
            letter_deadline: "2026-11-15",
          },
          { school: "B", application_deadline: "2026-10-01" },
        ],
      }),
    ).toBe("2026-10-01T23:59:00.000Z");
  });

  it("sorts two same-day deadlines by the time and zone they were given in", () => {
    const morning = requestDeadline({
      kind: "recommendation_letters",
      schools: [
        {
          school: "A",
          letter_deadline: "2026-12-01",
          letter_deadline_time: "09:00",
          deadline_timezone: "UTC",
        },
      ],
    });
    const evening = requestDeadline({
      kind: "recommendation_letters",
      schools: [
        {
          school: "B",
          letter_deadline: "2026-12-01",
          letter_deadline_time: "23:00",
          deadline_timezone: "UTC",
        },
      ],
    });
    expect(morning && evening && morning < evening).toBe(true);
  });

  it("uses the proposed slot on a meeting request", () => {
    expect(
      requestDeadline({
        kind: "book_meeting",
        meetings: [
          {
            purpose: "later",
            preferred_time: "2026-09-10T09:00",
            timezone: "UTC",
          },
          {
            purpose: "sooner",
            preferred_time: "2026-09-02T09:00",
            timezone: "UTC",
          },
        ],
      }),
    ).toBe("2026-09-02T09:00:00.000Z");
  });

  it("gives a signature request none, because the date lives in the member's prose", () => {
    expect(
      requestDeadline({
        kind: "document_signature",
        description: "needed by Friday please",
      }),
    ).toBeUndefined();
  });
});

describe("normalizeLogisticsRequestInput", () => {
  it("drops the fields belonging to another template", () => {
    const normalized = normalizeLogisticsRequestInput({
      kind: "book_meeting",
      meetings: [{ purpose: "sync" }],
      schools: [{ school: "Somewhere", application_deadline: "2026-01-01" }],
      description: "ignore me",
    });
    expect(normalized).toEqual({
      kind: "book_meeting",
      meetings: [{ purpose: "sync" }],
    });
  });

  it("drops the blank row left at the bottom of a table", () => {
    const normalized = normalizeLogisticsRequestInput({
      kind: "recommendation_letters",
      schools: [{ school: "MIT" }, { school: "   " }],
      facts: [{ project: "", contribution: "" }],
    });
    expect(normalized.schools).toEqual([{ school: "MIT" }]);
    expect(normalized.facts).toEqual([]);
  });

  it("measures a file from its bytes rather than the size the client claimed", () => {
    const normalized = normalizeLogisticsRequestInput({
      kind: "document_signature",
      documents: [
        {
          name: "form.pdf",
          size: 1,
          content_type: "application/pdf",
          data_base64: base64OfBytes(900),
        },
      ],
    });
    expect(normalized.documents?.[0]?.size).toBe(900);
  });

  it("clamps a meeting length that could not have been meant", () => {
    const normalized = normalizeLogisticsRequestInput({
      kind: "book_meeting",
      meetings: [{ purpose: "sync", length_minutes: 99_999 }],
    });
    expect(normalized.meetings?.[0]?.length_minutes).toBe(1440);
  });
});

describe("validateLogisticsRequest", () => {
  it("refuses an empty request of every kind, because an empty one still costs an admin a click", () => {
    expect(validateLogisticsRequest({ kind: "document_signature", documents: [] })).toMatch(
      /at least one document/u,
    );
    expect(validateLogisticsRequest({ kind: "recommendation_letters", schools: [] })).toMatch(
      /at least one school/u,
    );
    expect(validateLogisticsRequest({ kind: "book_meeting", meetings: [] })).toMatch(
      /at least one proposed meeting/u,
    );
  });

  it("refuses a file past the per-file cap", () => {
    expect(
      validateLogisticsRequest({
        kind: "document_signature",
        documents: [{ name: "huge.pdf", size: MAX_ATTACHMENT_BYTES + 1 }],
      }),
    ).toMatch(/larger than/u);
  });

  it("refuses a school row with no school on it", () => {
    expect(
      validateLogisticsRequest({
        kind: "recommendation_letters",
        schools: [{ school: "", notes: "the one with the nice campus" }],
      }),
    ).toMatch(/school's name/u);
  });
});

describe("prepareLogisticsRequest", () => {
  it("stamps the requester from the session and derives the deadline once", () => {
    const prepared = prepareLogisticsRequest(
      {
        kind: "recommendation_letters",
        schools: [
          {
            school: "MIT",
            letter_deadline: "2026-12-01",
            letter_deadline_time: "17:00",
            deadline_timezone: "America/New_York",
          },
        ],
      },
      identity,
      NOW,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    expect(prepared.request).toMatchObject({
      id: "logreq_1",
      member_id: "m1",
      member_name: "Ada",
      status: "submitted",
      submitted_at: NOW,
      deadline_at: "2026-12-01T22:00:00.000Z",
    });
  });

  it("reports why a request was refused rather than storing half of it", () => {
    const prepared = prepareLogisticsRequest({ kind: "book_meeting" }, identity, NOW);
    expect(prepared).toEqual({
      ok: false,
      error: expect.stringMatching(/proposed meeting/u),
    });
  });

  it("refuses a kind it does not have a template for", () => {
    const prepared = prepareLogisticsRequest({ kind: "buy_me_a_boat" } as never, identity, NOW);
    expect(prepared.ok).toBe(false);
  });
});

describe("withoutAttachmentBytes", () => {
  it("keeps what a list has to say about a file and drops what it does not need", () => {
    const prepared = prepareLogisticsRequest(
      {
        kind: "document_signature",
        documents: [{ name: "form.pdf", size: 0, data_base64: base64OfBytes(64) }],
      },
      identity,
      NOW,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    const listed = withoutAttachmentBytes(prepared.request);
    expect(listed.documents).toEqual([{ name: "form.pdf", size: 64 }]);
  });
});

describe("byUrgency", () => {
  const request = (fields: Partial<AdminBotLogisticsRequest>): AdminBotLogisticsRequest => ({
    id: "r",
    kind: "document_signature",
    member_id: "m1",
    member_name: "Ada",
    status: "submitted",
    submitted_at: NOW,
    updated_at: NOW,
    ...fields,
  });

  it("puts the nearest deadline first and the deadline-less request last", () => {
    const soon = request({
      id: "soon",
      deadline_at: "2026-09-01T00:00:00.000Z",
    });
    const later = request({
      id: "later",
      deadline_at: "2026-12-01T00:00:00.000Z",
    });
    const none = request({ id: "none" });
    expect([none, later, soon].toSorted(byUrgency).map((entry) => entry.id)).toEqual([
      "soon",
      "later",
      "none",
    ]);
  });

  it("breaks a tie on the most recently submitted", () => {
    const older = request({
      id: "older",
      submitted_at: "2026-08-01T00:00:00.000Z",
    });
    const newer = request({
      id: "newer",
      submitted_at: "2026-08-18T00:00:00.000Z",
    });
    expect([older, newer].toSorted(byUrgency).map((entry) => entry.id)).toEqual(["newer", "older"]);
  });
});
