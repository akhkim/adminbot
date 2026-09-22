import { describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "./controllers/admin.ts";
import {
  effectiveVenueTargets,
  PRE_REGISTRATION_VENUES,
  daysUntil,
  formatVenueTargets,
  nextDeadlineVenue,
  openPreRegistrationVenues,
  papersNeedingRegistration,
  readVenueTargets,
  serializeVenueTargets,
  venueOpenUntilMs,
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

describe("a declared venue counts as a registration", () => {
  // `artifacts.conference` is what most of the roster actually carries -- 127 papers name a
  // conference and 23 carry a venue target -- so reading only venue_targets left a paper whose
  // card plainly said "ICLR 2027" off the board, out of the banner's count, and without its own
  // Pre-registered line.
  const declared = (conference: string, confidence?: string) =>
    ({
      artifacts: { conference, ...(confidence ? { confidence } : {}) },
    }) as unknown as Parameters<typeof effectiveVenueTargets>[0];

  it("counts a paper that only declared where it is going", () => {
    const targets = effectiveVenueTargets(declared("ICLR 2027"));
    expect(targets).toHaveLength(1);
    expect(targets[0]?.label).toBe("ICLR 2027");
    // The same default Add a project uses. Zero would render as "certainly not going".
    expect(targets[0]?.confidence).toBe(50);
  });

  it("puts that paper on the board for the cycle it named", () => {
    expect(papersNeedingRegistration([declared("ICLR 2027")], "iclr2027_paper")).toEqual([]);
  });

  it("keeps the odds the author actually set", () => {
    expect(effectiveVenueTargets(declared("ICLR 2027", "80"))[0]?.confidence).toBe(80);
  });

  it("does not overrule an explicit target for the same venue", () => {
    const paper = {
      artifacts: {
        conference: "ICLR 2027",
        venue_targets: JSON.stringify([
          { venue_id: "iclr2027_paper", label: "ICLR 2027", confidence: 99 },
        ]),
      },
    } as unknown as Parameters<typeof effectiveVenueTargets>[0];
    const targets = effectiveVenueTargets(paper);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.confidence).toBe(99);
  });

  it("carries a declared venue alongside a different explicit one", () => {
    const paper = {
      artifacts: {
        conference: "ICLR 2027",
        venue_targets: JSON.stringify([
          { venue_id: "arr_2026_october", label: "ARR October", confidence: 80 },
        ]),
      },
    } as unknown as Parameters<typeof effectiveVenueTargets>[0];
    expect(effectiveVenueTargets(paper).map((target) => target.label)).toEqual([
      "ARR October",
      "ICLR 2027",
    ]);
  });

  it("ignores a declaration that names no cycle", () => {
    // Twenty papers read "ARR Acceptance, Committed to EMNLP Findings" -- finished commitments
    // from a past cycle. An unknown year matches any, so without this guard every one of them
    // would land on the board for *this* October's ARR deadline.
    for (const conference of [
      "ARR",
      "ARR Acceptance, Committed to EMNLP Findings",
      "NeurIPS",
      "Preprint",
    ]) {
      expect(effectiveVenueTargets(declared(conference))).toEqual([]);
    }
    expect(
      papersNeedingRegistration(
        [declared("ARR Acceptance, Committed to EMNLP")],
        "arr_2026_october",
      ),
    ).toHaveLength(1);
  });

  it("does not let one year answer for another", () => {
    expect(papersNeedingRegistration([declared("ICLR 2026")], "iclr2027_paper")).toHaveLength(1);
  });
});

describe("which venues the pre-registration board still offers", () => {
  // The dataset's own dates for the two venues the board exists for. ICLR 2027 publishes no
  // `notification_aoe` at all -- its decisions live in `schedule` as "Final decisions", and ARR's
  // equivalent is its cycle end -- which is exactly why reading the top-level field alone was not
  // enough. See decisionInstantMs.
  const beforeIclr = new Date("2026-09-22T12:00:00Z");
  const afterIclrClosed = new Date("2026-09-26T12:00:00Z");
  const afterIclrDecided = new Date("2026-12-18T12:00:00Z");
  const afterEverything = new Date("2027-01-05T12:00:00Z");

  function declaring(id: string, conference: string): AdminBotPaperRecord {
    return {
      id,
      title: `Paper ${id}`,
      authors: [],
      current_step: "overleaf_writing",
      artifacts: { conference },
    } as never;
  }

  it("keeps a venue through the wait for decisions, not just to its deadline", () => {
    // 25 Sep is ICLR 2027's paper deadline; decisions are 16 Dec. Between those the venue is the
    // most interesting thing on the board, because nobody knows yet how it went.
    const open = openPreRegistrationVenues([], afterIclrClosed);
    const iclr = open.find((venue) => venue.label === "ICLR 2027");
    expect(iclr).toBeDefined();
    expect(iclr?.awaiting_results).toBe(true);
  });

  it("drops it once the decisions are out", () => {
    expect(
      openPreRegistrationVenues([], afterIclrDecided).map((venue) => venue.label),
    ).not.toContain("ICLR 2027");
    expect(openPreRegistrationVenues([], afterEverything)).toEqual([]);
  });

  it("reads decisions out of the schedule, since these venues carry no notification_aoe", () => {
    // Guards the specific regression: falling back to the submission deadline would put both of
    // these in September and October rather than December.
    expect(venueOpenUntilMs("iclr2027_paper")).toBeGreaterThan(Date.parse("2026-12-16T00:00:00Z"));
    expect(venueOpenUntilMs("arr_2026_october")).toBeGreaterThan(
      Date.parse("2026-12-20T00:00:00Z"),
    );
  });

  it("puts venues still open for submission ahead of ones being waited on", () => {
    // ARR October closes 12 Oct, so on the 26th it is still actionable and ICLR is not.
    expect(openPreRegistrationVenues([], afterIclrClosed).map((venue) => venue.label)).toEqual([
      "ARR October",
      "ICLR 2027",
    ]);
    // Before anything closes they simply run soonest-first.
    expect(openPreRegistrationVenues([], beforeIclr).map((venue) => venue.label)).toEqual([
      "ICLR 2027",
      "ARR October",
    ]);
  });

  it("includes a venue a paper is aimed at even when the picker does not offer it", () => {
    // The gap this closes: a paper aimed outside the curated three matched no chip, so it was
    // absent from the board while its own card showed the target.
    const labels = openPreRegistrationVenues([declaring("a", "NeurIPS 2026")], beforeIclr).map(
      (venue) => venue.label,
    );
    expect(labels).toContain("NeurIPS 2026");
    // The curated two are still there; this adds to the board rather than replacing it.
    expect(labels).toEqual(expect.arrayContaining(["ICLR 2027", "ARR October"]));
  });

  it("does not add a second chip for a venue the matcher cannot tell from a curated one", () => {
    // "ARR August 2026" shares ARR October's family and year, so `venueTargetMatches` treats them
    // as one venue. Two chips would each select the other's rows.
    const labels = openPreRegistrationVenues([declaring("a", "ARR August 2026")], beforeIclr).map(
      (venue) => venue.label,
    );
    expect(labels).not.toContain("ARR August 2026");
    expect(labels.filter((label) => label.startsWith("ARR"))).toEqual(["ARR October"]);
  });

  it("ignores a venue whose cycle is entirely over", () => {
    expect(openPreRegistrationVenues([declaring("a", "ARR August 2026")], afterEverything)).toEqual(
      [],
    );
  });

  it("has nothing to say about a venue the deadline board does not know", () => {
    expect(venueOpenUntilMs("other")).toBeUndefined();
    expect(openPreRegistrationVenues([], beforeIclr).map((venue) => venue.label)).not.toContain(
      "Other",
    );
  });
});

describe("a venue only borrows dates from its own year", () => {
  const beforeIclr = new Date("2026-09-22T12:00:00Z");

  function declaring(id: string, conference: string): AdminBotPaperRecord {
    return {
      id,
      title: `Paper ${id}`,
      authors: [],
      current_step: "overleaf_writing",
      artifacts: { conference },
    } as never;
  }

  it("does not let a past cycle inherit the live one's deadline", () => {
    // The dataset carries no ICLR 2026 rows at all -- only iclr2027_abstract and iclr2027_paper.
    // A paper declaring "ICLR 2026" resolves to the catalog id `ICLR-main`, which carries no year,
    // so matching it against the board rows skipped the year check and took ICLR 2027's dates: the
    // board grew an "ICLR 2026" chip counting down 5 days to a deadline that is not its own.
    const labels = openPreRegistrationVenues([declaring("a", "ICLR 2026")], beforeIclr).map(
      (venue) => venue.label,
    );
    expect(labels).not.toContain("ICLR 2026");
    expect(labels).toContain("ICLR 2027");
  });

  it("still resolves the cycle a paper really is aimed at", () => {
    // The same lookup by label has to keep working, or the fix above would empty the board.
    expect(venueOpenUntilMs("ICLR-main", "ICLR 2027")).toBe(venueOpenUntilMs("iclr2027_paper"));
    expect(venueOpenUntilMs("ICLR-main", "ICLR 2026")).toBeUndefined();
  });
});
