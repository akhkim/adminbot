import { describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import type { AdminBotConferenceAttendeeRecord } from "../../contracts/paper-cycle.js";
import {
  buildConferenceAttendance,
  conferenceKey,
  conferenceLabel,
  expectedConferenceAttendees,
  mergeConferenceAttendance,
  unansweredConferenceAttendees,
} from "./conference-attendance.js";

function paper(overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "Causal abstraction",
    authors: ["Ada Lovelace", "Rahul Mehta"],
    current_step: "overleaf_writing",
    venue_decision: "accept",
    accepted_venue: "EMNLP",
    accepted_year: 2026,
    is_archival: true,
    presentation_type: "poster",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function answer(
  key: string,
  attending: AdminBotConferenceAttendeeRecord["attending"],
  overrides: Partial<AdminBotConferenceAttendeeRecord> = {},
): AdminBotConferenceAttendeeRecord {
  return { paper_id: "p1", attendee_key: key, name: key, attending, ...overrides };
}

describe("expectedConferenceAttendees", () => {
  it("keys linked authors by member id, so a rename does not split the row", () => {
    const expected = expectedConferenceAttendees(
      paper({
        author_links: [
          { name: "Ada Lovelace", member_id: "ada" },
          { name: "Rahul Mehta", email: "rahul@elsewhere.edu" },
        ],
      }),
    );
    expect(expected).toEqual([
      { attendee_key: "member:ada", name: "Ada Lovelace", member_id: "ada" },
      // The external coauthor is on the roll-call: the first author answers for them, and "the
      // visiting coauthor is presenting" is exactly what the roster is for.
      { attendee_key: "name:rahul-mehta", name: "Rahul Mehta" },
    ]);
  });

  it("falls back to the printed names on a paper filed before author linking", () => {
    expect(expectedConferenceAttendees(paper()).map((entry) => entry.attendee_key)).toEqual([
      "name:ada-lovelace",
      "name:rahul-mehta",
    ]);
  });

  it("counts a name printed twice as one person owing one answer", () => {
    const expected = expectedConferenceAttendees(
      paper({ authors: ["Ada Lovelace", "ada  lovelace", ""] }),
    );
    expect(expected).toHaveLength(1);
  });
});

describe("mergeConferenceAttendance", () => {
  it("shows every author as unanswered before anybody has answered", () => {
    const merged = mergeConferenceAttendance(paper(), []);
    expect(merged.map((row) => [row.name, row.attending])).toEqual([
      ["Ada Lovelace", "unknown"],
      ["Rahul Mehta", "unknown"],
    ]);
  });

  it("keeps the stored answer and the print order", () => {
    const merged = mergeConferenceAttendance(paper(), [answer("name:rahul-mehta", "yes")]);
    expect(merged.map((row) => row.attending)).toEqual(["unknown", "yes"]);
  });

  it("keeps a hand-added attendee who is not on the paper", () => {
    const merged = mergeConferenceAttendance(paper(), [
      answer("name:jo-park", "yes", { name: "Jo Park" }),
    ]);
    expect(merged.at(-1)?.name).toBe("Jo Park");
    expect(merged).toHaveLength(3);
  });

  it("reports who still owes an answer", () => {
    expect(
      unansweredConferenceAttendees(paper(), [answer("name:ada-lovelace", "no")]).map(
        (row) => row.name,
      ),
    ).toEqual(["Rahul Mehta"]);
  });
});

describe("conferenceKey", () => {
  it("folds spelling differences together but never guesses at expansions", () => {
    expect(conferenceKey(" EMNLP ", 2026)).toBe(conferenceKey("emnlp", 2026));
    expect(conferenceKey("EMNLP", 2026)).not.toBe(conferenceKey("EMNLP", 2025));
    expect(conferenceKey("Empirical Methods in NLP", 2026)).not.toBe(conferenceKey("EMNLP", 2026));
  });

  it("does not say the year twice when the venue text already carries it", () => {
    expect(conferenceLabel("EMNLP", 2026)).toBe("EMNLP 2026");
    expect(conferenceLabel("EMNLP 2026", 2026)).toBe("EMNLP 2026");
  });
});

describe("buildConferenceAttendance", () => {
  const second = paper({
    id: "p2",
    title: "Robustness bounds",
    authors: ["Ada Lovelace", "Jo Park"],
    accepted_venue: "emnlp",
  });

  it("gathers one roster per conference across every accepted paper", () => {
    const conferences = buildConferenceAttendance([
      { paper: paper(), attendees: [answer("name:ada-lovelace", "yes")] },
      { paper: second, attendees: [] },
    ]);
    expect(conferences).toHaveLength(1);
    const [emnlp] = conferences;
    expect(emnlp?.label).toBe("EMNLP 2026");
    expect(emnlp?.paper_count).toBe(2);
    expect(emnlp?.people.map((person) => [person.name, person.attending])).toEqual([
      // One yes anywhere means the trip is happening, whatever the other paper says.
      ["Ada Lovelace", "yes"],
      ["Jo Park", "unknown"],
      ["Rahul Mehta", "unknown"],
    ]);
    expect(emnlp?.going_count).toBe(1);
    expect(emnlp?.unanswered_count).toBe(2);
  });

  it("carries every paper a person is on at that conference", () => {
    const [emnlp] = buildConferenceAttendance([
      { paper: paper(), attendees: [] },
      { paper: second, attendees: [] },
    ]);
    const ada = emnlp?.people.find((person) => person.name === "Ada Lovelace");
    expect(ada?.papers.map((entry) => entry.paper_id)).toEqual(["p1", "p2"]);
  });

  it("resolves to no only when every answer about them is no", () => {
    const [emnlp] = buildConferenceAttendance([
      {
        paper: paper(),
        attendees: [answer("name:ada-lovelace", "no"), answer("name:rahul-mehta", "no")],
      },
      { paper: second, attendees: [answer("name:ada-lovelace", "no", { paper_id: "p2" })] },
    ]);
    expect(emnlp?.people.find((person) => person.name === "Ada Lovelace")?.attending).toBe("no");
    expect(emnlp?.unanswered_count).toBe(1);
  });

  it("names the papers still owing an answer, worst first", () => {
    const [emnlp] = buildConferenceAttendance([
      { paper: paper(), attendees: [answer("name:ada-lovelace", "yes")] },
      { paper: second, attendees: [] },
    ]);
    expect(emnlp?.papers_awaiting).toEqual([
      { paper_id: "p2", title: "Robustness bounds", unanswered: 2 },
      { paper_id: "p1", title: "Causal abstraction", unanswered: 1 },
    ]);
  });

  it("keeps two years of the same conference apart, newest first", () => {
    const conferences = buildConferenceAttendance([
      { paper: paper({ id: "old", accepted_year: 2025 }), attendees: [] },
      { paper: paper(), attendees: [] },
    ]);
    expect(conferences.map((entry) => entry.year)).toEqual([2026, 2025]);
  });
});
