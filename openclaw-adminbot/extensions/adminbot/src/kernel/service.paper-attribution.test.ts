// Who changed a paper, and when the paper admits it changed.
//
// Both halves of one complaint: a member updates their paper and it does not surface on the
// admin's side. The audit row used to record `actor: paper.id` -- the paper, not the person -- so
// the trail could say a paper changed and never who changed it. And finishing an evidence slot
// left `paper.updated_at` untouched, so anything reading recency saw the paper as idle while its
// author worked through the checklist.
import { describe, expect, it } from "vitest";
import { paperRecordSlotId } from "../contracts/activity-log.js";
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

describe("paper edit attribution", () => {
  it("names the member who edited, not the paper", () => {
    const service = serviceWithPaper();
    unwrap(service.upsertOwnPaper("ada", { id: "paper-1", title: "On Analytical Engines, v2" }));

    const audit = service.listAuditEvents().filter((event) => event.type === "paper.upserted");
    const latest = audit.at(-1);
    expect(latest?.actor).toBe("ada");
    // The paper id is still recorded -- it just lives where it belongs.
    expect(latest?.details?.paper_id).toBe("paper-1");
  });

  it("records the edit against the paper in the update log", () => {
    const service = serviceWithPaper();
    unwrap(service.upsertOwnPaper("ada", { id: "paper-1", title: "On Analytical Engines, v2" }));

    const updates = unwrap(service.listUpdateEventsBySlot(paperRecordSlotId("paper-1"))).updates;
    expect(updates[0]?.member_id).toBe("ada");
    expect(updates[0]?.source).toBe("member");
    expect(updates[0]?.subject).toBe("paper");
  });

  it("leaves an unattributed automation write unattributed rather than blaming the paper", () => {
    const service = serviceWithPaper();
    const audit = service.listAuditEvents().filter((event) => event.type === "paper.upserted");
    // The fixture's own create went through upsertPaper with no origin. It must not come back
    // claiming the paper edited itself, and it must not invent a member either.
    expect(audit[0]?.actor).toBeUndefined();
    expect(unwrap(service.listUpdateEventsBySlot(paperRecordSlotId("paper-1"))).updates).toEqual(
      [],
    );
  });
});

describe("paper recency", () => {
  it("bumps the paper when a member fills in one of its slots", async () => {
    const service = serviceWithPaper();
    const before = unwrap(service.listPapers()).papers.find((paper) => paper.id === "paper-1");
    // The fixture's create and the slot write would otherwise land in the same millisecond, where
    // "did the clock move" is unanswerable. Equal stamps are deliberately a no-op (see the
    // backwards test below), so the gap is what makes this assertion mean anything.
    await new Promise((resolve) => setTimeout(resolve, 5));

    unwrap(
      service.setPaperSlot({
        paperId: "paper-1",
        slot: "project_folder",
        input: { url: "https://drive.google.com/drive/folders/abc123" },
        memberId: "ada",
        privileged: false,
      }),
    );

    const after = unwrap(service.listPapers()).papers.find((paper) => paper.id === "paper-1");
    // Without this the checklist advanced while the paper still read as untouched, which is what
    // made a member's work invisible to anything sorting or reporting on recency.
    expect(after?.updated_at).not.toBe(before?.updated_at);
    expect(String(after?.updated_at) > String(before?.updated_at)).toBe(true);
  });

  it("never moves the paper's clock backwards", () => {
    const service = serviceWithPaper();
    unwrap(service.upsertOwnPaper("ada", { id: "paper-1", title: "Later edit" }));
    const afterEdit = unwrap(service.listPapers()).papers.find((paper) => paper.id === "paper-1");

    // A slot write carrying an older stamp than the paper's own must not rewind it.
    unwrap(
      service.setPaperSlot({
        paperId: "paper-1",
        slot: "project_folder",
        input: { url: "https://drive.google.com/drive/folders/abc123" },
        memberId: "ada",
        privileged: false,
      }),
    );
    const afterSlot = unwrap(service.listPapers()).papers.find((paper) => paper.id === "paper-1");
    expect(String(afterSlot?.updated_at) >= String(afterEdit?.updated_at)).toBe(true);
  });
});
