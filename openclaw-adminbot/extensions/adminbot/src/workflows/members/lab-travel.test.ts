import { describe, expect, it } from "vitest";
import {
  coarsenCoordinate,
  isFreshFix,
  matchTravellers,
  nearestPlace,
  placeForFix,
  roundedDistanceKm,
  samePlace,
  travelConferenceSites,
  travelPlace,
  type TravelPerson,
} from "./lab-travel.js";

// Shaped like the deadline dataset rows, trimmed to the fields the Travel tab reads.
const DATASET = [
  {
    id: "neurips2026_rebuttal",
    venue_type: "rebuttal",
    venue_group: "NeurIPS 2026",
    venue_family: "NeurIPS",
    conference_location: "Sydney, Australia; Atlanta, USA; Paris, France",
    link: "https://neurips.cc/Conferences/2026",
    schedule: [
      { milestone: "rebuttal", label: "Discussion", starts: "2026-07-27", ends: "2026-08-03" },
      {
        milestone: "conference",
        label: "Main conference — Sydney",
        starts: "2026-12-08",
        ends: "2026-12-10",
        kind: "period",
      },
      {
        milestone: "conference",
        label: "Main conference — Atlanta",
        starts: "2026-12-10",
        ends: "2026-12-11",
        kind: "period",
      },
      {
        milestone: "conference",
        label: "Main conference — Paris",
        starts: "2026-12-09",
        ends: "2026-12-11",
        kind: "period",
      },
    ],
  },
  {
    id: "neurips2026_ws_x",
    venue_type: "workshop",
    venue_group: "NeurIPS 2026 Workshops",
    venue_family: "NeurIPS",
    conference_location: "Sydney, Australia; Atlanta, USA; Paris, France",
    schedule: [],
  },
  {
    id: "emnlp2026_commitment",
    venue_type: "conference",
    venue_group: "EMNLP 2026",
    venue_family: "EMNLP",
    conference_location: "Budapest, Hungary",
    homepage_url: "https://2026.emnlp.org/",
    schedule: [
      {
        milestone: "conference",
        label: "Main conference",
        starts: "2026-10-24",
        ends: "2026-10-29",
      },
    ],
  },
  {
    id: "aacl2026_commitment",
    venue_type: "conference",
    venue_group: "AACL-IJCNLP 2026",
    venue_family: "AACL",
    conference_location: "",
    schedule: [
      {
        milestone: "conference",
        label: "Main conference (Hengqin, China)",
        starts: "2026-11-06",
        ends: "2026-11-10",
      },
    ],
  },
  // A second row of the same conference must not produce a second entry.
  {
    id: "aacl2026_demo",
    venue_type: "conference",
    venue_group: "AACL-IJCNLP 2026",
    venue_family: "AACL",
    schedule: [
      {
        milestone: "conference",
        label: "Main conference (Hengqin, China)",
        starts: "2026-11-06",
        ends: "2026-11-10",
      },
    ],
  },
  {
    id: "arr_2026_august",
    venue_type: "conference",
    venue_group: "ARR August 2026",
    venue_family: "ARR",
    schedule: [{ milestone: "reviews", label: "Reviews due", date: "2026-09-07" }],
  },
  {
    id: "acl2026",
    venue_type: "conference",
    venue_group: "ACL 2026",
    venue_family: "ACL",
    conference_location: "San Diego, USA",
    schedule: [
      {
        milestone: "conference",
        label: "Main conference",
        starts: "2026-07-02",
        ends: "2026-07-07",
      },
    ],
  },
  {
    id: "naacl2027_paper",
    venue_type: "conference",
    venue_group: "NAACL 2027",
    venue_family: "NAACL",
    schedule: [],
  },
];

describe("travelConferenceSites", () => {
  const sites = travelConferenceSites(DATASET, "2026-10-13");

  it("lists a multi-site conference once per site, each with its own days and key", () => {
    const neurips = sites.filter((site) => site.group_key === "neurips:2026");
    expect(neurips.map((site) => [site.key, site.label, site.starts, site.ends])).toEqual([
      ["neuripssydney:2026", "NeurIPS 2026 — Sydney", "2026-12-08", "2026-12-10"],
      ["neuripsparis:2026", "NeurIPS 2026 — Paris", "2026-12-09", "2026-12-11"],
      ["neuripsatlanta:2026", "NeurIPS 2026 — Atlanta", "2026-12-10", "2026-12-11"],
    ]);
    expect(neurips.every((site) => site.multi_site)).toBe(true);
    expect(neurips.find((site) => site.city === "Paris")).toMatchObject({
      country: "France",
      place: { key: "paris" },
    });
  });

  it("keys a single-site conference exactly the way an accepted paper keys it", () => {
    expect(sites.find((site) => site.group_key === "emnlp:2026")).toMatchObject({
      key: "emnlp:2026",
      label: "EMNLP 2026",
      location: "Budapest, Hungary",
      multi_site: false,
      homepage_url: "https://2026.emnlp.org/",
    });
  });

  it("reads the site from the milestone label when the location field is empty", () => {
    const aacl = sites.filter((site) => site.group_key === "aacl:2026");
    expect(aacl).toHaveLength(1);
    expect(aacl[0]).toMatchObject({ city: "Hengqin", country: "China", place: { key: "zhuhai" } });
  });

  it("drops workshops, past conferences and venues with nowhere to travel to", () => {
    expect(sites.some((site) => site.label.includes("Workshops"))).toBe(false);
    expect(sites.some((site) => site.family === "ARR")).toBe(false);
    expect(sites.some((site) => site.family === "ACL")).toBe(false);
    expect(sites.some((site) => site.family === "NAACL")).toBe(false);
  });

  it("sorts by start date", () => {
    const starts = sites.map((site) => site.starts ?? "9999");
    expect(starts).toEqual(starts.toSorted());
  });
});

