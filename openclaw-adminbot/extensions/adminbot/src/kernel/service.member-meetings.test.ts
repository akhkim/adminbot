// The profile field that says which standing meetings somebody is in, and what saving it sets off.
//
// The invariant these are all about: an answer here *proposes* an invite and never sends one, and
// anything it cannot resolve -- a member with no calendar address, a meeting that is not on the
// calendar, a topic two events answer to -- ends as a skip rather than as a guess.
import { describe, expect, it } from "vitest";
import { AdminBotService } from "./service.js";

const SERIES = "f4d1qkcntmet3g8033kbugn40q";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

function labWithCatalog(options: { calendarEmail?: string } = {}) {
  const service = new AdminBotService();
  unwrap(
    service.refreshMeetingCatalog(
      {
        events: [
          {
            id: `${SERIES}_20260923T130000Z`,
            summary: "Theme: Causal Inference",
          },
          { id: "proj-law", summary: "Proj: Law to Benchmark" },
        ],
        calendarId: "lab@example.com",
      },
      "admin",
    ),
  );
  unwrap(
    service.upsertLabMember({
      id: "pat",
      name: "Pat",
      email: "pat@lab.co",
      ...(options.calendarEmail === undefined
        ? { calendar_email: "pat@gmail.com" }
        : options.calendarEmail
          ? { calendar_email: options.calendarEmail }
          : {}),
    } as never),
  );
  return service;
}

const inviteProposals = (service: AdminBotService) =>
  unwrap(service.listPending()).proposals.filter(
    (proposal) => proposal.type === "calendar.add_attendees",
  );

describe("meeting catalog", () => {
  it("offers one entry per meeting, with the series id an invite can target", () => {
    const service = labWithCatalog();
    expect(unwrap(service.listMeetingCatalog()).meetings.map((entry) => entry.event_id)).toEqual([
      SERIES,
      "proj-law",
    ]);
  });

  it("drops a meeting that has left the calendar", () => {
    const service = labWithCatalog();
    const refreshed = unwrap(
      service.refreshMeetingCatalog(
        { events: [{ id: "proj-law", summary: "Proj: Law to Benchmark" }] },
        "admin",
      ),
    );
    expect(refreshed.removed).toBe(1);
    expect(unwrap(service.listMeetingCatalog()).meetings).toHaveLength(1);
  });

  it("refuses to empty itself from a read that found nothing", () => {
    const service = labWithCatalog();
    const refused = service.refreshMeetingCatalog({ events: [] }, "admin");
    expect(refused.ok).toBe(false);
    expect(unwrap(service.listMeetingCatalog()).meetings).toHaveLength(2);
    // A caller that means it can still say so.
    unwrap(service.refreshMeetingCatalog({ events: [], allowEmpty: true }, "admin"));
    expect(unwrap(service.listMeetingCatalog()).meetings).toHaveLength(0);
  });
});

describe("saving the meetings field", () => {
  it("proposes the member onto each meeting they picked, and invites nobody", () => {
    const service = labWithCatalog();
    unwrap(service.updateOwnProfile("pat", { meetings: ["Causal Inference"] }));
    const proposals = inviteProposals(service);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.target.target).toBe(SERIES);
    expect(proposals[0]?.proposed_payload).toMatchObject({
      calendar_id: "lab@example.com",
      event_id: SERIES,
      attendees: ["pat@gmail.com"],
    });
    // Proposed, not executed: nothing reaches a calendar until an admin approves.
    expect(proposals[0]?.status).not.toBe("executed");
  });

  it("keeps the answer on the record", () => {
    const service = labWithCatalog();
    const saved = unwrap(
      service.updateOwnProfile("pat", {
        meetings: ["Causal Inference", "Law to Benchmark"],
      }),
    );
    expect(saved.meetings).toEqual(["Causal Inference", "Law to Benchmark"]);
    expect(inviteProposals(service)).toHaveLength(2);
  });

  it("proposes only what is newly ticked, and nothing at all on a re-save", () => {
    const service = labWithCatalog();
    unwrap(service.updateOwnProfile("pat", { meetings: ["Causal Inference"] }));
    unwrap(service.updateOwnProfile("pat", { meetings: ["Causal Inference"] }));
    expect(inviteProposals(service)).toHaveLength(1);
    unwrap(
      service.updateOwnProfile("pat", {
        meetings: ["Causal Inference", "Law to Benchmark"],
      }),
    );
    expect(inviteProposals(service).map((proposal) => proposal.target.target)).toEqual([
      SERIES,
      "proj-law",
    ]);
  });

  it("proposes no removal when a member unticks one", () => {
    const service = labWithCatalog();
    unwrap(service.updateOwnProfile("pat", { meetings: ["Causal Inference"] }));
    unwrap(service.updateOwnProfile("pat", { meetings: [] }));
    expect(
      unwrap(service.listPending()).proposals.filter(
        (proposal) => proposal.type === "calendar.remove_attendees",
      ),
    ).toHaveLength(0);
  });

  it("saves the answer but proposes nothing when the member has no calendar address", () => {
    const service = labWithCatalog({ calendarEmail: "" });
    const saved = unwrap(service.updateOwnProfile("pat", { meetings: ["Causal Inference"] }));
    expect(saved.meetings).toEqual(["Causal Inference"]);
    expect(inviteProposals(service)).toHaveLength(0);
    const audit = service
      .listAuditEvents()
      .find((event) => event.type === "member_meetings.invites_proposed");
    expect(audit?.details).toMatchObject({
      skipped: ["member has no calendar_email"],
    });
  });

  it("skips a meeting the calendar does not carry, and says which", () => {
    const service = labWithCatalog();
    unwrap(service.updateOwnProfile("pat", { meetings: ["Retired Theme"] }));
    expect(inviteProposals(service)).toHaveLength(0);
    const audit = service
      .listAuditEvents()
      .find((event) => event.type === "member_meetings.invites_proposed");
    expect(audit?.details).toMatchObject({
      skipped: ['meeting "Retired Theme" is not on the calendar'],
    });
  });

  it("skips a topic two events answer to rather than picking one", () => {
    const service = labWithCatalog();
    unwrap(
      service.refreshMeetingCatalog(
        {
          events: [
            { id: "left", summary: "Theme: Causal LLM" },
            { id: "right", summary: "Theme: Causal LLM" },
          ],
        },
        "admin",
      ),
    );
    unwrap(service.updateOwnProfile("pat", { meetings: ["Causal LLM"] }));
    expect(inviteProposals(service)).toHaveLength(0);
    const audit = service
      .listAuditEvents()
      .find((event) => event.type === "member_meetings.invites_proposed");
    expect(audit?.details).toMatchObject({
      skipped: ['meeting "Causal LLM" matches more than one event on the calendar'],
    });
  });

  it("refuses an answer that is not a list of names", () => {
    const service = labWithCatalog();
    const refused = service.updateOwnProfile("pat", {
      meetings: "Causal Inference",
    });
    expect(refused.ok).toBe(false);
  });
});
