import { describe, expect, it } from "vitest";
import {
  compareEntryToPaper,
  describeVerdict,
  extractAuthorSurnames,
  titleSimilarity,
  venuesAgree,
  verifyEntry,
} from "../../scripts/lib/reference-verifier.mjs";

const entry = (fields: Record<string, string>) => ({ key: "ref1", fields });

const paper = (overrides: Record<string, unknown> = {}) => ({
  title: "Attention Is All You Need",
  authors: [{ name: "Ashish Vaswani" }, { name: "Noam Shazeer" }],
  year: 2017,
  venue: "Advances in Neural Information Processing Systems",
  externalIds: {},
  ...overrides,
});

describe("title similarity", () => {
  it("scores an exact match at 1 and an unrelated title low", () => {
    expect(titleSimilarity("Attention Is All You Need", "attention is all you need")).toBe(1);
    expect(titleSimilarity("Attention Is All You Need", "A Survey of Frogs")).toBeLessThan(0.4);
  });
});

describe("venue agreement", () => {
  it("matches a venue against its acronym and rejects a different one", () => {
    expect(venuesAgree("Advances in Neural Information Processing Systems", "NeurIPS")).toBe(true);
    expect(venuesAgree("Journal of Machine Learning Research", "CVPR")).toBe(false);
  });

  it("returns null when either side is unusable, so no issue is raised", () => {
    expect(venuesAgree("", "NeurIPS")).toBeNull();
  });
});

describe("author surnames", () => {
  it("reads both BibTeX author conventions", () => {
    expect(extractAuthorSurnames("Vaswani, Ashish and Noam Shazeer")).toEqual([
      "vaswani",
      "shazeer",
    ]);
  });
});

describe("field comparison", () => {
  it("keeps a year inside tolerance clean and flags one far outside", () => {
    expect(
      compareEntryToPaper(
        entry({ title: paper().title, author: "Vaswani, Ashish", year: "2018" }),
        paper(),
      ).issues,
    ).toEqual([]);
    const issues = compareEntryToPaper(
      entry({ title: paper().title, author: "Vaswani, Ashish", year: "1998" }),
      paper(),
    ).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: "year", severity: "critical" });
  });

  it("flags a first-author swap as critical when no other author overlaps", () => {
    const issues = compareEntryToPaper(
      entry({ title: paper().title, author: "Nobody, A and Someone, B", year: "2017" }),
      paper(),
    ).issues;
    expect(issues[0]).toMatchObject({ field: "author", severity: "critical" });
  });
});

describe("verdicts", () => {
  const noDois = new Map<string, unknown>();

  it("reports fabricated when candidates come back and none match", async () => {
    const verdict = await verifyEntry(
      entry({ title: "Quantum Bananas for Neural Retrieval", author: "Nobody, A", year: "2021" }),
      noDois,
      async () => [paper()],
    );
    expect(verdict.kind).toBe("fabricated");
  });

  // The three guards below are the reason this tool is safe to point at colleagues' papers.
  it("never reports fabricated when the lookup itself failed", async () => {
    const verdict = await verifyEntry(
      entry({ title: "Quantum Bananas for Neural Retrieval", author: "Nobody, A", year: "2021" }),
      noDois,
      async () => null,
    );
    expect(verdict).toMatchObject({ kind: "unverified", reason: "api_unavailable" });
  });

  it("downgrades an empty result set to unverified when absence is not trustworthy", async () => {
    const verdict = await verifyEntry(
      entry({ title: "Some Real But Poorly Indexed Paper", author: "Someone, A", year: "2019" }),
      noDois,
      async () => [],
      { trustedAbsence: false },
    );
    expect(verdict).toMatchObject({ kind: "unverified", reason: "no_candidates_untrusted" });
  });

  it("downgrades a weak best match to unverified when absence is not trustworthy", async () => {
    // Dewey's "Democracy and Education" is real but absent from arXiv/Crossref/OpenAlex search,
    // which return an unrelated near-miss rather than nothing.
    const verdict = await verifyEntry(
      entry({ title: "Democracy and Education", author: "Dewey, John", year: "1916" }),
      noDois,
      async () => [paper({ title: "Reconsidering Dewey's Democratic Education", year: 2015 })],
      { trustedAbsence: false },
    );
    expect(verdict).toMatchObject({ kind: "unverified", reason: "no_match_untrusted" });
  });

  it("still reports fabricated on an empty result set from a trusted provider", async () => {
    const verdict = await verifyEntry(
      entry({ title: "Invented Paper Title", author: "Nobody, A", year: "2019" }),
      noDois,
      async () => [],
      { trustedAbsence: true },
    );
    expect(verdict.kind).toBe("fabricated");
  });

  it("distinguishes a DOI the provider denies from one it never resolved", async () => {
    const denied = await verifyEntry(
      entry({ title: "Anything", author: "A", year: "2020", doi: "10.1/nope" }),
      new Map([["10.1/nope", null]]),
      async () => [],
      { trustedAbsence: true },
    );
    expect(denied.kind).toBe("doi_not_found");

    // Absent from the map means the lookup never completed; it must fall through to title search
    // rather than assert the DOI does not exist.
    const unresolved = await verifyEntry(
      entry({ title: paper().title, author: "Vaswani, Ashish", year: "2017", doi: "10.1/unknown" }),
      noDois,
      async () => [paper()],
    );
    expect(unresolved.kind).toBe("verified");
  });

  it("treats a borderline title match with no other disagreement as unverified", async () => {
    const verdict = await verifyEntry(
      entry({
        title: "Attention Is All You Need For Now",
        author: "Vaswani, Ashish",
        year: "2017",
      }),
      noDois,
      async () => [paper()],
    );
    expect(verdict.kind).toBe("unverified");
  });
});

