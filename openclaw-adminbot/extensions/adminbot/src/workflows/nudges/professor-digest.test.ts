import { describe, expect, it } from "vitest";
import type { AdminBotLogisticsRequest } from "../../contracts/actions.js";
import type { PiReviewRow } from "../papers/pi-review.js";
import {
  groupProfessorDigest,
  professorDigestBody,
  professorDigestBucket,
  professorDigestDefaults,
  professorDigestItems,
  professorDigestLocalClock,
  professorDigestSubject,
  resolveProfessorDigestConfig,
  type ProfessorDigestItem,
} from "./professor-digest.js";

const NOW = new Date("2027-03-10T14:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const config = { ...professorDigestDefaults, enabled: true };

function item(partial: Partial<ProfessorDigestItem> & { key: string }): ProfessorDigestItem {
  return { source: "paper", title: partial.key, path: "/professor", ...partial };
}

describe("professorDigestBucket thresholds", () => {
  it.each([
    ["one minute past the deadline", { deadline_at: at(-60_000) }, "overdue"],
    ["29 days past the deadline", { deadline_at: at(-29 * DAY) }, "overdue"],
    ["exactly 48 hours out", { deadline_at: at(48 * HOUR) }, "due_48h"],
    ["just over 48 hours out", { deadline_at: at(48 * HOUR + 60_000) }, "due_7d"],
    ["exactly 7 days out", { deadline_at: at(7 * DAY) }, "due_7d"],
    ["no deadline, waiting 8 days", { waiting_since: at(-8 * DAY) }, "waiting"],
  ] as const)("%s -> %s", (_label, fields, bucket) => {
    expect(professorDigestBucket(fields, NOW, config)).toBe(bucket);
  });

  it.each([
    [
      "more than 7 days out, however long it has waited",
      { deadline_at: at(8 * DAY), waiting_since: at(-60 * DAY) },
    ],
    ["no deadline, waiting exactly 7 days", { waiting_since: at(-7 * DAY) }],
    ["no deadline and no waiting time", {}],
    [
      "a deadline more than staleDays gone (an obsolete camera-ready)",
      { deadline_at: at(-31 * DAY) },
    ],
    ["an unparseable deadline", { deadline_at: "not a date" }],
  ])("leaves out %s", (_label, fields) => {
    expect(professorDigestBucket(fields, NOW, config)).toBeUndefined();
  });

  it("reads its thresholds from config", () => {
    const tight = { ...config, urgentHours: 12, soonDays: 2, waitingDays: 1, staleDays: 3 };
    expect(professorDigestBucket({ deadline_at: at(24 * HOUR) }, NOW, tight)).toBe("due_7d");
    expect(professorDigestBucket({ deadline_at: at(3 * DAY) }, NOW, tight)).toBeUndefined();
    expect(professorDigestBucket({ waiting_since: at(-2 * DAY) }, NOW, tight)).toBe("waiting");
    expect(professorDigestBucket({ deadline_at: at(-4 * DAY) }, NOW, tight)).toBeUndefined();
  });
});

describe("groupProfessorDigest", () => {
  it("groups by urgency and orders each group most urgent first", () => {
    const groups = groupProfessorDigest(
      [
        item({ key: "later", deadline_at: at(5 * DAY) }),
        item({ key: "late-2", deadline_at: at(-1 * DAY) }),
        item({ key: "late-1", deadline_at: at(-3 * DAY) }),
        item({ key: "tomorrow", deadline_at: at(20 * HOUR) }),
        item({ key: "old", waiting_since: at(-30 * DAY) }),
        item({ key: "older", waiting_since: at(-40 * DAY) }),
        item({ key: "fresh", waiting_since: at(-1 * DAY) }),
      ],
      NOW,
      config,
    );
    expect(
      Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.map((i) => i.key)])),
    ).toEqual({
      overdue: ["late-1", "late-2"],
      due_48h: ["tomorrow"],
      due_7d: ["later"],
      waiting: ["older", "old"],
    });
  });
});

