// Reading pre-registrations the Control UI wrote, from the service side.
import { describe, expect, it } from "vitest";
import { paperTargetsVenue, readPaperVenueTargets } from "./venue-targets.js";

const withTargets = (value: unknown) => ({
  artifacts: { venue_targets: value as string },
});

describe("readPaperVenueTargets", () => {
  it("reads what the pre-registration dialog stores", () => {
    const paper = withTargets(
      JSON.stringify([
        { venue_id: "iclr2027_paper", label: "ICLR 2027", confidence: 80 },
        { venue_id: "arr_2026_october", label: "ARR October", confidence: 50 },
      ]),
    );
    expect(readPaperVenueTargets(paper)).toEqual([
      { venue_id: "iclr2027_paper", label: "ICLR 2027", confidence: 80 },
      { venue_id: "arr_2026_october", label: "ARR October", confidence: 50 },
    ]);
  });

  it("degrades to no targets rather than throwing inside a sweep", () => {
    expect(readPaperVenueTargets({ artifacts: undefined })).toEqual([]);
    expect(readPaperVenueTargets(withTargets("not json"))).toEqual([]);
    expect(readPaperVenueTargets(withTargets("{}"))).toEqual([]);
    expect(readPaperVenueTargets(withTargets("[1, null, {}]"))).toEqual([]);
    expect(readPaperVenueTargets(withTargets(""))).toEqual([]);
  });

  it("fills a missing label from the id, and a missing confidence with zero", () => {
    expect(readPaperVenueTargets(withTargets('[{"venue_id":"iclr2027_paper"}]'))).toEqual([
      { venue_id: "iclr2027_paper", label: "iclr2027_paper", confidence: 0 },
    ]);
  });
});

describe("paperTargetsVenue", () => {
  it("matches whichever id space the target was written in", () => {
    // The pre-registration dialog writes deadline-board ids; the add-project form writes
    // venue-catalog ids. A sweep that knew only one would nudge people who already answered.
    const fromDialog = withTargets(
      '[{"venue_id":"iclr2027_paper","label":"ICLR 2027","confidence":80}]',
    );
    const fromAddForm = withTargets('[{"venue_id":"ICLR","label":"ICLR 2027","confidence":50}]');
    for (const paper of [fromDialog, fromAddForm]) {
      expect(paperTargetsVenue(paper, "ICLR")).toBe(true);
      expect(paperTargetsVenue(paper, "iclr")).toBe(true);
    }
  });

  it("does not match a different venue", () => {
    const paper = withTargets(
      '[{"venue_id":"arr_2026_october","label":"ARR October","confidence":50}]',
    );
    expect(paperTargetsVenue(paper, "ICLR")).toBe(false);
    expect(paperTargetsVenue(paper, "")).toBe(false);
  });

  it("does not use substring matching for venue identities", () => {
    const paper = withTargets(
      '[{"venue_id":"iclr2027_paper","label":"ICLR 2027","confidence":80}]',
    );
    expect(paperTargetsVenue(paper, "CLR")).toBe(false);
  });
});

describe("a designated conference pre-registers the paper", () => {
  // Every string below is a real `artifacts.conference` value off the production roster. 127
  // papers carry one and only 12 also carry a venue target, so before this these were all
  // invisible to the pre-registration sweep.
  const conference = (value: string) => ({ artifacts: { conference: value } });

  it("matches a bare conference name", () => {
    expect(paperTargetsVenue(conference("NeurIPS"), "NeurIPS")).toBe(true);
    expect(paperTargetsVenue(conference("ICLR"), "ICLR")).toBe(true);
  });

  it("ignores the year somebody typed alongside it", () => {
    expect(paperTargetsVenue(conference("ICLR 2027"), "ICLR")).toBe(true);
    expect(paperTargetsVenue(conference("AAAI 2027"), "AAAI")).toBe(true);
  });

  it("sees through a track in parentheses", () => {
    expect(paperTargetsVenue(conference("EMNLP 2026 (main)"), "EMNLP")).toBe(true);
    expect(paperTargetsVenue(conference("EMNLP 2026 (demo)"), "EMNLP")).toBe(true);
  });

  it("reads Findings as the conference it is findings of", () => {
    expect(paperTargetsVenue(conference("Findings of ACL"), "ACL")).toBe(true);
    expect(paperTargetsVenue(conference("Findings of EMNLP"), "EMNLP")).toBe(true);
  });

  it("finds the venue inside an ARR commitment sentence", () => {
    const value = "ARR Acceptance, Committed to EMNLP Findings";
    expect(paperTargetsVenue(conference(value), "EMNLP")).toBe(true);
    // The ARR half is a real target too -- that is where the paper actually went in.
    expect(paperTargetsVenue(conference(value), "ARR")).toBe(true);
  });

  it("does not invent a venue the string never names", () => {
    expect(paperTargetsVenue(conference("NeurIPS"), "ICLR")).toBe(false);
    expect(paperTargetsVenue(conference("Findings of ACL"), "EMNLP")).toBe(false);
    expect(paperTargetsVenue(conference("Preprint"), "ICLR")).toBe(false);
    expect(paperTargetsVenue(conference(""), "ICLR")).toBe(false);
  });

  it("lets a bare family match a track, but not one track another", () => {
    // "Who is aiming at ICLR" includes an ICLR workshop paper.
    expect(paperTargetsVenue({ artifacts: { conference: "ICLR-workshop" } }, "ICLR")).toBe(true);
    // Asking about one track must not be answered by a different one: they are different
    // deadlines and different decisions.
    expect(paperTargetsVenue({ artifacts: { conference: "EMNLP-demo" } }, "EMNLP-main")).toBe(
      false,
    );
    expect(paperTargetsVenue({ artifacts: { conference: "EMNLP-main" } }, "EMNLP-main")).toBe(true);
  });

  it("still honours an explicit venue target, and the two coexist", () => {
    const paper = {
      artifacts: {
        conference: "NeurIPS",
        venue_targets: JSON.stringify([{ venue_id: "ICLR", label: "ICLR", confidence: 60 }]),
      },
    };
    expect(paperTargetsVenue(paper, "ICLR")).toBe(true);
    expect(paperTargetsVenue(paper, "NeurIPS")).toBe(true);
  });
});
