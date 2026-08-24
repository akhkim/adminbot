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
