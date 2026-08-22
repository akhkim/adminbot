// Paper evidence slots at the service boundary: who may write one, what the overview says, and
// what the global nudge actually sends.
//
// Its own file rather than more of service.test.ts, which is already the longest in the extension.
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

/** A nudge only counts as sent when a connector handled it, so the send tests need one. */
function serviceWithDelivery(): AdminBotService {
  return new AdminBotService(undefined, {
    executor: {
      execute: async (proposal) => ({
        handled: proposal.type === "member_nudge.send",
      }),
    },
  });
}

function seed(service: AdminBotService): void {
  unwrap(
    service.upsertLabMember({
      id: "ada",
      name: "Ada Lovelace",
      privilege_level: "member",
      slack_user_id: "U-ADA",
    } as never),
  );
  unwrap(
    service.upsertLabMember({
      id: "bob",
      name: "Bob Coauthor",
      privilege_level: "member",
      slack_user_id: "U-BOB",
    } as never),
  );
  unwrap(
    service.upsertPaper({
      id: "p1",
      title: "Causal abstraction",
      authors: ["Ada Lovelace", "Bob Coauthor"],
      current_step: "overleaf_writing",
      first_author_member_id: "ada",
    }),
  );
}

describe("listPaperSlots", () => {
  it("answers with all 24 rows, so the card renders a checklist rather than a list of answers", () => {
    const service = new AdminBotService();
    seed(service);
    const { slots } = unwrap(service.listPaperSlots("p1"));
    expect(slots).toHaveLength(24);
    expect(slots.every((slot) => slot.status === "missing")).toBe(true);
  });

  it("404s on a paper that does not exist", () => {
    expect(new AdminBotService().listPaperSlots("nope")).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});

describe("setPaperSlot", () => {
  it("lets an author write their own paper", () => {
    const service = new AdminBotService();
    seed(service);
    const { slot } = unwrap(
      service.setPaperSlot({
        paperId: "p1",
        slot: "project_folder",
        input: { url: "https://docs.google.com/document/d/x" },
        memberId: "ada",
        privileged: false,
      }),
    );
    expect(slot.status).toBe("provided");
  });

  it("refuses a member who is not on the paper", () => {
    const service = new AdminBotService();
    seed(service);
    unwrap(
      service.upsertLabMember({
        id: "eve",
        name: "Eve Outsider",
        privilege_level: "member",
      } as never),
    );
    expect(
      service.setPaperSlot({
        paperId: "p1",
        slot: "project_folder",
        input: { url: "https://docs.google.com/document/d/x" },
        memberId: "eve",
        privileged: false,
      }),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects a slot name that is not in the registry", () => {
    const service = new AdminBotService();
    seed(service);
    expect(
      service.setPaperSlot({
        paperId: "p1",
        slot: "make_coffee",
        input: { done: true },
        memberId: "ada",
        privileged: true,
      }),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("writes an audit line, so evidence has the same paper trail as everything else", () => {
    const service = new AdminBotService();
    seed(service);
    unwrap(
      service.setPaperSlot({
        paperId: "p1",
        slot: "pdf_ready",
        input: { done: true },
        memberId: "ada",
        privileged: false,
      }),
    );
    expect(service.listAuditEvents().some((event) => event.type === "paper_slot.updated")).toBe(
      true,
    );
  });
});

describe("the paper fields the slots hang off", () => {
  it("lets an author retarget their own paper", () => {
    const service = new AdminBotService();
    seed(service);
    const saved = unwrap(
      service.upsertOwnPaper("ada", { id: "p1", venue: "ICLR 2027", deadline: "2026-09-24" }),
    );
    expect(saved).toMatchObject({ venue: "ICLR 2027", deadline: "2026-09-24" });
  });

  it("refuses the governance fields outright rather than silently dropping them", () => {
    const service = new AdminBotService();
    seed(service);
    for (const field of [
      "first_author_member_id",
      "venue_decision",
      "attempt",
      "dormant_override",
    ]) {
      expect(service.upsertOwnPaper("ada", { id: "p1", [field]: "bob" })).toMatchObject({
        ok: false,
        status: 400,
      });
    }
  });
});

describe("listPaperSlotOverview", () => {
  it("counts what is in and names what is outstanding", () => {
    const service = new AdminBotService();
    seed(service);
    unwrap(
      service.setPaperSlot({
        paperId: "p1",
        slot: "project_folder",
        input: { url: "https://docs.google.com/document/d/x" },
        memberId: "ada",
        privileged: false,
      }),
    );
    const [row] = unwrap(service.listPaperSlotOverview()).papers;
    expect(row).toMatchObject({
      paper_id: "p1",
      provided_count: 1,
      missing_slots: ["overleaf_edit"],
      first_author_member_id: "ada",
      dormant: false,
      closed: false,
      cycle_closed: false,
    });
  });
});

describe("collectPaperNudgeBatches", () => {
  it("says who would be messaged and exactly what they would receive, without sending", async () => {
    const service = serviceWithDelivery();
    seed(service);
    const { batches, papers_considered } = unwrap(service.collectPaperNudgeBatches());
    expect(papers_considered).toBe(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      member_id: "ada",
      member_name: "Ada Lovelace",
      deliverable: true,
      item_count: 1,
    });
    expect(batches[0]?.message).toContain("Project folder or brainstorm doc");
    // Nothing left the service: reading the preview must not consume the cadence.
    expect(service.listNudgeLedgerForTest()).toEqual([]);
    const after = unwrap(await service.sendPaperSlotNudges("zhijing"));
    expect(after.created).toHaveLength(1);
  });

  it("flags a recipient with no Slack id instead of quietly dropping them", () => {
    const service = new AdminBotService();
    unwrap(
      service.upsertLabMember({
        id: "ada",
        name: "Ada Lovelace",
        privilege_level: "member",
      } as never),
    );
    unwrap(
      service.upsertPaper({
        id: "p1",
        title: "Causal abstraction",
        authors: ["Ada Lovelace"],
        current_step: "overleaf_writing",
        first_author_member_id: "ada",
      }),
    );
    const { batches } = unwrap(service.collectPaperNudgeBatches());
    expect(batches[0]).toMatchObject({ member_id: "ada", deliverable: false });
  });
});

describe("sendPaperSlotNudges", () => {
  it("messages the first author with exactly what is missing", async () => {
    const service = serviceWithDelivery();
    seed(service);
    const result = unwrap(await service.sendPaperSlotNudges("zhijing"));
    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.summary).toContain("Ada Lovelace");
    // The counters live in the ledger now, keyed by who was asked -- that is what lets one sweep
    // batch a person's papers, profile and reimbursements into a single message.
    const ledger = service.listNudgeLedgerForTest("paper_slot");
    const entry = ledger.find((row) => row.subject_id === "p1:project_folder");
    expect(entry).toMatchObject({ member_id: "ada", nudge_count: 1 });
    expect(entry?.last_nudged_at).toBeTruthy();
  });

  it("keeps its own cadence, so running twice does not nag", async () => {
    const service = serviceWithDelivery();
    seed(service);
    unwrap(await service.sendPaperSlotNudges("cron"));
    const second = unwrap(await service.sendPaperSlotNudges("cron"));
    expect(second.created).toHaveLength(0);
  });

  it("stays quiet on a paper whose evidence is all in", async () => {
    const service = serviceWithDelivery();
    seed(service);
    unwrap(
      service.waivePaperSlot({
        paperId: "p1",
        slot: "project_folder",
        reason: "predates AdminBot",
        memberId: "zhijing",
      }),
    );
    const result = unwrap(await service.sendPaperSlotNudges("cron"));
    // The waiver unblocked the next slot, so there is still exactly one thing to ask for -- and it
    // is the next one, not the waived one.
    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.summary).toContain("Ada");
  });

  it("does not stamp a slot when nobody could be reached", async () => {
    // No connector handles the proposal, so nothing was delivered.
    const service = new AdminBotService();
    seed(service);
    unwrap(await service.sendPaperSlotNudges("cron"));
    expect(service.listNudgeLedgerForTest("paper_slot")).toEqual([]);
  });

  it("sends only to the people an admin picked out of the preview", async () => {
    const service = serviceWithDelivery();
    seed(service);
    // Ada owes the project folder; nobody else owes anything on this paper.
    const result = unwrap(await service.sendPaperSlotNudges("zhijing", { recipientIds: ["bob"] }));
    expect(result.created).toHaveLength(0);
    // Ada was not messaged, so her cadence is untouched and she is still due next time.
    expect(service.listNudgeLedgerForTest()).toEqual([]);
    const second = unwrap(await service.sendPaperSlotNudges("zhijing", { recipientIds: ["ada"] }));
    expect(second.created).toHaveLength(1);
  });

  it("says nothing at all when there are no papers", async () => {
    const service = serviceWithDelivery();
    const result = unwrap(await service.sendPaperSlotNudges("cron"));
    expect(result).toMatchObject({
      created: [],
      skipped: [],
      papers_considered: 0,
    });
  });
});
