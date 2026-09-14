// Where the evidence says a paper is, and the two ways that walk must not lie.
import { describe, expect, it } from "vitest";
import type { AdminBotPaperSlot, AdminBotPaperSlotRecord } from "../../contracts/paper-slots.js";
import { adminBotStepGatingSlots, derivePaperStage, isStageAhead } from "./paper-stage.js";

const provided = (slot: AdminBotPaperSlot): AdminBotPaperSlotRecord => ({
  paper_id: "p1",
  slot,
  status: "provided",
  provided_at: "2026-09-01T09:00:00.000Z",
});

const waived = (slot: AdminBotPaperSlot): AdminBotPaperSlotRecord => ({
  paper_id: "p1",
  slot,
  status: "waived",
  waived_by_member_id: "zhijing",
  waived_reason: "Workshop paper, no poster",
});

/** Everything the trunk needs up to and including `step`, from the registry's own gates. */
function evidenceUpTo(step: string): AdminBotPaperSlotRecord[] {
  const out: AdminBotPaperSlotRecord[] = [];
  for (const [candidate, slots] of Object.entries(adminBotStepGatingSlots)) {
    out.push(...slots.map(provided));
    if (candidate === step) {
      break;
    }
  }
  return out;
}

describe("adminBotStepGatingSlots", () => {
  it("reads the registry's own gates rather than a second list", () => {
    expect(adminBotStepGatingSlots.submission).toEqual([
      "overleaf_edit",
      "papermentor_review",
      "fixes_merged",
      "pdf_ready",
    ]);
    expect(adminBotStepGatingSlots.arxiv_polish).toContain("pi_approval");
    // Advisory slots are out: a paper whose authors only circulated the edit link is not stuck.
    expect(adminBotStepGatingSlots.submission).not.toContain("overleaf_view");
    // Nothing evidences these two, so neither can move a paper.
    expect(adminBotStepGatingSlots.brainstorming_docs).toEqual([]);
    expect(adminBotStepGatingSlots.slide_making).toEqual([]);
  });
});

describe("derivePaperStage", () => {
  it("starts a paper with no evidence at the first step", () => {
    expect(derivePaperStage([])).toMatchObject({
      step: "brainstorming_docs",
      next: "overleaf_writing",
      blocking: ["project_folder"],
    });
  });

  it("moves a paper into the step its evidence released, and names what is next", () => {
    expect(derivePaperStage([provided("project_folder")])).toMatchObject({
      step: "overleaf_writing",
      next: "submission",
    });
    expect(derivePaperStage(evidenceUpTo("submission"))).toMatchObject({
      step: "submission",
      next: "google_drive_pdf",
      evidence: ["overleaf_edit", "papermentor_review", "fixes_merged", "pdf_ready"],
    });
  });

  it("stops at the first step whose evidence is incomplete", () => {
    const almost = evidenceUpTo("overleaf_writing").concat(
      provided("overleaf_edit"),
      provided("papermentor_review"),
      provided("fixes_merged"),
    );
    expect(derivePaperStage(almost)).toMatchObject({
      step: "overleaf_writing",
      next: "submission",
      blocking: ["pdf_ready"],
    });
  });

  // Branch work does not move the trunk. A poster uploaded in week one must not report a paper as
  // being at poster_making while it is still being written.
  it("does not let branch evidence jump the paper ahead of the trunk", () => {
    const early = [provided("project_folder"), provided("slides"), provided("poster")];
    expect(derivePaperStage(early).step).toBe("overleaf_writing");
  });

  it("counts a waived slot as settled, which is what waiving is for", () => {
    const withWaiver = evidenceUpTo("google_drive_pdf")
      .filter((row) => row.slot !== "submission_id")
      .concat(waived("submission_id"));
    expect(derivePaperStage(withWaiver).step).toBe("google_drive_pdf");
  });

  it("holds a paper at the PI's gate until the yes is given", () => {
    const prepared = evidenceUpTo("google_drive_pdf").concat(
      provided("drive_pdf_arxiv"),
      provided("authors_ack"),
      provided("arxiv_paper_password"),
    );
    expect(derivePaperStage(prepared)).toMatchObject({
      step: "google_drive_pdf",
      next: "arxiv_polish",
      blocking: ["pi_approval"],
    });
    expect(derivePaperStage(prepared.concat(provided("pi_approval"))).step).toBe("arxiv_polish");
  });
});

describe("isStageAhead", () => {
  it("is true only when the evidence has passed the stored step", () => {
    expect(isStageAhead("overleaf_writing", "submission")).toBe(true);
    expect(isStageAhead("submission", "submission")).toBe(false);
    // Never backwards: a paper an admin moved on by hand is not dragged back by missing evidence.
    expect(isStageAhead("arxiv_polish", "submission")).toBe(false);
  });

  it("treats a step it has never heard of as before everything", () => {
    expect(isStageAhead(undefined, "brainstorming_docs")).toBe(true);
    expect(isStageAhead("imported_from_a_spreadsheet", "overleaf_writing")).toBe(true);
  });
});
