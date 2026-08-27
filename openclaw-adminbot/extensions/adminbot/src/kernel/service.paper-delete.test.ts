// Removing a paper: who may, and what goes with it.
//
// Deletion is the one paper write that cannot be inspected afterwards -- the record is gone -- so
// the two things worth pinning are the ownership rule and the cascade. An orphan left behind by a
// delete is worse than a leak: a re-created id would inherit the evidence, the drafts and the
// weekly updates of a paper somebody deliberately removed.
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

function serviceWithPaper(): AdminBotService {
  const service = new AdminBotService();
  unwrap(
    service.upsertLabMember({
      id: "ada",
      name: "Ada Lovelace",
      privilege_level: "member",
    } as never),
  );
  unwrap(
    service.upsertLabMember({
      id: "grace",
      name: "Grace Hopper",
      privilege_level: "member",
    } as never),
  );
  unwrap(
    service.upsertPaper({
      id: "paper-1",
      title: "On Analytical Engines",
      authors: ["Ada Lovelace"],
      current_step: "brainstorming_docs",
      submitted_by_member_id: "ada",
    } as never),
  );
  return service;
}

describe("deleteOwnPaper", () => {
  it("lets the author remove a paper they filed", () => {
    const service = serviceWithPaper();
    expect(unwrap(service.deleteOwnPaper("ada", "paper-1")).deleted).toBe(true);
    expect(unwrap(service.listPapers()).papers.map((paper) => paper.id)).toEqual([]);
  });

  it("refuses somebody else's paper", () => {
    const service = serviceWithPaper();
    const result = service.deleteOwnPaper("grace", "paper-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
    }
    // And the paper is still there, which is the half that actually matters.
    expect(unwrap(service.listPapers()).papers.map((paper) => paper.id)).toEqual(["paper-1"]);
  });

  it("404s on a paper that is not there rather than reporting a delete", () => {
    const service = serviceWithPaper();
    expect(service.deleteOwnPaper("ada", "nothing").ok).toBe(false);
  });

  it("names the member on the audit row, not the paper", () => {
    const service = serviceWithPaper();
    unwrap(service.deleteOwnPaper("ada", "paper-1"));
    const deleted = service.listAuditEvents().filter((event) => event.type === "paper.deleted");
    // The record is gone, so this row is the only surviving answer to "who did this".
    expect(deleted.at(-1)?.actor).toBe("ada");
    expect(deleted.at(-1)?.details?.paper_id).toBe("paper-1");
  });
});

describe("the cascade", () => {
  it("takes the evidence slots and the weekly updates with the paper", () => {
    const service = serviceWithPaper();
    unwrap(
      service.setPaperSlot({
        paperId: "paper-1",
        slot: "project_folder",
        input: { url: "https://drive.google.com/drive/folders/abc123" },
        memberId: "ada",
        privileged: false,
      }),
    );
    unwrap(
      service.savePaperWeeklyUpdate({
        paperId: "paper-1",
        memberId: "ada",
        body: "Wrote the intro.",
      }),
    );

    unwrap(service.deleteOwnPaper("ada", "paper-1"));

    // Re-create the same id. Nothing of the old paper may come back with it.
    unwrap(
      service.upsertPaper({
        id: "paper-1",
        title: "A different paper that reused the id",
        authors: ["Ada Lovelace"],
        current_step: "brainstorming_docs",
        submitted_by_member_id: "ada",
      } as never),
    );
    const slots = unwrap(service.listPaperSlots("paper-1")).slots;
    expect(slots.filter((slot) => slot.status === "provided")).toEqual([]);
    expect(unwrap(service.listPaperWeeklyUpdates("paper-1")).updates).toEqual([]);
  });
});
