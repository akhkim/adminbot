// A paper moving itself along on its own evidence, and arriving at the one gate AdminBot will not
// open for it.
import { describe, expect, it } from "vitest";
import { ADMINBOT_LAB_OVERLEAF_HOST } from "../contracts/overleaf.js";
import type { AdminBotPaperSlot } from "../contracts/paper-slots.js";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const LINKS: Partial<Record<AdminBotPaperSlot, string>> = {
  project_folder: "https://docs.google.com/document/d/brainstorm",
  overleaf_edit: `https://${ADMINBOT_LAB_OVERLEAF_HOST}/project/65f2a1c9d4e3b7a801f6`,
  submission: "https://openreview.net/forum?id=Ax7Kq2Lm9P",
  drive_pdf_arxiv: "https://drive.google.com/file/d/1PdF9x",
};

function lab() {
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
      id: "zhijing",
      name: "Zhijing Jin",
      privilege_level: "admin",
    } as never),
  );
  unwrap(service.updateSettings({ head_professor_member_id: "zhijing" } as never));
  unwrap(
    service.upsertPaper({
      id: "p1",
      title: "Causal Garden Planning",
      authors: ["Ada Lovelace"],
      current_step: "brainstorming_docs",
      first_author_member_id: "ada",
      venue: "ICLR 2027",
    }),
  );
  return service;
}

/** Provide one slot the way the card does. */
function give(service: AdminBotService, slot: AdminBotPaperSlot, value?: string) {
  const url = value ?? LINKS[slot];
  unwrap(
    service.setPaperSlot({
      paperId: "p1",
      slot,
      input: url ? { url } : { done: true },
      memberId: "ada",
      privileged: true,
    }),
  );
}

const stepOf = (service: AdminBotService) =>
  unwrap(service.listPapers()).papers.find((paper) => paper.id === "p1")?.current_step;

const notices = (service: AdminBotService, memberId: string) =>
  unwrap(service.listMemberNotifications(memberId)).notifications;

describe("advancing a paper on its own evidence", () => {
  it("moves it as each step's evidence lands, without waiting for the hourly pass", () => {
    const service = lab();
    expect(stepOf(service)).toBe("brainstorming_docs");

    give(service, "project_folder");
    expect(stepOf(service)).toBe("overleaf_writing");

    give(service, "overleaf_edit");
    give(service, "papermentor_review");
    give(service, "fixes_merged");
    // Three of the four: still writing.
    expect(stepOf(service)).toBe("overleaf_writing");

    give(service, "pdf_ready");
    expect(stepOf(service)).toBe("submission");
  });

  it("records the evidence that released the step, not just the step", () => {
    const service = lab();
    for (const slot of [
      "project_folder",
      "overleaf_edit",
      "papermentor_review",
      "fixes_merged",
      "pdf_ready",
    ] as const) {
      give(service, slot);
    }

    const advance = service
      .listAuditEvents()
      .findLast((event) => event.type === "paper.stage_advanced");
    expect(advance?.details).toMatchObject({
      paper_id: "p1",
      from: "overleaf_writing",
      to: "submission",
      evidence: ["overleaf_edit", "papermentor_review", "fixes_merged", "pdf_ready"],
      next: "google_drive_pdf",
    });
  });

  it("never walks a paper backwards, however thin its evidence is", () => {
    const service = lab();
    unwrap(
      service.upsertPaper({
        id: "p1",
        title: "Causal Garden Planning",
        authors: ["Ada Lovelace"],
        current_step: "arxiv_polish",
        first_author_member_id: "ada",
      }),
    );

    give(service, "project_folder");
    unwrap(service.syncPaperStages("cron"));

    expect(stepOf(service)).toBe("arxiv_polish");
  });

  it("advances on a PaperMentor run, which is evidence with no member behind it", () => {
    const service = lab();
    give(service, "project_folder");
    give(service, "overleaf_edit");
    give(service, "fixes_merged");
    give(service, "pdf_ready");
    expect(stepOf(service)).toBe("overleaf_writing");

    unwrap(
      service.recordPaperMentorRun("cron", {
        project_id: "65f2a1c9d4e3b7a801f6",
        reviewed_at: "2026-09-12T11:04:09.221Z",
        comments_total: 2,
        by_severity: { warning: 2 },
        by_category: { results: 2 },
        by_document: [],
        failed_agents: [],
      }),
    );

    expect(stepOf(service)).toBe("submission");
  });

  it("is idempotent: a second pass over the same evidence advances nothing", () => {
    const service = lab();
    give(service, "project_folder");

    const again = unwrap(service.syncPaperStages("cron"));
    expect(again.advanced).toEqual([]);
  });
});

describe("signing a paper up for the PI's decision", () => {
  /** Everything up to the prepared arXiv package, which is where the gate is. */
  function prepare(service: AdminBotService) {
    for (const slot of [
      "project_folder",
      "overleaf_edit",
      "papermentor_review",
      "fixes_merged",
      "pdf_ready",
      "submission",
    ] as const) {
      give(service, slot);
    }
    unwrap(
      service.setPaperSlot({
        paperId: "p1",
        slot: "submission_id",
        input: { value_text: "Ax7Kq2Lm9P" },
        memberId: "ada",
        privileged: true,
      }),
    );
    give(service, "drive_pdf_arxiv");
    give(service, "authors_ack");
  }

  it("puts the paper in her queue the moment the package is prepared", () => {
    const service = lab();
    expect(unwrap(service.listPiReviewQueue()).papers).toEqual([]);

    prepare(service);

    const { papers } = unwrap(service.listPiReviewQueue());
    expect(papers).toHaveLength(1);
    expect(papers[0]).toMatchObject({
      paper_id: "p1",
      title: "Causal Garden Planning",
      package_complete: false,
      drive_pdf_url: LINKS.drive_pdf_arxiv,
    });
  });

  it("tells her once, on her own page, and never through the nudge pipeline", () => {
    const service = lab();
    prepare(service);

    const told = notices(service, "zhijing");
    expect(told).toHaveLength(1);
    expect(told[0]?.title).toBe("A paper is ready for your yes");
    expect(told[0]?.tab).toBe("adminbotProfessor");
    expect(told[0]?.body).toContain("Causal Garden Planning");

    // Every later pass finds the same prepared package and says nothing more about it.
    unwrap(service.syncPaperStages("cron"));
    unwrap(service.syncPaperStages("cron"));
    expect(notices(service, "zhijing")).toHaveLength(1);
  });

  it("approves nothing: the slot is still open and the paper still waits", () => {
    const service = lab();
    prepare(service);
    unwrap(service.syncPaperStages("cron"));

    const slot = unwrap(service.listPaperSlots("p1")).slots.find(
      (row) => row.slot === "pi_approval",
    );
    expect(slot?.status).toBe("missing");
    expect(stepOf(service)).toBe("google_drive_pdf");
  });

  it("leaves the queue the moment she says yes", () => {
    const service = lab();
    prepare(service);
    unwrap(
      service.setPaperSlot({
        paperId: "p1",
        slot: "pi_approval",
        input: { done: true },
        memberId: "zhijing",
        privileged: true,
      }),
    );

    expect(unwrap(service.listPiReviewQueue()).papers).toEqual([]);
  });

  it("says nothing to a deployment that has named no head professor", () => {
    const service = lab();
    unwrap(service.updateSettings({ head_professor_member_id: "" } as never));
    prepare(service);

    const result = unwrap(service.syncPaperStages("cron"));
    expect(result.waiting_on_pi).toBe(1);
    expect(result.pi_review_requested).toEqual([]);
    expect(notices(service, "zhijing")).toEqual([]);
  });
});
