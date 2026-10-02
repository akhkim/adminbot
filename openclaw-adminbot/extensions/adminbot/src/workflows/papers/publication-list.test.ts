// The publication digest's selection rules.
//
// The cases that matter here are the ones about *dates the records do not have*: the roster's
// acceptance fields are almost entirely empty, so a digest that treated a missing date as a
// missing paper would quietly send a near-empty email and look like it had worked.
import { describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import {
  acceptedVenueOf,
  arxivMonth,
  collectVenues,
  publicationDateOf,
  renderPublicationDigest,
  selectPublications,
  venueKey,
  withinRange,
} from "./publication-list.js";

function paper(overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "A Paper",
    authors: ["Ada Lovelace", "Grace Hopper"],
    current_step: "arxiv_polish",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as AdminBotPaperRecord;
}

describe("arxivMonth", () => {
  it("reads the month out of every shape the field actually holds", () => {
    // All four of these are in the live records: abs and pdf, http and https, with a version.
    for (const url of [
      "https://arxiv.org/abs/2605.08426",
      "http://arxiv.org/abs/2505.19212",
      "https://arxiv.org/pdf/2602.12316",
      "https://arxiv.org/abs/2511.10840v2",
    ]) {
      expect(arxivMonth(url)?.precision).toBe("month");
    }
    expect(arxivMonth("https://arxiv.org/abs/2605.08426")?.iso).toBe("2026-05-01");
  });

  it("windows the two-digit year rather than assuming 20xx", () => {
    // A silent 2099 would sort a digest wrongly and never be noticed.
    expect(arxivMonth("https://arxiv.org/abs/9903.00001")?.iso).toBe("1999-03-01");
  });

  it("refuses a month that is not one, and anything that is not an id", () => {
    expect(arxivMonth("https://arxiv.org/abs/2613.00001")).toBeUndefined();
    expect(arxivMonth("https://example.com/paper.pdf")).toBeUndefined();
    expect(arxivMonth(undefined)).toBeUndefined();
  });
});

describe("publicationDateOf", () => {
  it("prefers the arXiv month over the accepted year", () => {
    const date = publicationDateOf(
      paper({ accepted_year: 2020, artifacts: { arxiv_url: "https://arxiv.org/abs/2605.08426" } }),
    );
    // A real month beats a year, and it is the date a reader of the digest would recognise.
    expect(date).toMatchObject({ iso: "2026-05-01", source: "arxiv" });
  });

  it("falls back to the accepted year for work with no preprint", () => {
    expect(publicationDateOf(paper({ accepted_year: 2025 }))).toMatchObject({
      iso: "2025-01-01",
      precision: "year",
      source: "accepted_year",
    });
  });

  it("leaves a paper undated rather than reaching for created_at", () => {
    // created_at spans the six weeks of the spreadsheet import, so it dates the *record*, not the
    // work. Using it would put 70 papers in whichever range covered the import.
    expect(publicationDateOf(paper())).toBeUndefined();
  });
});

describe("withinRange", () => {
  it("counts a year-precision date if any of its year overlaps", () => {
    const date = { iso: "2026-01-01", precision: "year", source: "accepted_year" } as const;
    // The annual-report case: a paper accepted "in 2026" belongs in a July-December 2026 digest,
    // and comparing 1 January against the range would drop it.
    expect(withinRange(date, "2026-07-01", "2026-12-31")).toBe(true);
    expect(withinRange(date, "2025-01-01", "2025-12-31")).toBe(false);
  });

  it("compares a month-precision date by day, inclusive at both ends", () => {
    const date = { iso: "2026-05-01", precision: "month", source: "arxiv" } as const;
    expect(withinRange(date, "2026-05-01", "2026-05-01")).toBe(true);
    expect(withinRange(date, "2026-06-01", "2026-12-31")).toBe(false);
  });
});

describe("selectPublications", () => {
  const papers = [
    paper({
      id: "new",
      title: "Newer",
      artifacts: { arxiv_url: "https://arxiv.org/abs/2606.00001" },
    }),
    paper({
      id: "old",
      title: "Older",
      artifacts: { arxiv_url: "https://arxiv.org/abs/2601.00001" },
    }),
    paper({
      id: "out",
      title: "Outside",
      artifacts: { arxiv_url: "https://arxiv.org/abs/2401.00001" },
    }),
    paper({ id: "undated", title: "Undated" }),
  ];

  it("returns the range newest first", () => {
    const { included } = selectPublications({
      papers,
      fromIso: "2026-01-01",
      toIso: "2026-12-31",
    });
    expect(included.map((entry) => entry.id)).toEqual(["new", "old"]);
  });

  it("reports what it left out and why, instead of dropping it silently", () => {
    const { excluded } = selectPublications({
      papers,
      fromIso: "2026-01-01",
      toIso: "2026-12-31",
    });
    // The honest answer to "why is this digest so short" is almost always this list.
    // Sorted by title, so the list reads the same way twice.
    expect(excluded).toEqual([
      {
        id: "out",
        title: "Outside",
        reason: "out_of_range",
        date: { iso: "2024-01-01", precision: "month", source: "arxiv" },
      },
      { id: "undated", title: "Undated", reason: "no_date" },
    ]);
  });

  it("orders the same range identically every time", () => {
    // Two sends of one digest must not look like different documents.
    const twice = [0, 1].map(
      () => selectPublications({ papers, fromIso: "2026-01-01", toIso: "2026-12-31" }).included,
    );
    expect(twice[0]).toEqual(twice[1]);
  });

  it("prefers the accepted venue over the target venue", () => {
    const { included } = selectPublications({
      papers: [
        paper({
          venue: "ICLR 2027",
          accepted_venue: "NeurIPS 2026",
          artifacts: { arxiv_url: "https://arxiv.org/abs/2606.00001" },
        }),
      ],
      fromIso: "2026-01-01",
      toIso: "2026-12-31",
    });
    // "Where it is going" and "where it landed" are different claims; a digest makes the second.
    expect(included[0]?.venue).toBe("NeurIPS 2026");
  });
});

describe("renderPublicationDigest", () => {
  const publications = selectPublications({
    papers: [
      paper({
        title: "Judging the Judges",
        authors: ["Arth", "Samuel", "Zhijing"],
        venue: "NeurIPS 2026",
        artifacts: { arxiv_url: "https://arxiv.org/abs/2606.00001" },
      }),
    ],
    fromIso: "2026-01-01",
    toIso: "2026-12-31",
  }).included;

  it("names the range in the subject and lists each paper with its authors", () => {
    const digest = renderPublicationDigest({
      publications,
      undatedCount: 0,
      fromIso: "2026-01-01",
      toIso: "2026-12-31",
    });
    expect(digest.subject).toBe("Jinesis Lab publications, 2026-01-01 to 2026-12-31");
    expect(digest.body).toContain("Judging the Judges");
    expect(digest.body).toContain("Arth, Samuel, Zhijing");
    expect(digest.body).toContain("June 2026 — NeurIPS 2026");
  });

  it("says in the email itself how many papers had no date", () => {
    // Somebody forwarding this to a funder should be able to see it covers what the lab has
    // recorded rather than what the lab has done, without opening the tab that produced it.
    const digest = renderPublicationDigest({
      publications,
      undatedCount: 70,
      fromIso: "2026-01-01",
      toIso: "2026-12-31",
    });
    expect(digest.body).toContain(
      "70 further papers are in our records without a publication date",
    );
  });

  it("says so plainly when the range is empty", () => {
    const digest = renderPublicationDigest({
      publications: [],
      undatedCount: 0,
      fromIso: "2020-01-01",
      toIso: "2020-12-31",
    });
    expect(digest.body).toContain("No publications in our records fall in this range.");
  });
});

describe("venueKey", () => {
  it("matches the same venue across the spellings the records actually hold", () => {
    // The track in brackets is not the venue: a digest of "what we got into EMNLP 2026" wants the
    // demo paper in it.
    expect(venueKey("EMNLP 2026 (demo)")).toBe(venueKey("emnlp  2026"));
    expect(venueKey("ACL 2026 (main)")).toBe("acl 2026");
  });

  it("keeps venues that differ only by year apart", () => {
    // The failure nobody would spot in a sent email: an ICLR 2026 paper in the ICLR 2027 list.
    expect(venueKey("ICLR 2027")).not.toBe(venueKey("ICLR 2026"));
    expect(venueKey(undefined)).toBe("");
  });
});

describe("acceptedVenueOf", () => {
  it("takes the author's own accepted_venue over the target venue", () => {
    expect(
      acceptedVenueOf(paper({ venue: "ICLR 2027", accepted_venue: "NeurIPS 2026" })),
    ).toBe("NeurIPS 2026");
  });

  it("reads an accept decision as acceptance at the venue the paper was aimed at", () => {
    expect(acceptedVenueOf(paper({ venue: "ICLR 2027", venue_decision: "accept" }))).toBe(
      "ICLR 2027",
    );
  });

  it("does not treat a target venue as an acceptance", () => {
    // The live roster's shape: 8 papers name ICLR 2027 and none records a decision. Reading those
    // as acceptances would mail a conference list of papers that have not been accepted.
    expect(acceptedVenueOf(paper({ venue: "ICLR 2027" }))).toBeUndefined();
    const rejected = paper({ venue: "ICLR 2027", venue_decision: "reject" });
    expect(acceptedVenueOf(rejected)).toBeUndefined();
  });
});

describe("collectVenues", () => {
  it("counts accepted and pending under one key per venue, commonest spelling as the label", () => {
    const options = collectVenues([
      paper({ id: "p1", venue: "ICLR 2027" }),
      paper({ id: "p2", venue: "ICLR 2027" }),
      paper({ id: "p3", venue: "iclr 2027", venue_decision: "accept" }),
      paper({ id: "p4", accepted_venue: "EMNLP 2026 (demo)" }),
    ]);
    // Most accepted first, ties alphabetical, so the list does not depend on the read order.
    expect(options.map((option) => [option.label, option.accepted, option.pending])).toEqual([
      ["EMNLP 2026 (demo)", 1, 0],
      ["ICLR 2027", 1, 2],
    ]);
  });
});

describe("selectPublications by venue", () => {
  const papers = [
    paper({
      id: "p1",
      title: "Accepted And Dated",
      venue: "ICLR 2027",
      venue_decision: "accept",
      artifacts: { arxiv_url: "https://arxiv.org/abs/2606.00001" },
    }),
    paper({ id: "p2", title: "Accepted No Arxiv", accepted_venue: "ICLR 2027 (main)" }),
    paper({ id: "p3", title: "Aimed There Only", venue: "ICLR 2027" }),
    paper({ id: "p4", title: "Another Venue", accepted_venue: "NeurIPS 2026" }),
  ];

  it("keeps an accepted paper that nothing can date, and ignores the range", () => {
    const { included } = selectPublications({
      papers,
      // A range that excludes everything, to prove it is not consulted.
      fromIso: "1990-01-01",
      toIso: "1990-12-31",
      venue: "ICLR 2027",
    });
    // Undated sorts last, behind everything that can say when it appeared.
    expect(included.map((entry) => entry.title)).toEqual([
      "Accepted And Dated",
      "Accepted No Arxiv",
    ]);
    expect(included[1]?.date).toBeUndefined();
  });

  it("reports the papers aimed there with no decision, and stays quiet about the rest", () => {
    const { excluded } = selectPublications({
      papers,
      fromIso: "2026-01-01",
      toIso: "2027-12-31",
      venue: "ICLR 2027",
    });
    // Only the ICLR paper without a decision: listing the NeurIPS one would bury it.
    expect(excluded).toEqual([
      { id: "p3", title: "Aimed There Only", reason: "not_accepted" },
    ]);
  });
});

describe("renderPublicationDigest by venue", () => {
  it("names the venue once, in the heading, rather than under every entry", () => {
    const { included, excluded } = selectPublications({
      papers: [
        paper({
          title: "Judging the Judges",
          venue: "ICLR 2027",
          venue_decision: "accept",
          artifacts: { arxiv_url: "https://arxiv.org/abs/2606.00001" },
        }),
        paper({ id: "p2", title: "Still Waiting", venue: "ICLR 2027" }),
      ],
      fromIso: "2026-01-01",
      toIso: "2027-12-31",
      venue: "ICLR 2027",
    });
    const digest = renderPublicationDigest({
      publications: included,
      undatedCount: 0,
      pendingCount: excluded.length,
      fromIso: "2026-01-01",
      toIso: "2027-12-31",
      venue: "ICLR 2027",
    });
    expect(digest.subject).toBe("Jinesis Lab papers at ICLR 2027");
    expect(digest.body).toContain("accepted at ICLR 2027.");
    expect(digest.body).toContain("  June 2026\n");
    // The venue is the heading; repeating it under each title is noise.
    expect(digest.body).not.toContain("— ICLR 2027");
    // And the ones still in flight are counted in the email itself, not just the preview.
    expect(digest.body).toContain("1 further paper names ICLR 2027");
  });

  it("says plainly when nothing is recorded as accepted there", () => {
    const digest = renderPublicationDigest({
      publications: [],
      undatedCount: 0,
      fromIso: "2026-01-01",
      toIso: "2027-12-31",
      venue: "ICLR 2027",
    });
    expect(digest.body).toContain(
      "No papers in our records are recorded as accepted at ICLR 2027.",
    );
  });
});
