// The refresh sweep's half of the Opportunities board: what it may file, and what only a person
// may do with it.
//
// The rule these are all about is the board's own: "an unannounced deadline must never render as
// if it were a real one, because members plan around this tab". These programs are annual and
// their pages are edited in place, so a page carrying last year's date looks exactly like one
// carrying next year's. The sweep therefore proposes and never writes.
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

function labWithOpportunity(deadline = "2026-09-01 23:59:59") {
  const service = new AdminBotService();
  unwrap(
    service.upsertLabMember({
      id: "ada",
      name: "Ada Lovelace",
      privilege_level: "member",
    } as never),
  );
  const opportunity = unwrap(
    service.submitOpportunity("ada", {
      name: "Rising Stars in EECS",
      category: "rising_stars",
      link: "https://risingstars.example.edu/2027",
      deadline_aoe: deadline,
    }),
  ).opportunity;
  return { service, id: opportunity.id };
}

const proposal = (id: string, deadline: string) => ({
  opportunityId: id,
  deadlineAoe: deadline,
  sourceUrl: "https://risingstars.example.edu/2027",
  evidence: "Applications are due 15 October 2027 (AoE).",
  actor: "sweep",
});

describe("proposing a swept deadline", () => {
  it("files the date without touching the board", () => {
    const { service, id } = labWithOpportunity();
    const result = unwrap(service.proposeOpportunityDeadline(proposal(id, "2027-10-15 23:59:59")));
    expect(result.filed).toBe(true);
    // The published date is unchanged; only the proposal beside it is new.
    expect(result.opportunity.deadline_aoe).toBe("2026-09-01 23:59:59");
    expect(result.opportunity.proposed_deadline).toMatchObject({
      deadline_aoe: "2027-10-15 23:59:59",
      source_url: "https://risingstars.example.edu/2027",
      evidence: "Applications are due 15 October 2027 (AoE).",
    });
  });

  // The sweep runs on a schedule over pages that mostly do not change. A queue that fills with
  // "still the same date" is one nobody reads, so an unchanged reading is not a proposal.
  it("says nothing when the page still shows the stored date", () => {
    const { service, id } = labWithOpportunity();
    const result = unwrap(service.proposeOpportunityDeadline(proposal(id, "2026-09-01 23:59:59")));
    expect(result.filed).toBe(false);
    expect(result.opportunity.proposed_deadline).toBeUndefined();
  });

  it("refuses a date that is not an AoE wall clock", () => {
    const { service, id } = labWithOpportunity();
    expect(service.proposeOpportunityDeadline(proposal(id, "next October"))).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  // A proposal with nowhere to check it is a bare assertion, and checking it is the work the
  // sweep exists to save.
  it("refuses a proposal that does not name the page it read", () => {
    const { service, id } = labWithOpportunity();
    expect(
      service.proposeOpportunityDeadline({
        ...proposal(id, "2027-10-15 23:59:59"),
        sourceUrl: "",
      }),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("does not invent an entry for a page it cannot match", () => {
    const { service } = labWithOpportunity();
    expect(
      service.proposeOpportunityDeadline(proposal("opp_nope", "2027-10-15 23:59:59")),
    ).toMatchObject({ ok: false, status: 404 });
  });
});

describe("deciding a swept deadline", () => {
  it("publishes the date on accept and clears the proposal", () => {
    const { service, id } = labWithOpportunity();
    unwrap(service.proposeOpportunityDeadline(proposal(id, "2027-10-15 23:59:59")));
    const decided = unwrap(service.resolveOpportunityDeadlineProposal(id, true, "grace"));
    expect(decided.opportunity.deadline_aoe).toBe("2027-10-15 23:59:59");
    expect(decided.opportunity.proposed_deadline).toBeUndefined();
  });

  it("leaves the board alone on dismiss", () => {
    const { service, id } = labWithOpportunity();
    unwrap(service.proposeOpportunityDeadline(proposal(id, "2027-10-15 23:59:59")));
    const decided = unwrap(service.resolveOpportunityDeadlineProposal(id, false, "grace"));
    expect(decided.opportunity.deadline_aoe).toBe("2026-09-01 23:59:59");
    expect(decided.opportunity.proposed_deadline).toBeUndefined();
  });

  // Dismissing forgets rather than remembers: the page is read again next sweep, and a date
  // somebody said no to in July may be right once the host updates the page. The equality check
  // is what stops that being a loop -- it only comes back if the page still says it.
  it("lets a dismissed date be proposed again", () => {
    const { service, id } = labWithOpportunity();
    unwrap(service.proposeOpportunityDeadline(proposal(id, "2027-10-15 23:59:59")));
    unwrap(service.resolveOpportunityDeadlineProposal(id, false, "grace"));
    const again = unwrap(service.proposeOpportunityDeadline(proposal(id, "2027-10-15 23:59:59")));
    expect(again.filed).toBe(true);
  });

  it("has nothing to decide without a proposal", () => {
    const { service, id } = labWithOpportunity();
    expect(service.resolveOpportunityDeadlineProposal(id, true, "grace")).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});

// Discovery: a sweep filing something nobody asked for. The board is served to signed-out
// visitors, so nothing a sweep finds is ever published by the sweep -- an admin publishes it.
describe("a discovered opportunity", () => {
  const found = (url: string, overrides: Record<string, unknown> = {}) => ({
    input: {
      name: "Rising Stars in EECS 2027",
      category: "rising_stars" as const,
      link: url,
      ...overrides,
    },
    discovery: {
      feed: "web",
      source_url: url,
      evidence: "Applications are due 15 October 2027.",
      found_at: "2026-09-05T00:00:00.000Z",
    },
    actor: "sweep",
  });

  function lab() {
    const service = new AdminBotService();
    unwrap(
      service.upsertLabMember({
        id: "grace",
        name: "Grace Hopper",
        privilege_level: "admin",
      } as never),
    );
    return service;
  }

  it("arrives pending, with where it came from on the record", () => {
    const service = lab();
    const result = unwrap(
      service.submitDiscoveredOpportunity(found("https://risingstars.example.edu/2027")),
    );
    expect(result.filed).toBe(true);
    expect(result.opportunity.status).toBe("pending");
    expect(result.opportunity.discovered).toMatchObject({
      feed: "web",
      source_url: "https://risingstars.example.edu/2027",
      evidence: "Applications are due 15 October 2027.",
    });
  });

  // The sweep re-reads the same hubs every week and would otherwise file the same programme
  // every week.
  it("does not file a source already on the board", () => {
    const service = lab();
    unwrap(service.submitDiscoveredOpportunity(found("https://risingstars.example.edu/2027")));
    const again = unwrap(
      service.submitDiscoveredOpportunity(found("https://risingstars.example.edu/2027")),
    );
    expect(again.filed).toBe(false);
  });

  // The rule that makes the queue survivable, and the deliberate opposite of what the deadline
  // refresh does: there the page is the subject and a dismissed date must be proposable again;
  // here the source is the subject, and asking twice about a programme the lab declined is how a
  // review queue becomes noise.
  it("stays rejected once an admin has said no", () => {
    const service = lab();
    const filed = unwrap(
      service.submitDiscoveredOpportunity(found("https://risingstars.example.edu/2027")),
    ).opportunity;
    unwrap(service.decideOpportunity(filed.id, "rejected", "grace"));
    const again = unwrap(
      service.submitDiscoveredOpportunity(found("https://risingstars.example.edu/2027")),
    );
    expect(again.filed).toBe(false);
    expect(
      unwrap(service.listOpportunities({ memberId: "grace", isAdmin: true })).opportunities.filter(
        (entry) => entry.status === "pending",
      ),
    ).toEqual([]);
  });

  it("refuses a candidate with nowhere to check it", () => {
    const service = lab();
    expect(
      service.submitDiscoveredOpportunity({
        ...found("https://risingstars.example.edu/2027"),
        discovery: {
          feed: "web",
          source_url: "",
          evidence: "",
          found_at: "2026-09-05T00:00:00.000Z",
        },
      }),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("holds a candidate to the same rules a member's submission is held to", () => {
    const service = lab();
    expect(
      service.submitDiscoveredOpportunity(
        found("https://risingstars.example.edu/2027", { name: "" }),
      ),
    ).toMatchObject({ ok: false, status: 400 });
  });
});
