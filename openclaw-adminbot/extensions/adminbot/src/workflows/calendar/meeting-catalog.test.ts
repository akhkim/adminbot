import { describe, expect, it } from "vitest";
import {
  meetingCatalogFromEvents,
  meetingCatalogTopics,
  meetingTitleParts,
  memberMeetingTopics,
  resolveMeetingChoice,
  seriesEventId,
} from "./meeting-catalog.js";

const SERIES = "f4d1qkcntmet3g8033kbugn40q";

describe("seriesEventId", () => {
  it("strips the occurrence suffix a windowed calendar read returns", () => {
    expect(seriesEventId(`${SERIES}_20260923T130000Z`)).toBe(SERIES);
    expect(seriesEventId(`${SERIES}_20260923`)).toBe(SERIES);
  });

  it("leaves an ordinary id alone, underscores included", () => {
    expect(seriesEventId("lab_lunch_2026")).toBe("lab_lunch_2026");
    expect(seriesEventId(SERIES)).toBe(SERIES);
  });
});

describe("meetingTitleParts", () => {
  it("reads both families and nothing else", () => {
    expect(meetingTitleParts("Theme: Causal Inference")).toEqual({
      family: "theme",
      topic: "Causal Inference",
    });
    expect(meetingTitleParts("Proj: Law to Benchmark")).toEqual({
      family: "project",
      topic: "Law to Benchmark",
    });
    expect(meetingTitleParts("Lab lunch")).toBeNull();
    expect(meetingTitleParts("Theme:")).toBeNull();
  });
});

describe("meetingCatalogFromEvents", () => {
  const NOW = "2026-09-20T00:00:00.000Z";

  it("collapses a term of occurrences onto one meeting, keeping the earliest start", () => {
    const catalog = meetingCatalogFromEvents(
      [
        {
          id: `${SERIES}_20260930T130000Z`,
          summary: "Theme: Causal Inference",
          start: "2026-09-30T13:00:00Z",
        },
        {
          id: `${SERIES}_20260923T130000Z`,
          summary: "Theme: Causal Inference",
          start: "2026-09-23T13:00:00Z",
        },
        {
          id: `${SERIES}_20261007T130000Z`,
          summary: "Theme: Causal Inference",
          start: "2026-10-07T13:00:00Z",
        },
      ],
      { calendarId: "lab@example.com", now: NOW },
    );
    expect(catalog).toEqual([
      {
        event_id: SERIES,
        calendar_id: "lab@example.com",
        family: "theme",
        topic: "Causal Inference",
        summary: "Theme: Causal Inference",
        starts_at: "2026-09-23T13:00:00Z",
        updated_at: NOW,
      },
    ]);
  });

  it("keeps only standing meetings, sorted by topic", () => {
    const catalog = meetingCatalogFromEvents(
      [
        {
          id: "e1",
          summary: "Proj: Law to Benchmark",
          start: "2026-09-21T15:00:00Z",
        },
        { id: "e2", summary: "Lab lunch", start: "2026-09-21T16:00:00Z" },
        {
          id: "e3",
          summary: "Theme: Multi-Agent",
          start: "2026-09-23T13:00:00Z",
        },
        { id: "", summary: "Theme: Nameless", start: "2026-09-23T13:00:00Z" },
      ],
      { now: NOW },
    );
    expect(catalog.map((entry) => [entry.topic, entry.family])).toEqual([
      ["Law to Benchmark", "project"],
      ["Multi-Agent", "theme"],
    ]);
  });

  it("keeps two different series that answer to one topic, so the pair stays visible", () => {
    const catalog = meetingCatalogFromEvents(
      [
        {
          id: "left",
          summary: "Theme: Causal LLM",
          start: "2026-09-23T13:00:00Z",
        },
        {
          id: "right",
          summary: "Theme: Causal LLM",
          start: "2026-09-23T13:00:00Z",
        },
      ],
      { now: NOW },
    );
    expect(catalog).toHaveLength(2);
    expect(resolveMeetingChoice("Causal LLM", catalog)).toEqual({
      ok: false,
      reason: "ambiguous",
    });
  });
});

describe("meetingCatalogTopics", () => {
  it("is the picker's vocabulary, without repeats", () => {
    const catalog = meetingCatalogFromEvents(
      [
        { id: "a", summary: "Theme: Multi-Agent" },
        { id: "b", summary: "Proj: Multi-Agent" },
        { id: "c", summary: "Theme: Mech Interp" },
      ],
      { now: "2026-09-20T00:00:00.000Z" },
    );
    expect(meetingCatalogTopics(catalog)).toEqual(["Mech Interp", "Multi-Agent"]);
  });

  it("offers one box for two spellings of one topic", () => {
    // Order is left to the catalog (collation decides which spelling leads); what matters is that
    // a member is not asked to choose between "Multi-Agent" and "Multi-agent".
    expect(
      meetingCatalogTopics([
        {
          event_id: "a",
          family: "theme",
          topic: "Multi-Agent",
          summary: "Theme: Multi-Agent",
          updated_at: "2026-09-20T00:00:00.000Z",
        },
        {
          event_id: "b",
          family: "project",
          topic: "multi-agent",
          summary: "Proj: multi-agent",
          updated_at: "2026-09-20T00:00:00.000Z",
        },
      ]),
    ).toHaveLength(1);
  });
});

describe("resolveMeetingChoice", () => {
  const catalog = meetingCatalogFromEvents(
    [
      {
        id: SERIES,
        summary: "Theme: Causal Inference",
        start: "2026-09-23T13:00:00Z",
      },
    ],
    { calendarId: "lab@example.com", now: "2026-09-20T00:00:00.000Z" },
  );

  it("matches the topic a member picked, whatever case they picked it in", () => {
    const choice = resolveMeetingChoice("causal inference", catalog);
    expect(choice.ok && choice.entry.event_id).toBe(SERIES);
  });

  it("reports an answer the calendar no longer carries rather than guessing at one", () => {
    expect(resolveMeetingChoice("Retired Theme", catalog)).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(resolveMeetingChoice("  ", catalog)).toEqual({
      ok: false,
      reason: "unknown",
    });
  });
});

describe("memberMeetingTopics", () => {
  it("drops blanks and repeats and keeps everything else as the member wrote it", () => {
    expect(
      memberMeetingTopics({
        meetings: ["Causal Inference", " ", "causal inference", "Mech Interp"],
      }),
    ).toEqual(["Causal Inference", "Mech Interp"]);
    expect(memberMeetingTopics({})).toEqual([]);
  });
});
