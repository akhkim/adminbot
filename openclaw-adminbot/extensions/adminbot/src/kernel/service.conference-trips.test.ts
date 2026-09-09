// Signing up for a conference at the service boundary: what a member may say about their own
// trip, and who is allowed to read what everybody else said.
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

/** The first conference the shipped deadline dataset knows about, whatever it happens to be. */
function firstConference(service: AdminBotService): string {
  const key = unwrap(service.listConferenceOverview()).conferences[0]?.key;
  if (!key) {
    throw new Error("the deadline dataset carries no conferences");
  }
  return key;
}

function seeded(): AdminBotService {
  const service = new AdminBotService();
  for (const [id, name] of [
    ["ada", "Ada Lovelace"],
    ["bob", "Bob Coauthor"],
  ]) {
    unwrap(
      service.upsertLabMember({ id, name, privilege_level: "member", status: "active" } as never),
    );
  }
  unwrap(
    service.upsertPaper({
      id: "p1",
      title: "Causal abstraction",
      authors: ["Ada Lovelace"],
      current_step: "submission",
    }),
  );
  return service;
}

describe("listConferenceOverview", () => {
  it("offers conferences with a description to a signed-out reader", () => {
    const { conferences, mine } = unwrap(new AdminBotService().listConferenceOverview());
    expect(conferences.length).toBeGreaterThan(0);
    expect(conferences[0]?.description.length).toBeGreaterThan(0);
    expect(mine).toEqual([]);
    // Who is going is nobody's business but the lab's; a visitor gets the cards and no roster.
    expect(conferences[0]?.roster).toBeUndefined();
  });

  it("hands a member their own trip back and nobody else's", () => {
    const service = seeded();
    const key = firstConference(service);
    unwrap(
      service.setConferenceTrip({
        conferenceKey: key,
        memberId: "ada",
        intent: "going",
        funding: "full_travel",
      }),
    );
    unwrap(
      service.setConferenceTrip({
        conferenceKey: key,
        memberId: "bob",
        intent: "going",
        funding: "none",
      }),
    );
    const view = unwrap(service.listConferenceOverview({ memberId: "ada" }));
    expect(view.mine.map((trip) => trip.member_id)).toEqual(["ada"]);
    expect(view.conferences.find((entry) => entry.key === key)?.roster).toBeUndefined();
  });

  it("gives an admin the headcounts, the funding split and the booking span", () => {
    const service = seeded();
    const key = firstConference(service);
    unwrap(
      service.setConferenceTrip({
        conferenceKey: key,
        memberId: "ada",
        intent: "going",
        funding: "full_travel",
        needsLodging: true,
        arrivalOn: "2026-11-04",
        departureOn: "2026-11-09",
        needsVisaLetter: true,
        paperId: "p1",
      }),
    );
    unwrap(
      service.setConferenceTrip({
        conferenceKey: key,
        memberId: "bob",
        intent: "going",
        funding: "fee_only",
        needsLodging: true,
        arrivalOn: "2026-11-02",
        departureOn: "2026-11-07",
      }),
    );
    const roster = unwrap(service.listConferenceOverview({ isAdmin: true })).conferences.find(
      (entry) => entry.key === key,
    )?.roster;
    expect(roster?.going).toBe(2);
    expect(roster?.funding).toEqual({ none: 0, fee_only: 1, flight_only: 0, full_travel: 1 });
    expect(roster?.visa_letters).toBe(1);
    // The Airbnb answer: two beds, spanning everybody's nights.
    expect(roster?.lodging.guests).toBe(2);
    expect(roster?.lodging.first_night).toBe("2026-11-02");
    expect(roster?.lodging.last_night).toBe("2026-11-09");
    // The paper is resolved to its title, so the roster reads without a second lookup.
    expect(roster?.trips.find((trip) => trip.member_id === "ada")?.paper_title).toBe(
      "Causal abstraction",
    );
  });

  it("counts an undecided member as undecided rather than as a bed", () => {
    const service = seeded();
    const key = firstConference(service);
    unwrap(
      service.setConferenceTrip({
        conferenceKey: key,
        memberId: "ada",
        intent: "undecided",
        funding: "full_travel",
        needsLodging: true,
      }),
    );
    const roster = unwrap(service.listConferenceOverview({ isAdmin: true })).conferences.find(
      (entry) => entry.key === key,
    )?.roster;
    expect(roster?.undecided).toBe(1);
    expect(roster?.going).toBe(0);
    expect(roster?.lodging.guests).toBe(0);
    // Their funding answer is a plan, not a cost the lab has taken on.
    expect(roster?.funding.full_travel).toBe(0);
  });
});

describe("setConferenceTrip", () => {
  it("replaces the member's own row rather than stacking a second one", () => {
    const service = seeded();
    const key = firstConference(service);
    unwrap(
      service.setConferenceTrip({
        conferenceKey: key,
        memberId: "ada",
        intent: "going",
        funding: "full_travel",
      }),
    );
    unwrap(
      service.setConferenceTrip({
        conferenceKey: key,
        memberId: "ada",
        intent: "not_going",
        funding: "none",
      }),
    );
    const mine = unwrap(service.listConferenceOverview({ memberId: "ada" })).mine;
    expect(mine).toHaveLength(1);
    expect(mine[0]?.intent).toBe("not_going");
  });

  it("refuses a reversed date span rather than widening everyone else's booking", () => {
    const service = seeded();
    expect(
      service.setConferenceTrip({
        conferenceKey: firstConference(service),
        memberId: "ada",
        intent: "going",
        funding: "none",
        arrivalOn: "2026-11-09",
        departureOn: "2026-11-04",
      }),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses an unknown intent, funding bucket, member or paper", () => {
    const service = seeded();
    const key = firstConference(service);
    const base = { conferenceKey: key, memberId: "ada", intent: "going", funding: "none" };
    expect(service.setConferenceTrip({ ...base, intent: "maybe" })).toMatchObject({ status: 400 });
    expect(service.setConferenceTrip({ ...base, funding: "some" })).toMatchObject({ status: 400 });
    expect(service.setConferenceTrip({ ...base, memberId: "nobody" })).toMatchObject({
      status: 404,
    });
    // A dangling paper id would show up on the roster an admin reads before booking.
    expect(service.setConferenceTrip({ ...base, paperId: "no-such-paper" })).toMatchObject({
      status: 404,
    });
  });

  it("records the sign-up in the audit trail", () => {
    const service = seeded();
    unwrap(
      service.setConferenceTrip({
        conferenceKey: firstConference(service),
        memberId: "ada",
        intent: "going",
        funding: "fee_only",
      }),
    );
    const audit = service
      .listAuditEvents()
      .filter((event) => event.type === "conference_trip.updated");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor).toBe("ada");
  });
});
