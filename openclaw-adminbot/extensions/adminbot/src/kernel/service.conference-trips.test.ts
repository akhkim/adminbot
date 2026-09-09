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

/**
 * The conference key an accepted paper resolves to.
 *
 * Read back off the card rather than spelled by hand, so the test agrees with the service about
 * how a paper maps to a conference instead of asserting against a second copy of the rule.
 */
function firstConference(service: AdminBotService): string {
  const key = unwrap(service.listPaperSlots("p1")).conference_key;
  if (!key) {
    throw new Error("the seeded paper has no conference key");
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
      // Accepted with all four details, which is what gives the paper a conference to travel to.
      venue_decision: "accept",
      accepted_venue: "EMNLP",
      accepted_year: 2026,
      is_archival: true,
      presentation_type: "poster",
    }),
  );
  return service;
}

describe("the trip on the paper card", () => {
  it("names the conference only once the acceptance details are in", () => {
    const service = seeded();
    expect(unwrap(service.listPaperSlots("p1")).conference_key).toBeTruthy();
    unwrap(
      service.upsertPaper({
        id: "p2",
        title: "Not accepted yet",
        authors: ["Ada Lovelace"],
        current_step: "submission",
      }),
    );
    // No venue to travel to, so no key and no block on the card.
    expect(unwrap(service.listPaperSlots("p2")).conference_key).toBeUndefined();
  });

  it("hands the reader their own trip and nobody else's", () => {
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
    expect(unwrap(service.listPaperSlots("p1", { memberId: "ada" })).my_trip?.funding).toBe(
      "full_travel",
    );
    expect(unwrap(service.listPaperSlots("p1", { memberId: "bob" })).my_trip?.funding).toBe("none");
    // A signed-out or unidentified reader gets nobody's answer.
    expect(unwrap(service.listPaperSlots("p1")).my_trip).toBeUndefined();
  });

  it("gives two papers at one venue the same key, so one answer covers both", () => {
    const service = seeded();
    unwrap(
      service.upsertPaper({
        id: "p2",
        title: "Second EMNLP paper",
        authors: ["Ada Lovelace"],
        current_step: "submission",
        venue_decision: "accept",
        // A different spelling of the same venue, which the key has to fold together.
        accepted_venue: "emnlp",
        accepted_year: 2026,
        is_archival: true,
        presentation_type: "oral",
      }),
    );
    const first = unwrap(service.listPaperSlots("p1")).conference_key;
    expect(unwrap(service.listPaperSlots("p2")).conference_key).toBe(first);

    unwrap(
      service.setConferenceTrip({
        conferenceKey: first as string,
        memberId: "ada",
        intent: "going",
        funding: "fee_only",
      }),
    );
    // Answered on one card, present on the other.
    expect(unwrap(service.listPaperSlots("p2", { memberId: "ada" })).my_trip?.funding).toBe(
      "fee_only",
    );
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
        intent: "undecided",
        funding: "none",
      }),
    );
    expect(unwrap(service.listPaperSlots("p1", { memberId: "ada" })).my_trip?.intent).toBe(
      "undecided",
    );
  });

  it("refuses not_going, which is the absence of a row rather than a value", () => {
    const service = seeded();
    expect(
      service.setConferenceTrip({
        conferenceKey: firstConference(service),
        memberId: "ada",
        intent: "not_going",
        funding: "none",
      }),
    ).toMatchObject({ ok: false, status: 400 });
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

describe("withdrawConferenceTrip", () => {
  it("puts the member back in the not-going default by removing their row", () => {
    const service = seeded();
    const key = firstConference(service);
    unwrap(
      service.setConferenceTrip({
        conferenceKey: key,
        memberId: "ada",
        intent: "going",
        funding: "full_travel",
        needsLodging: true,
      }),
    );
    unwrap(service.withdrawConferenceTrip({ conferenceKey: key, memberId: "ada" }));

    expect(unwrap(service.listPaperSlots("p1", { memberId: "ada" })).my_trip).toBeUndefined();
  });

  it("is idempotent, because withdrawing twice is still not going", () => {
    const service = seeded();
    const key = firstConference(service);
    expect(unwrap(service.withdrawConferenceTrip({ conferenceKey: key, memberId: "ada" }))).toEqual(
      { withdrawn: false },
    );
    unwrap(
      service.setConferenceTrip({
        conferenceKey: key,
        memberId: "ada",
        intent: "going",
        funding: "none",
      }),
    );
    expect(unwrap(service.withdrawConferenceTrip({ conferenceKey: key, memberId: "ada" }))).toEqual(
      { withdrawn: true },
    );
    expect(unwrap(service.withdrawConferenceTrip({ conferenceKey: key, memberId: "ada" }))).toEqual(
      { withdrawn: false },
    );
  });

  it("records a withdrawal, but not a no-op", () => {
    const service = seeded();
    const key = firstConference(service);
    service.withdrawConferenceTrip({ conferenceKey: key, memberId: "ada" });
    expect(
      service.listAuditEvents().filter((event) => event.type === "conference_trip.withdrawn"),
    ).toHaveLength(0);
    unwrap(
      service.setConferenceTrip({
        conferenceKey: key,
        memberId: "ada",
        intent: "going",
        funding: "none",
      }),
    );
    unwrap(service.withdrawConferenceTrip({ conferenceKey: key, memberId: "ada" }));
    expect(
      service.listAuditEvents().filter((event) => event.type === "conference_trip.withdrawn"),
    ).toHaveLength(1);
  });

  it("refuses a member who is not on the roster", () => {
    const service = seeded();
    expect(
      service.withdrawConferenceTrip({
        conferenceKey: firstConference(service),
        memberId: "nobody",
      }),
    ).toMatchObject({ ok: false, status: 404 });
  });
});
