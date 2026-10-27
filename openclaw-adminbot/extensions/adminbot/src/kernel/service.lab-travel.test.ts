// The Travel tab at the service boundary: who may use it, what each viewer may read about the
// others, and that a location fix is only ever stored while its owner is sharing.
import { describe, expect, it } from "vitest";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const DATASET = [
  {
    id: "neurips2026_rebuttal",
    name: "NeurIPS 2026",
    venue_type: "rebuttal",
    venue_group: "NeurIPS 2026",
    venue_family: "NeurIPS",
    deadline_aoe: "2026-07-22 23:59:59",
    conference_location: "Sydney, Australia; Atlanta, USA; Paris, France",
    schedule: [
      {
        milestone: "conference",
        label: "Main conference — Sydney",
        starts: "2026-12-08",
        ends: "2026-12-10",
      },
      {
        milestone: "conference",
        label: "Main conference — Atlanta",
        starts: "2026-12-10",
        ends: "2026-12-11",
      },
      {
        milestone: "conference",
        label: "Main conference — Paris",
        starts: "2026-12-09",
        ends: "2026-12-11",
      },
    ],
  },
  {
    id: "emnlp2026_commitment",
    name: "EMNLP 2026",
    venue_type: "conference",
    venue_group: "EMNLP 2026",
    venue_family: "EMNLP",
    deadline_aoe: "2026-08-01 23:59:59",
    conference_location: "Budapest, Hungary",
    schedule: [
      {
        milestone: "conference",
        label: "Main conference",
        starts: "2026-10-24",
        ends: "2026-10-29",
      },
    ],
  },
];

function lab(start = "2026-10-13T12:00:00Z") {
  const clock = { now: new Date(start) };
  const service = new AdminBotService(undefined, {
    deadlineDataset: () => DATASET,
    now: () => clock.now,
  });
  const members: Array<Record<string, unknown>> = [
    { id: "ada", name: "Ada Lovelace", privilege_level: "member", location: "Toronto" },
    { id: "bob", name: "Bob Berlin", privilege_level: "member", location: "Berlin, Germany" },
    { id: "cy", name: "Cy Paris", privilege_level: "admin", location: "Paris" },
    { id: "dee", name: "Dee Quiet", privilege_level: "member", location: "Berlin" },
    { id: "ext", name: "Eve External", privilege_level: "external_collaborator" },
    { id: "tri", name: "Tri Trial", privilege_level: "trial" },
  ];
  for (const member of members) {
    unwrap(service.upsertLabMember({ status: "active", ...member } as never));
  }
  return { service, travel: () => service.labTravel(), clock };
}

describe("who may use the Travel tab", () => {
  it("refuses external collaborators and trial members on every route", () => {
    const { travel } = lab();
    for (const memberId of ["ext", "tri", "nobody"]) {
      expect(travel().overview(memberId)).toMatchObject({ ok: false, status: 403 });
      expect(travel().setSharing(memberId, { enabled: true })).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(travel().reportLocation(memberId, { lat: 1, lon: 1 })).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(travel().rsvp(memberId, "emnlp:2026", { intent: "going" })).toMatchObject({
        ok: false,
        status: 403,
      });
    }
  });
});

