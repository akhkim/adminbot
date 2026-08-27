import { describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "./controllers/admin.ts";
import {
  PRE_REGISTRATION_VENUES,
  daysUntil,
  formatVenueTargets,
  nextDeadlineVenue,
  papersNeedingRegistration,
  readVenueTargets,
  serializeVenueTargets,
} from "./venue-targets.ts";

function paper(id: string, targets?: unknown): AdminBotPaperRecord {
  return {
    id,
    title: `Paper ${id}`,
    authors: [],
    current_step: "overleaf_writing",
    artifacts: targets === undefined ? {} : { venue_targets: JSON.stringify(targets) },
  } as never;
}

describe("venue targets", () => {
  it("offers only the venues the lab is aiming at, not the whole deadline board", () => {
    // Offering every workshop would bury the two deadlines anyone is working toward.
    expect(PRE_REGISTRATION_VENUES.map((v) => v.label)).toEqual([
      "ICLR 2027",
      "ARR October",
      "Other",
    ]);
  });

  it("round-trips through the artifacts key", () => {
    const targets = [
      { venue_id: "iclr2027_paper", label: "ICLR 2027", confidence: 80 },
      { venue_id: "arr_2026_october", label: "ARR October", confidence: 50 },
    ];
    const stored = paper("p1", targets);
    expect(readVenueTargets(stored)).toHaveLength(2);
    expect(serializeVenueTargets(targets)).toContain("iclr2027_paper");
  });

  it("keeps several venues per paper, highest bet first", () => {
    const stored = paper("p1", [
      { venue_id: "arr_2026_october", label: "ARR October", confidence: 50 },
      { venue_id: "iclr2027_paper", label: "ICLR 2027", confidence: 99 },
    ]);
    expect(formatVenueTargets(readVenueTargets(stored))).toBe("99% ICLR 2027 · 50% ARR October");
  });

  it("treats odds as independent bets, not a distribution", () => {
    // 80% ICLR and 50% ARR is a coherent thing to say about the same paper.
    const stored = paper("p1", [
      { venue_id: "iclr2027_paper", label: "ICLR 2027", confidence: 80 },
      { venue_id: "arr_2026_october", label: "ARR October", confidence: 50 },
    ]);
    const total = readVenueTargets(stored).reduce((sum, t) => sum + t.confidence, 0);
    expect(total).toBe(130);
  });

  it("degrades to no targets on junk rather than breaking the page", () => {
    expect(readVenueTargets({ artifacts: { venue_targets: "not json" } } as never)).toEqual([]);
    expect(readVenueTargets({ artifacts: { venue_targets: '{"a":1}' } } as never)).toEqual([]);
    expect(readVenueTargets({ artifacts: {} } as never)).toEqual([]);
    expect(readVenueTargets({} as never)).toEqual([]);
  });

  it("drops rows missing the fields a target needs", () => {
    const stored = paper("p1", [{ venue_id: "iclr2027_paper" }, { label: "x", confidence: 1 }]);
    expect(readVenueTargets(stored)).toEqual([]);
  });

  it("clears the key when the last venue is removed", () => {
    expect(serializeVenueTargets([])).toBe("");
  });

  it("counts days to a deadline, and goes negative once past", () => {
    expect(daysUntil("2026-09-25", new Date("2026-08-22T12:00:00Z"))).toBe(35);
    expect(daysUntil("2026-08-01", new Date("2026-08-22T12:00:00Z"))).toBeLessThan(0);
    expect(daysUntil(undefined)).toBeUndefined();
  });

  it("keeps a date-only AoE deadline open until UTC-12 reaches midnight", () => {
    expect(daysUntil("2026-08-29", new Date("2026-08-30T11:00:00Z"))).toBe(1);
    expect(daysUntil("2026-08-29", new Date("2026-08-30T12:00:00Z"))).toBeLessThan(0);
  });

  it("shouts about the soonest deadline only", () => {
    // A banner naming three deadlines is a list, and a list is something people scroll past.
    const next = nextDeadlineVenue(new Date("2026-08-22T12:00:00Z"));
    expect(next?.venue.label).toBe("ICLR 2027");
  });

  it("stops prompting once a paper is registered for that venue", () => {
    const papers = [
      paper("p1", [{ venue_id: "iclr2027_paper", label: "ICLR 2027", confidence: 80 }]),
      paper("p2"),
    ];
    expect(papersNeedingRegistration(papers, "ICLR").map((p) => p.id)).toEqual(["p2"]);
  });

  it("counts a target the Add a project form wrote, not just the dialog's", () => {
    // The two writers use different id spaces: the pre-registration dialog writes deadline-board
    // ids, Add a project writes venue-catalog ids and puts the year in the label. Comparing them
    // as strings meant picking a target venue while adding a project left the banner still asking
    // the author to pre-register a paper they had already aimed.
    const papers = [
      paper("added", [{ venue_id: "ICLR-main", label: "ICLR 2027 (main)", confidence: 50 }]),
      paper("untargeted"),
    ];
    expect(papersNeedingRegistration(papers, "iclr2027_paper").map((p) => p.id)).toEqual([
      "untargeted",
    ]);
  });

  it("treats a workshop track at the same conference and year as registered", () => {
    const papers = [
      paper("ws", [{ venue_id: "ICLR-workshop", label: "ICLR 2027 (workshop)", confidence: 30 }]),
    ];
    expect(papersNeedingRegistration(papers, "iclr2027_paper")).toEqual([]);
  });

  it("does not let last year's target answer this year's deadline", () => {
    // iclr2027_paper is a deadline that has not passed. A paper aimed at ICLR 2026 is not
    // pre-registered for it, and saying so would hide a real prompt.
    const papers = [
      paper("old", [{ venue_id: "ICLR-main", label: "ICLR 2026 (main)", confidence: 80 }]),
    ];
    expect(papersNeedingRegistration(papers, "iclr2027_paper").map((p) => p.id)).toEqual(["old"]);
  });

  it("keeps a different conference out of it", () => {
    const papers = [
      paper("neurips", [{ venue_id: "NeurIPS-main", label: "NeurIPS 2027", confidence: 80 }]),
    ];
    expect(papersNeedingRegistration(papers, "iclr2027_paper").map((p) => p.id)).toEqual([
      "neurips",
    ]);
  });

  it("matches an ARR cycle written by either side", () => {
    const papers = [paper("arr", [{ venue_id: "ARR", label: "ARR 2026 October", confidence: 50 }])];
    expect(papersNeedingRegistration(papers, "arr_2026_october")).toEqual([]);
  });
});