describe("placing a location fix", () => {
  it("names the nearest gazetteer city and keeps only ~1 km of precision", () => {
    expect(coarsenCoordinate(48.858_37)).toBe(48.86);
    const nearest = nearestPlace({ lat: 48.86, lon: 2.29 });
    expect(nearest?.place.key).toBe("paris");
    expect(nearest!.distance_km).toBeLessThan(10);
  });

  it("says 'near' rather than naming a city somebody is far from", () => {
    expect(placeForFix({ place_key: "lyon", place_label: "Lyon", place_distance_km: 140 })).toEqual(
      { label: "Near Lyon" },
    );
    expect(
      placeForFix({
        place_key: "lyon",
        place_label: "Lyon",
        place_country: "France",
        place_distance_km: 3,
      }),
    ).toEqual({ label: "Lyon", country: "France", key: "lyon" });
  });

  it("rounds distances shown to other people", () => {
    expect(roundedDistanceKm(2.4)).toBe(0);
    expect(roundedDistanceKm(13)).toBe(15);
  });

  it("treats a fix as current for three days", () => {
    const now = new Date("2026-10-13T12:00:00Z");
    expect(isFreshFix("2026-10-11T12:00:00Z", now)).toBe(true);
    expect(isFreshFix("2026-10-09T12:00:00Z", now)).toBe(false);
    expect(isFreshFix(undefined, now)).toBe(false);
  });

  it("matches places by distance, and by text when the gazetteer does not know them", () => {
    expect(samePlace(travelPlace("Cambridge, MA"), travelPlace("Boston"))).toBe(true);
    expect(samePlace(travelPlace("Paris"), travelPlace("Lyon"))).toBe(false);
    expect(samePlace(travelPlace("Smalltown, Nowhere"), travelPlace("smalltown"))).toBe(true);
  });
});

describe("matchTravellers", () => {
  const paris = travelPlace("Paris, France");
  const person = (overrides: Partial<TravelPerson> & { member_id: string }): TravelPerson => ({
    name: overrides.member_id,
    trips: [],
    conferences: [],
    ...overrides,
  });

  it("finds people by live fix, trip, conference and home, best evidence first", () => {
    const matches = matchTravellers(
      { place: paris, from: "2026-10-13", to: "2026-10-13", origin: { lat: 48.86, lon: 2.35 } },
      [
        person({ member_id: "home", home: travelPlace("Paris") }),
        person({
          member_id: "live",
          live: { lat: 48.9, lon: 2.4, place: { label: "Paris", key: "paris" }, reported_at: "x" },
        }),
        person({
          member_id: "trip",
          trips: [{ start: "2026-10-10", end: "2026-10-20", place: travelPlace("Paris") }],
        }),
        person({ member_id: "elsewhere", home: travelPlace("Toronto") }),
      ],
      "2026-10-13",
    );
    expect(matches.map((match) => [match.member_id, match.basis])).toEqual([
      ["live", "live"],
      ["trip", "trip"],
      ["home", "home"],
    ]);
    expect(matches[0]!.distance_km).toBe(5);
    expect(matches[1]).toMatchObject({ from: "2026-10-13", to: "2026-10-13" });
  });

  it("does not place somebody at home when they are demonstrably away", () => {
    const matches = matchTravellers(
      { place: paris, from: "2026-12-09", to: "2026-12-11" },
      [
        person({
          member_id: "travelling",
          home: travelPlace("Paris"),
          trips: [{ start: "2026-12-01", end: "2026-12-20", place: travelPlace("Sydney") }],
        }),
        person({
          member_id: "conference",
          conferences: [
            {
              label: "NeurIPS 2026 — Paris",
              starts: "2026-12-09",
              ends: "2026-12-11",
              place: paris,
            },
          ],
        }),
      ],
      "2026-10-13",
    );
    expect(matches).toEqual([
      expect.objectContaining({
        member_id: "conference",
        basis: "conference",
        conference_label: "NeurIPS 2026 — Paris",
      }),
    ]);
  });

  it("ignores a live fix for a span that does not include today", () => {
    const matches = matchTravellers(
      { place: paris, from: "2026-12-09", to: "2026-12-11" },
      [
        person({
          member_id: "live",
          live: { lat: 48.86, lon: 2.35, place: { label: "Paris" }, reported_at: "x" },
        }),
      ],
      "2026-10-13",
    );
    expect(matches).toEqual([]);
  });
});