describe("conference RSVPs", () => {
  it("lists one entry per site and shows who is going, without their funding or notes", () => {
    const { travel } = lab();
    unwrap(
      travel().rsvp("bob", "neuripsparis:2026", {
        intent: "going",
        funding: "full_travel",
        needs_lodging: true,
        needs_visa_letter: true,
        notes: "Private: my scholarship ran out",
      }),
    );
    unwrap(travel().rsvp("dee", "neuripsparis:2026", { intent: "undecided", funding: "none" }));
    const overview = unwrap(travel().overview("ada"));
    expect(overview.conferences.map((site) => site.label)).toEqual([
      "EMNLP 2026",
      "NeurIPS 2026 — Sydney",
      "NeurIPS 2026 — Paris",
      "NeurIPS 2026 — Atlanta",
    ]);
    const paris = overview.conferences.find((site) => site.key === "neuripsparis:2026")!;
    expect(paris.going).toEqual([{ member_id: "bob", name: "Bob Berlin", airbnb: true }]);
    expect(paris.undecided_count).toBe(1);
    expect(paris.airbnb_count).toBe(1);
    expect(paris.my_rsvp).toBeUndefined();
    const wire = JSON.stringify(overview);
    expect(wire).not.toContain("full_travel");
    expect(wire).not.toContain("scholarship");
    // The member's own answer comes back in full.
    const bobs = unwrap(travel().overview("bob")).conferences.find(
      (site) => site.key === "neuripsparis:2026",
    );
    expect(bobs?.my_rsvp).toMatchObject({
      funding: "full_travel",
      notes: "Private: my scholarship ran out",
    });
  });

  it("fills Airbnb nights from the conference days when none are given", () => {
    const { travel } = lab();
    const saved = unwrap(
      travel().rsvp("ada", "emnlp:2026", { intent: "going", funding: "none", needs_lodging: true }),
    );
    expect(saved.trip).toMatchObject({ arrival_on: "2026-10-24", departure_on: "2026-10-29" });
  });

  it("refuses a conference that is not on the upcoming list", () => {
    const { travel } = lab();
    expect(travel().rsvp("ada", "madeup:2026", { intent: "going" })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(travel().withdraw("ada", "madeup:2026")).toMatchObject({ ok: false, status: 404 });
  });

  it("replaces a whole-conference answer once the member picks a site", () => {
    const { service, travel } = lab();
    // An answer given from an accepted paper's card, before NeurIPS was split into sites.
    unwrap(
      service.setConferenceTrip({
        conferenceKey: "neurips:2026",
        memberId: "ada",
        intent: "going",
        funding: "none",
      }),
    );
    const before = unwrap(travel().overview("ada")).conferences.filter((site) => site.multi_site);
    expect(before.every((site) => site.unsited_rsvp?.conference_key === "neurips:2026")).toBe(true);
    unwrap(travel().rsvp("ada", "neuripssydney:2026", { intent: "going", funding: "none" }));
    const after = unwrap(travel().overview("ada")).conferences.filter((site) => site.multi_site);
    expect(after.some((site) => site.unsited_rsvp)).toBe(false);
    expect(service.listConferenceTravelExport()).toMatchObject({
      payload: {
        rows: [expect.objectContaining({ conference: "NeurIPS 2026 — Sydney", member_id: "ada" })],
      },
    });
  });

  it("withdraws the viewer's own answer only", () => {
    const { travel } = lab();
    unwrap(travel().rsvp("ada", "emnlp:2026", { intent: "going", funding: "none" }));
    unwrap(travel().rsvp("bob", "emnlp:2026", { intent: "going", funding: "none" }));
    unwrap(travel().withdraw("ada", "emnlp:2026"));
    const emnlp = unwrap(travel().overview("ada")).conferences.find(
      (site) => site.key === "emnlp:2026",
    );
    expect(emnlp?.going.map((person) => person.member_id)).toEqual(["bob"]);
  });
});

describe("location sharing", () => {
  it("refuses a fix from somebody who is not sharing, and forgets everything on opt-out", () => {
    const { service, travel } = lab();
    expect(travel().reportLocation("ada", { lat: 48.8566, lon: 2.3522 })).toMatchObject({
      ok: false,
      status: 409,
    });
    unwrap(travel().setSharing("ada", { enabled: true }));
    const shared = unwrap(
      travel().reportLocation("ada", { lat: 48.858_37, lon: 2.294_48, accuracy_m: 30 }),
    );
    expect(shared.sharing.location).toMatchObject({ label: "Paris", key: "paris", accuracy_m: 30 });
    unwrap(travel().setSharing("ada", { enabled: false }));
    expect(service.labTravel().overview("ada")).toMatchObject({
      payload: { sharing: { enabled: false }, matches: [] },
    });
    expect(travel().reportLocation("ada", { lat: 48.8566, lon: 2.3522 })).toMatchObject({
      ok: false,
      status: 409,
    });
    const audit = service
      .listAuditEvents()
      .filter((event) => event.type.startsWith("location_sharing."));
    expect(audit.map((event) => event.type)).toEqual([
      "location_sharing.enabled",
      "location_sharing.disabled",
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/48\.8|Paris/u);
  });

  it("validates coordinates and refuses a fix too vague to name a city", () => {
    const { travel } = lab();
    unwrap(travel().setSharing("ada", { enabled: true }));
    expect(travel().reportLocation("ada", { lat: 91, lon: 0 })).toMatchObject({ status: 400 });
    expect(travel().reportLocation("ada", { lat: "48", lon: 2 })).toMatchObject({ status: 400 });
    expect(travel().reportLocation("ada", { lat: 48, lon: 2, accuracy_m: 500_000 })).toMatchObject({
      status: 422,
    });
    expect(travel().setSharing("ada", { enabled: "yes" })).toMatchObject({ status: 400 });
  });

  it("shows whereabouts only between members who both share, and never as coordinates", () => {
    const { travel } = lab();
    unwrap(travel().setSharing("cy", { enabled: true }));
    unwrap(travel().reportLocation("cy", { lat: 48.87, lon: 2.33 }));
    // Ada is in Paris too, but has not opted in: she sees nobody, and cannot look anybody up.
    expect(unwrap(travel().overview("ada"))).toMatchObject({ matches: [], sharing_members: 0 });
    expect(travel().whosIn("ada", new URLSearchParams({ place: "Paris" }))).toMatchObject({
      ok: false,
      status: 403,
    });
    unwrap(travel().setSharing("ada", { enabled: true }));
    unwrap(travel().reportLocation("ada", { lat: 48.8566, lon: 2.3522 }));
    const overview = unwrap(travel().overview("ada"));
    const now = overview.matches.find((group) => group.kind === "now");
    expect(now?.title).toBe("Near you now — Paris");
    expect(now?.people).toEqual([
      expect.objectContaining({
        member_id: "cy",
        basis: "live",
        place: { label: "Paris", country: "France", key: "paris" },
        distance_km: 0,
      }),
    ]);
    expect(JSON.stringify(now)).not.toMatch(/48\.87|2\.33/u);
  });

  it("keeps a non-sharing member's trips and home private, but not their public RSVP", () => {
    const { service, travel } = lab();
    unwrap(
      service.upsertLabMember({
        id: "dee",
        name: "Dee Quiet",
        privilege_level: "member",
        status: "active",
        location: "Berlin",
        trips: [{ start: "2026-10-20", end: "2026-10-30", city: "Budapest" }],
      } as never),
    );
    unwrap(travel().rsvp("dee", "emnlp:2026", { intent: "going", funding: "none" }));
    unwrap(travel().setSharing("bob", { enabled: true }));
    const lookup = unwrap(
      travel().whosIn(
        "bob",
        new URLSearchParams({ place: "Budapest", from: "2026-10-25", to: "2026-10-26" }),
      ),
    );
    expect(lookup.people).toEqual([
      expect.objectContaining({
        member_id: "dee",
        basis: "conference",
        conference_label: "EMNLP 2026",
      }),
    ]);
    // Dee lives in Berlin, which is where Bob is -- but she has not opted in.
    const berlin = unwrap(travel().whosIn("bob", new URLSearchParams({ place: "Berlin" })));
    expect(berlin.people).toEqual([]);
    // So the empty answer can say it only checked the members who share.
    expect(berlin.sharing_members).toBe(0);
    unwrap(travel().setSharing("cy", { enabled: true }));
    expect(
      unwrap(travel().whosIn("bob", new URLSearchParams({ place: "Berlin" }))).sharing_members,
    ).toBe(1);
    expect(unwrap(travel().overview("bob")).sharing_members).toBe(1);
  });

  it("matches the viewer's upcoming trips and conferences against sharing members", () => {
    const { service, travel } = lab();
    unwrap(
      service.upsertLabMember({
        id: "ada",
        name: "Ada Lovelace",
        privilege_level: "member",
        status: "active",
        location: "Toronto",
        trips: [{ start: "2026-11-01", end: "2026-11-05", city: "Berlin" }],
      } as never),
    );
    unwrap(travel().rsvp("ada", "neuripsparis:2026", { intent: "going", funding: "none" }));
    unwrap(travel().setSharing("ada", { enabled: true }));
    unwrap(travel().setSharing("bob", { enabled: true }));
    unwrap(travel().setSharing("cy", { enabled: true }));
    const groups = unwrap(travel().overview("ada")).matches;
    expect(groups.map((group) => [group.kind, group.title])).toEqual([
      ["now", "At home — Toronto"],
      ["trip", "Your trip to Berlin"],
      ["conference", "NeurIPS 2026 — Paris"],
    ]);
    expect(groups[1]!.people).toEqual([
      expect.objectContaining({ member_id: "bob", basis: "home" }),
    ]);
    expect(groups[2]!.people).toEqual([
      expect.objectContaining({ member_id: "cy", basis: "home" }),
    ]);
  });

  it("accepts a typed city in place of a measured fix, only while sharing and only a known city", () => {
    const { travel } = lab();
    expect(travel().reportLocation("ada", { place: "Lisbon" })).toMatchObject({ status: 409 });
    expect(travel().sharing("ada")).toMatchObject({ payload: { sharing: { enabled: false } } });
    unwrap(travel().setSharing("ada", { enabled: true }));
    const typed = unwrap(travel().reportLocation("ada", { place: "Lisbon, Portugal" }));
    expect(typed.sharing.location).toMatchObject({
      label: "Lisbon",
      country: "Portugal",
      distance_km: 0,
    });
    expect(travel().reportLocation("ada", { place: "Atlantis" })).toMatchObject({ status: 422 });
    expect(travel().reportLocation("ada", { place: "" })).toMatchObject({ status: 400 });
    expect(unwrap(travel().sharing("ada")).sharing.location?.label).toBe("Lisbon");
  });

  it("stops announcing a fix after three days", () => {
    const { travel, clock } = lab();
    unwrap(travel().setSharing("ada", { enabled: true }));
    unwrap(travel().setSharing("cy", { enabled: true }));
    unwrap(travel().reportLocation("cy", { lat: -33.87, lon: 151.21 }));
    const lookup = () =>
      unwrap(travel().whosIn("ada", new URLSearchParams({ place: "Sydney" }))).people;
    expect(lookup()).toEqual([expect.objectContaining({ member_id: "cy", basis: "live" })]);
    clock.now = new Date("2026-10-17T13:00:00Z");
    expect(lookup()).toEqual([]);
    expect(unwrap(travel().overview("cy")).sharing).toEqual(
      expect.not.objectContaining({ location: expect.anything() }),
    );
  });
});
