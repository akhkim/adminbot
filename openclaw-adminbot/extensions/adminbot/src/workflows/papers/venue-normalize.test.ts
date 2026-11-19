// The venue strings the records and the hand-kept tab actually hold, read as one conference each.
import { describe, expect, it } from "vitest";
import {
  compareVenuesWithinYear,
  normalizeVenue,
  sameVenueTrack,
  sheetConference,
  venueGroupKey,
  venueGroupLabel,
} from "./venue-normalize.js";

describe("normalizeVenue", () => {
  it.each([
    ["EMNLP", 2025, { family: "EMNLP", track: "main", year: "2025" }],
    ["EMNLP ARR Commitment", 2025, { family: "EMNLP", track: "main", year: "2025" }],
    ["EMNLP 2025 System Demonstrations", undefined, { family: "EMNLP", track: "demo", year: "2025" }],
    ["EMNLP System Demonstration", 2025, { family: "EMNLP", track: "demo", year: "2025" }],
    ["EMNLP 2026 (demo)", undefined, { family: "EMNLP", track: "demo", year: "2026" }],
    ["Findings of EMNLP 2025", undefined, { family: "EMNLP", track: "findings", year: "2025" }],
    ["Findings of the Association for Computational Linguistics: ACL 2024", undefined, { family: "ACL", track: "findings", year: "2024" }],
    ["ACL 2026 (main)", undefined, { family: "ACL", track: "main", year: "2026" }],
    ["NAACL 2025 Long Papers", undefined, { family: "NAACL", track: "main", year: "2025" }],
    ["ICLR 2026 Oral", undefined, { family: "ICLR", track: "main", year: "2026" }],
    ["Conference on Language Modeling 2025", undefined, { family: "Conference on Language Modeling", track: "main", year: "2025" }],
    ["LREC-COLING 202", 2024, { family: "LREC-COLING", track: "main", year: "2024" }],
    ["TMLR", undefined, { family: "TMLR", track: "main", year: "" }],
  ] as const)("%s (year %s)", (raw, year, expected) => {
    expect(normalizeVenue(raw, year)).toEqual(expected);
  });

  it("keeps a workshop as a venue of its own", () => {
    const venue = normalizeVenue("NeurIPS 2025 Workshop on Causal Learning");
    expect(venue).toEqual({ family: "NeurIPS Workshop on Causal Learning", track: "workshop", year: "2025" });
    expect(venueGroupKey(venue)).not.toBe(venueGroupKey(normalizeVenue("NeurIPS 2025")));
  });

  it("prefers the year in the label to the record's, and reads nothing from an empty label", () => {
    expect(normalizeVenue("ICLR 2027", 2026)?.year).toBe("2027");
    expect(normalizeVenue("   ")).toBeUndefined();
    expect(normalizeVenue(undefined, 2025)).toBeUndefined();
    // A truncated year with nothing to fill it is dropped, not guessed.
    expect(normalizeVenue("LREC-COLING 202")).toEqual({ family: "LREC-COLING", track: "main", year: "" });
  });
});

describe("grouping and ordering", () => {
  it("keys every track of one conference and year together", () => {
    const keys = new Set(
      ["EMNLP", "EMNLP ARR Commitment", "EMNLP System Demonstrations", "Findings of EMNLP"].map((raw) =>
        venueGroupKey(normalizeVenue(raw, 2025)),
      ),
    );
    expect([...keys]).toEqual(["emnlp 2025"]);
    expect(venueGroupLabel(normalizeVenue("emnlp arr commitment", 2025)!)).toBe("emnlp 2025");
  });

  it("names the sheet's conference cell with the track the CV entry needs", () => {
    expect(sheetConference(normalizeVenue("EMNLP ARR Commitment", 2025)!)).toBe("EMNLP");
    expect(sheetConference(normalizeVenue("Findings of EMNLP 2025")!)).toBe("Findings of EMNLP");
    expect(sheetConference(normalizeVenue("EMNLP 2026 (demo)")!)).toBe("EMNLP System Demonstrations");
  });

  it("orders by conference, then main, Findings, demos, workshops", () => {
    const sorted = ["EMNLP demo", "Findings of EMNLP", "ACL", "EMNLP", "EMNLP Workshop on X"]
      .map((raw) => normalizeVenue(raw, 2025)!)
      .toSorted(compareVenuesWithinYear)
      .map(sheetConference);
    expect(sorted).toEqual([
      "ACL",
      "EMNLP",
      "Findings of EMNLP",
      "EMNLP System Demonstrations",
      "EMNLP Workshop on X",
    ]);
    expect(sameVenueTrack(normalizeVenue("emnlp", 2025)!, normalizeVenue("EMNLP ARR Commitment")!)).toBe(true);
    expect(sameVenueTrack(normalizeVenue("EMNLP")!, normalizeVenue("Findings of EMNLP")!)).toBe(false);
  });
});