// Each case below is a false positive observed on ARR submission 1100, kept so the demotions
// cannot silently regress once a Semantic Scholar key makes strictMetadata true again.
describe("untrusted-record demotions", () => {
  const noDois = new Map<string, unknown>();

  it("demotes an author disagreement on a verbatim title to a warning", () => {
    const ostrom = entry({
      title: "Governing the Commons: The Evolution of Institutions for Collective Action",
      author: "Ostrom, Elinor",
      year: "1990",
    });
    const record = paper({
      title: "Governing the Commons: The Evolution of Institutions for Collective Action",
      authors: [{ name: "Field" }],
      year: 1990,
    });
    expect(compareEntryToPaper(ostrom, record).issues[0]).toMatchObject({
      field: "author",
      severity: "critical",
    });
    expect(compareEntryToPaper(ostrom, record, { strictMetadata: false }).issues[0]).toMatchObject({
      field: "author",
      severity: "warning",
    });
  });

  it("demotes a reprint-year gap to a warning when there is no DOI to anchor the match", () => {
    const hayek = entry({
      title: "Individualism and Economic Order",
      author: "Hayek, Friedrich",
      year: "1980",
    });
    const record = paper({ title: "Individualism and Economic Order", authors: [], year: 1996 });
    expect(compareEntryToPaper(hayek, record).issues[0]).toMatchObject({
      field: "year",
      severity: "critical",
    });
    expect(compareEntryToPaper(hayek, record, { strictMetadata: false }).issues[0]).toMatchObject({
      field: "year",
      severity: "warning",
    });
  });

  it("keeps a year gap critical when a DOI anchored the record", () => {
    const withDoi = entry({
      title: "Individualism and Economic Order",
      author: "Hayek, Friedrich",
      year: "1980",
      doi: "10.1/real",
    });
    const record = paper({ title: "Individualism and Economic Order", authors: [], year: 1996 });
    expect(compareEntryToPaper(withDoi, record, { strictMetadata: false }).issues[0]).toMatchObject(
      { field: "year", severity: "critical" },
    );
  });

  it("calls a half-matching title with disagreeing fields a wrong candidate, not a mismatch", async () => {
    const turner = entry({
      title: "The determination of collective behaviour",
      author: "Turner, Ralph",
      year: "1982",
    });
    const unrelated = paper({
      title: "Intention for collective behaviour",
      authors: [{ name: "Someone Else" }],
      year: 2024,
    });
    const untrusted = await verifyEntry(turner, noDois, async () => [unrelated], {
      trustedAbsence: false,
    });
    expect(untrusted).toMatchObject({ kind: "unverified", reason: "wrong_candidate" });

    // With a trusted provider a borderline hit is usually still the right record, so the ported
    // behaviour stands.
    const trusted = await verifyEntry(turner, noDois, async () => [unrelated], {
      trustedAbsence: true,
    });
    expect(trusted.kind).toBe("mismatch");
  });

  it("leaves DOI contradictions critical, since those do not depend on record quality", async () => {
    const verdict = await verifyEntry(
      entry({ title: "Anything", author: "A", year: "2020", doi: "10.1/nope" }),
      new Map([["10.1/nope", null]]),
      async () => [],
      { trustedAbsence: false },
    );
    expect(verdict.kind).toBe("doi_not_found");
    expect(describeVerdict(entry({ title: "Anything" }), verdict)).toMatchObject({
      severity: "critical",
    });
  });
});

describe("finding text", () => {
  it("says nothing for a clean entry and marks a fabricated one critical", () => {
    expect(describeVerdict(entry({ title: "x" }), { kind: "verified", paper: paper() })).toBeNull();
    const finding = describeVerdict(entry({ title: "Invented" }), {
      kind: "fabricated",
      bestSim: 0.2,
      bestCandidate: null,
    });
    expect(finding).toMatchObject({ severity: "critical" });
    expect(finding?.detail).toContain("No matching record");
  });
});
