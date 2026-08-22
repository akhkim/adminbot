// The venue list itself: what it can spell, and what it does with a value it cannot.
import { describe, expect, it } from "vitest";
import {
  ARCHIVAL_VENUES,
  CATALOG_VENUES,
  NON_ARCHIVAL_VENUES,
  formatVenue,
  parseVenue,
  venueYears,
} from "./venue-catalog.ts";

describe("venue catalog", () => {
  it("carries the venues the lab submits to, split by whether they consume the paper", () => {
    const ids = CATALOG_VENUES.map((venue) => venue.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const family of ["ACL", "EMNLP", "NAACL", "EACL"]) {
      expect(ids).toContain(`${family}-main`);
      expect(ids).toContain(`${family}-demo`);
      expect(ids).toContain(`${family}-workshop`);
    }
    for (const family of ["NeurIPS", "ICML", "ICLR", "COLM", "CLeaR", "AAAI"]) {
      expect(ids).toContain(family);
    }
    expect(ids).toContain("IASEAI");
    expect(ARCHIVAL_VENUES.every((venue) => venue.archival)).toBe(true);
    // Workshops and IASEAI leave the paper free to go somewhere archival afterwards.
    expect(NON_ARCHIVAL_VENUES.every((venue) => !venue.archival)).toBe(true);
    expect(NON_ARCHIVAL_VENUES.map((venue) => venue.id)).toContain("COLM-workshop");
    expect(NON_ARCHIVAL_VENUES.map((venue) => venue.id)).not.toContain("CLeaR-workshop");
  });

  it("offers last year through two out, so a late registration and a plan both fit", () => {
    expect(venueYears(new Date("2026-08-22T00:00:00Z"))).toEqual([2025, 2026, 2027, 2028]);
  });

  it("writes a venue the way the deadline board words one", () => {
    expect(formatVenue("EMNLP-main", 2026)).toBe("EMNLP 2026 (main)");
    expect(formatVenue("NeurIPS", 2027)).toBe("NeurIPS 2027");
    expect(formatVenue("ICLR-workshop", 2027)).toBe("ICLR 2027 (workshop)");
    // A venue that is not in the list cannot be composed, and must not invent a target.
    expect(formatVenue("", 2027)).toBe("");
    expect(formatVenue("SIGGRAPH", 2027)).toBe("");
  });

  it("reads its own values back", () => {
    for (const venue of CATALOG_VENUES) {
      expect(parseVenue(formatVenue(venue.id, 2027))).toEqual({ id: venue.id, year: 2027 });
    }
  });

  it("recovers the targets written before the list existed", () => {
    // These came from the deadline board, in whatever wording the call for papers used.
    expect(parseVenue("EMNLP 2026 (main, ARR commitment)")).toEqual({
      id: "EMNLP-main",
      year: 2026,
    });
    expect(parseVenue("EACL 2027 (system demonstrations)")).toEqual({ id: null, year: 2027 });
    expect(parseVenue("ARR — August 2026 cycle (direct submission)")).toEqual({
      id: null,
      year: 2026,
    });
    expect(parseVenue("")).toEqual({ id: null, year: null });
    expect(parseVenue("Somewhere, eventually")).toEqual({ id: null, year: null });
  });
});
