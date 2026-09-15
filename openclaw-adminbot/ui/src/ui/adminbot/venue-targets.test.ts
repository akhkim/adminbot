import { describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "./controllers/admin.ts";
import {
  cardVenueTargets,
  DEFAULT_VENUE_CONFIDENCE,
  effectiveVenueTargets,
  newCardVenueTarget,
  primaryVenueTarget,
  toVenueTargets,
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

// The list as a paper card edits it: one row per venue, keyed so a checkbox can tick it.
describe("the card's venue list", () => {
  function card(artifacts: Record<string, unknown>): AdminBotPaperRecord {
    return {
      id: "p1",
      title: "Paper p1",
      authors: [],
      current_step: "overleaf_writing",
      artifacts,
    } as unknown as AdminBotPaperRecord;
  }

  it("keys a catalog venue by its catalog id, whichever field named it", () => {
    // Written by Add a project: bare catalog id, year in the label.
    expect(
      cardVenueTargets(
        card({
          venue_targets: JSON.stringify([
            { venue_id: "ACL-demo", label: "ACL 2027 (demo)", confidence: 80 },
          ]),
        }),
      ),
    ).toEqual([
      { key: "ACL-demo", label: "ACL 2027 (demo)", year: 2027, confidence: 80, legacy: false },
    ]);
    // Declared through `artifacts.conference` alone: the same venue, the same key, so the card
    // opens with it ticked rather than showing an empty dropdown over a paper that names one.
    expect(cardVenueTargets(card({ conference: "ACL 2027 (demo)" }))[0]?.key).toBe("ACL-demo");
  });

  it("gives a venue the catalog cannot spell a row of its own", () => {
    const rows = cardVenueTargets(
      card({
        venue_targets: JSON.stringify([
          { venue_id: "arr_2026_october", label: "ARR October", confidence: 80 },
        ]),
      }),
    );
    expect(rows).toEqual([
      { key: "arr_2026_october", label: "ARR October", year: null, confidence: 80, legacy: true },
    ]);
  });

  it("shows one venue once when two fields name it", () => {
    // The dialog's id space and the card's own, on one paper. Two rows would mean two checkboxes
    // for one venue, and unticking either would leave the other behind.
    const rows = cardVenueTargets(
      card({
        conference: "ICLR 2027",
        venue_targets: JSON.stringify([{ venue_id: "ICLR", label: "ICLR 2027", confidence: 80 }]),
      }),
    );
    expect(rows).toHaveLength(1);
    // The stronger bet wins the row: the list arrives sorted, so the duplicate is the weaker one.
    expect(rows[0]?.confidence).toBe(80);
  });

  it("dates a newly ticked venue and gives it the default odds", () => {
    expect(newCardVenueTarget("NeurIPS", 2027)).toEqual({
      key: "NeurIPS",
      label: "NeurIPS 2027",
      year: 2027,
      confidence: DEFAULT_VENUE_CONFIDENCE,
      legacy: false,
    });
  });

  it("hands the legacy pair the likeliest venue, not the first one listed", () => {
    // `artifacts.conference` holds one venue and the deadline board reads it, so it holds the bet
    // the authors actually expect to make.
    const rows = cardVenueTargets(
      card({
        venue_targets: JSON.stringify([
          { venue_id: "ICLR", label: "ICLR 2027", confidence: 30 },
          { venue_id: "arr_2026_october", label: "ARR October", confidence: 80 },
        ]),
      }),
    );
    expect(primaryVenueTarget(rows)?.label).toBe("ARR October");
    expect(primaryVenueTarget([])).toBeUndefined();
  });

  it("round-trips through the stored shape", () => {
    const stored = [
      { venue_id: "ICLR", label: "ICLR 2027", confidence: 80 },
      { venue_id: "arr_2026_october", label: "ARR October", confidence: 30 },
    ];
    expect(
      toVenueTargets(cardVenueTargets(card({ venue_targets: JSON.stringify(stored) }))),
    ).toEqual(stored);
  });
});
