// The week key is the whole contract here: two people in different timezones writing on the same
// evening have to land in the same bucket, and a Sunday reminder has to ask about the week that is
// ending rather than the one about to start.
import { describe, expect, it } from "vitest";
import {
  adminBotFormatWeek,
  adminBotPreviousWeekStart,
  adminBotWeekStart,
  buildWeeklyUpdateMessage,
  findWeeklyUpdateGaps,
  type AdminBotPaperWeeklyUpdate,
} from "./paper-weekly-updates.js";

function update(
  fields: Partial<AdminBotPaperWeeklyUpdate> & { paper_id: string; member_id: string },
): AdminBotPaperWeeklyUpdate {
  return {
    week_start: "2026-08-17",
    body: "Ran the ablation.",
    created_at: "2026-08-21T00:00:00.000Z",
    updated_at: "2026-08-21T00:00:00.000Z",
    ...fields,
  };
}

describe("adminBotWeekStart", () => {
  it("keys a week by its Monday", () => {
    // Monday 17 Aug 2026 through Sunday 23 Aug 2026 are all one week.
    expect(adminBotWeekStart("2026-08-17T09:00:00.000Z")).toBe("2026-08-17");
    expect(adminBotWeekStart("2026-08-20T23:59:00.000Z")).toBe("2026-08-17");
    expect(adminBotWeekStart("2026-08-23T21:00:00.000Z")).toBe("2026-08-17");
  });

  it("puts Sunday in the week that is ending, which is what the reminder asks about", () => {
    // The Sunday sweep runs here and must ask about 17-23 Aug, not about the week starting the
    // next morning.
    expect(adminBotWeekStart("2026-08-23T18:00:00.000Z")).toBe("2026-08-17");
    expect(adminBotWeekStart("2026-08-24T00:30:00.000Z")).toBe("2026-08-24");
  });

  it("buckets two timezones writing the same evening together", () => {
    // 23:30 in Toronto on Friday is 03:30 UTC on Saturday; both are the same working week.
    expect(adminBotWeekStart("2026-08-22T03:30:00.000Z")).toBe(
      adminBotWeekStart("2026-08-21T20:00:00.000Z"),
    );
  });

  it("steps back a week, and reads a week out loud", () => {
    expect(adminBotPreviousWeekStart("2026-08-17")).toBe("2026-08-10");
    expect(adminBotFormatWeek("2026-08-17")).toBe("17–23 Aug");
    // A week that straddles two months names both.
    // en-GB renders September as "Sept"; the assertion follows the runtime rather than the other
    // way round -- the string is read by a person, not parsed by anything.
    expect(adminBotFormatWeek("2026-08-31")).toBe("31 Aug – 6 Sept");
  });
});

describe("findWeeklyUpdateGaps", () => {
  const papers = [
    { id: "p1", title: "Causal agents", member_ids: ["ada", "rahul"] },
    { id: "p2", title: "Second paper", member_ids: ["ada"] },
  ];

  it("finds everyone who has not written this week", () => {
    const gaps = findWeeklyUpdateGaps({
      papers,
      updates: [update({ paper_id: "p1", member_id: "ada" })],
      weekStart: "2026-08-17",
    });
    expect(gaps).toEqual([
      { paper_id: "p1", paper_title: "Causal agents", member_id: "rahul" },
      { paper_id: "p2", paper_title: "Second paper", member_id: "ada" },
    ]);
  });

  it("does not count last week's entry as this week's", () => {
    const gaps = findWeeklyUpdateGaps({
      papers: [papers[0]!],
      updates: [update({ paper_id: "p1", member_id: "ada", week_start: "2026-08-10" })],
      weekStart: "2026-08-17",
    });
    expect(gaps.map((gap) => gap.member_id).sort()).toEqual(["ada", "rahul"]);
  });

  it("treats a blank entry as no entry", () => {
    const gaps = findWeeklyUpdateGaps({
      papers: [papers[1]!],
      updates: [update({ paper_id: "p2", member_id: "ada", body: "   " })],
      weekStart: "2026-08-17",
    });
    expect(gaps).toHaveLength(1);
  });

  it("asks nobody about a paper with no lab member on it", () => {
    expect(
      findWeeklyUpdateGaps({
        papers: [{ id: "p3", title: "All external", member_ids: [] }],
        updates: [],
        weekStart: "2026-08-17",
      }),
    ).toEqual([]);
  });
});

describe("buildWeeklyUpdateMessage", () => {
  it("names the one paper inline, and lists several", () => {
    expect(
      buildWeeklyUpdateMessage({ titles: ["Causal agents"], weekStart: "2026-08-17" }),
    ).toContain("*Causal agents* this week (17–23 Aug)");
    const many = buildWeeklyUpdateMessage({
      titles: ["Causal agents", "Second paper"],
      weekStart: "2026-08-17",
    });
    expect(many).toContain("• Causal agents");
    expect(many).toContain("• Second paper");
  });
});