describe("professorDigestItems", () => {
  const row = (fields: Partial<PiReviewRow>): PiReviewRow => ({
    category: "camera_ready",
    paper_id: "p1",
    title: "Causal Probing",
    authors: ["Ada"],
    package_complete: true,
    ...fields,
  });
  const request = (fields: Partial<AdminBotLogisticsRequest>): AdminBotLogisticsRequest => ({
    id: "r1",
    kind: "document_signature",
    member_id: "ada",
    member_name: "Ada Lovelace",
    status: "submitted",
    submitted_at: at(-10 * DAY),
    updated_at: at(-10 * DAY),
    ...fields,
  });

  it("reads every queue, leaves out settled requests and papers the venue owes, and links each", () => {
    const items = professorDigestItems(
      {
        papers: [
          row({ hard_deadline: at(DAY), venue: "ICML 2027" }),
          row({ paper_id: "p2", category: "under_review" }),
        ],
        requests: [
          request({}),
          request({ id: "r2", status: "completed" }),
          request({
            id: "r3",
            kind: "recommendation_letters",
            schools: [{ school: "MIT", letter_deadline: "2027-03-11" }],
          }),
          request({ id: "r4", kind: "book_meeting", meetings: [{ purpose: "Thesis plan" }] }),
        ],
        missingInfo: [
          {
            member_id: "grace",
            name: "Grace Hopper",
            escalated_at: at(-9 * DAY),
            notifications: [{ title: "Add your poster" }, { title: "Confirm attendance" }],
          },
        ],
        pending: [
          { created_at: at(-8 * DAY) },
          { created_at: at(-9 * DAY) },
          { created_at: at(-1 * DAY) },
        ],
      },
      NOW,
      config,
    );
    expect(items.map((entry) => [entry.source, entry.path])).toEqual([
      ["paper", "/professor"],
      ["signature", "/signatures"],
      ["rec_letter", "/rec-letters"],
      ["meeting_request", "/meeting-requests"],
      ["missing_info", "/professor"],
      ["pending_actions", "/pending-actions"],
    ]);
    expect(items.find((entry) => entry.source === "pending_actions")).toMatchObject({
      title: "2 actions waiting for approval",
      waiting_since: at(-9 * DAY),
    });
    expect(items.find((entry) => entry.source === "rec_letter")?.deadline_at).toBeDefined();
    expect(items[0]?.title).toBe("Camera-ready: Causal Probing");
  });
});

describe("subject and body", () => {
  const groups = () =>
    groupProfessorDigest(
      [
        item({ key: "late", title: "Camera-ready: Causal Probing", deadline_at: at(-2 * DAY) }),
        item({
          key: "soon",
          title: "Recommendation letter for Ada",
          deadline_at: at(30 * HOUR),
          path: "/rec-letters",
        }),
        item({
          key: "sig",
          title: "Signature for Grace",
          waiting_since: at(-12 * DAY),
          path: "/signatures",
        }),
      ],
      NOW,
      config,
    );

  it("escalates the subject with the most urgent group, and again once an overdue item repeats", () => {
    expect(professorDigestSubject(groups())).toBe(
      "OVERDUE: 1 item past deadline (3 waiting on you)",
    );
    expect(professorDigestSubject(groups(), new Map([["late", 1]]))).toBe(
      "STILL OVERDUE: 1 item past deadline (3 waiting on you)",
    );
    const noOverdue = { ...groups(), overdue: [] };
    expect(professorDigestSubject(noOverdue)).toBe(
      "Due within 48 hours: 1 item (2 waiting on you)",
    );
    expect(professorDigestSubject({ ...noOverdue, due_48h: [] })).toBe("Waiting on you: 1 item");
  });

  it("lists each group with links and reminder counts", () => {
    const body = professorDigestBody({
      groups: groups(),
      now: NOW,
      timezone: "America/Toronto",
      portalUrl: "https://portal.example",
      timesFlagged: new Map([["late", 2]]),
    });
    expect(body).toContain("PAST DEADLINE (1)");
    expect(body).toContain(
      "- Camera-ready: Causal Probing — was due Mon, Mar 8 (2 days ago) [reminder #3]",
    );
    expect(body).toContain("  https://portal.example/rec-letters");
    expect(body).toContain("DUE WITHIN 48 HOURS (1)");
    expect(body).toContain("WAITING MORE THAN A WEEK (NO DEADLINE) (1)");
    expect(body).toContain("Signature for Grace — waiting 12 days");
    expect(body).not.toContain("DUE WITHIN 7 DAYS");
  });
});

describe("config and clock", () => {
  it("defaults to off, and falls back per value on a typo", () => {
    expect(resolveProfessorDigestConfig({})).toEqual(professorDigestDefaults);
    expect(
      resolveProfessorDigestConfig({
        ADMINBOT_PROFESSOR_DIGEST_ENABLED: "1",
        ADMINBOT_PROFESSOR_DIGEST_HOUR: "25",
        ADMINBOT_PROFESSOR_DIGEST_TIMEZONE: "Mars/Olympus",
        ADMINBOT_PROFESSOR_DIGEST_URGENT_HOURS: "24",
        ADMINBOT_PROFESSOR_DIGEST_WAITING_DAYS: "ten",
      }),
    ).toEqual({ ...professorDigestDefaults, enabled: true, urgentHours: 24 });
    expect(
      resolveProfessorDigestConfig({ ADMINBOT_PROFESSOR_DIGEST_TIMEZONE: "Europe/Zurich" })
        .timezone,
    ).toBe("Europe/Zurich");
  });

  it("reads the local day and hour in the configured zone", () => {
    expect(professorDigestLocalClock(new Date("2027-03-10T03:30:00Z"), "America/Toronto")).toEqual({
      date: "2027-03-09",
      hour: 22,
    });
  });
});
