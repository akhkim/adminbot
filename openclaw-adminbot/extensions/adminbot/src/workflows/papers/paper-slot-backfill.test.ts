// The migration that decides what the lab's 114 existing papers look like on day one.
//
// Worth testing carefully because it is the one pass that writes evidence nobody typed, and
// because getting it wrong is not a quiet bug: too little and the first sweep chases eighty
// authors about published papers, too much and it marks work done that nobody did.
import { describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import type { AdminBotPaperSlotRecord } from "../../contracts/paper-slots.js";
import {
  arxivPublicationDate,
  BACKFILL_SETTLED_REASON,
  BACKFILL_WAIVER_REASON,
  planPaperBackfill,
} from "./paper-slot-backfill.js";

const NOW = new Date("2026-08-20T12:00:00.000Z");

function paper(overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "Causal abstraction",
    authors: ["Ada Lovelace"],
    current_step: "overleaf_writing",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function plan(p: AdminBotPaperRecord, existing: AdminBotPaperSlotRecord[] = []) {
  const result = planPaperBackfill({ paper: p, existing, now: NOW });
  return {
    ...result,
    bySlot: new Map(result.slots.map((row) => [row.slot, row])),
  };
}

describe("arxivPublicationDate", () => {
  it("reads the real publication month off the identifier", () => {
    // The record's own timestamps cannot answer this -- every paper in the database was written by
    // one import run and carries that date, not the date the work happened.
    expect(arxivPublicationDate("https://arxiv.org/abs/2505.19212")?.toISOString()).toBe(
      "2025-05-01T00:00:00.000Z",
    );
    expect(arxivPublicationDate("http://arxiv.org/abs/2602.12316")?.toISOString()).toBe(
      "2026-02-01T00:00:00.000Z",
    );
  });

  it("gives up rather than guessing", () => {
    expect(arxivPublicationDate("https://arxiv.org/abs/quant-ph/9901001")).toBeUndefined();
    expect(arxivPublicationDate("https://example.com/paper")).toBeUndefined();
    expect(arxivPublicationDate("https://arxiv.org/abs/2599.00001")).toBeUndefined();
  });
});

describe("pass 1: artifacts become slots", () => {
  it("copies each stored link into the slot it obviously is", () => {
    const { bySlot } = plan(
      paper({
        artifacts: {
          overleaf_edit_url: "https://www.overleaf.com/project/1",
          submission_url: "https://openreview.net/forum?id=x",
          google_slides_url: "https://docs.google.com/presentation/d/1",
        },
      }),
    );
    expect(bySlot.get("overleaf_edit")).toMatchObject({ status: "provided" });
    expect(bySlot.get("submission")).toMatchObject({ status: "provided" });
    expect(bySlot.get("slides")).toMatchObject({ status: "provided" });
  });

  it("takes the one Drive PDF as the arXiv copy, now that there is only one", () => {
    const { bySlot } = plan(
      paper({ artifacts: { google_drive_pdf_url: "https://drive.google.com/file/d/1" } }),
    );
    expect(bySlot.get("drive_pdf_arxiv")).toMatchObject({ status: "provided" });
  });

  it("keeps a historical link even though it would fail today's shape rules", () => {
    // Marking a three-year-old URL invalid would put a red field on a finished paper and chase its
    // author to fix a link nobody needs any more.
    const { bySlot } = plan(paper({ artifacts: { arxiv_url: "http://arxiv.org/abs/2505.19212" } }));
    expect(bySlot.get("arxiv")).toMatchObject({
      status: "provided",
      url: "http://arxiv.org/abs/2505.19212",
    });
  });

  it("does not invent a social draft from a bare draft URL", () => {
    // The X gate reads the drafts table, and a URL is not a draft body -- there would be nothing
    // for a coauthor to consent to.
    const { bySlot } = plan(paper({ artifacts: { twitter_draft_url: "https://x.com/i/1" } }));
    expect(bySlot.has("x_draft")).toBe(false);
  });

  it("reads the reviewer checklist, which has no artifact of its own", () => {
    const { bySlot } = plan(paper({ checks: { paper_mentor_checked: true } }));
    expect(bySlot.get("papermentor_review")).toMatchObject({ status: "provided" });
  });
});

describe("pass 2: ancestors are grandfathered", () => {
  it("waives what a provided artifact proves must have happened", () => {
    const { bySlot } = plan(
      paper({ artifacts: { submission_url: "https://openreview.net/forum?id=x" } }),
    );
    // A submitted paper went through the draft and compiled a PDF, whatever the lab wrote down.
    for (const slot of ["project_folder", "overleaf_edit", "pdf_ready"] as const) {
      expect(bySlot.get(slot)).toMatchObject({
        status: "waived",
        waived_reason: BACKFILL_WAIVER_REASON,
      });
    }
  });

  it("marks them waived rather than provided, because nobody supplied them", () => {
    const { bySlot } = plan(
      paper({ artifacts: { submission_url: "https://openreview.net/forum?id=x" } }),
    );
    expect(bySlot.get("project_folder")?.status).not.toBe("provided");
  });
});

describe("pass 3: finished papers are closed out", () => {
  it("closes a paper that reached arXiv long ago", () => {
    const { settled, bySlot } = plan(
      paper({ artifacts: { arxiv_url: "https://arxiv.org/abs/2401.00001" } }),
    );
    expect(settled).toBe(true);
    // Without this the restored arXiv link opens the social branch and the author of a paper from
    // two years ago is asked to draft an X post.
    expect(bySlot.get("x_draft")).toMatchObject({
      status: "waived",
      waived_reason: BACKFILL_SETTLED_REASON,
    });
    expect(bySlot.get("arxiv_paper_password")?.status).toBe("waived");
  });

  it("leaves a recently published paper open, because its social window is live", () => {
    const { settled, bySlot } = plan(
      paper({ artifacts: { arxiv_url: "https://arxiv.org/abs/2608.00001" } }),
    );
    expect(settled).toBe(false);
    expect(bySlot.has("x_draft")).toBe(false);
  });

  it("never closes a paper that was never published", () => {
    const { settled } = plan(
      paper({ artifacts: { overleaf_edit_url: "https://www.overleaf.com/project/1" } }),
    );
    expect(settled).toBe(false);
  });

  it("leaves the advisory slots alone -- they were never going to be chased", () => {
    const { bySlot } = plan(
      paper({ artifacts: { arxiv_url: "https://arxiv.org/abs/2401.00001" } }),
    );
    expect(bySlot.has("poster_physical")).toBe(false);
    expect(bySlot.has("backend_sheet")).toBe(false);
  });
});

describe("pass 4, and the rules that apply to all of them", () => {
  it("lifts the stored conference into the venue column", () => {
    expect(plan(paper({ artifacts: { conference: "ACL" } })).venue).toBe("ACL");
  });

  it("does not overwrite a venue somebody already set", () => {
    expect(
      plan(paper({ venue: "ICLR 2027", artifacts: { conference: "ACL" } })).venue,
    ).toBeUndefined();
  });

  it("never touches a slot that already has a row", () => {
    const answered: AdminBotPaperSlotRecord = {
      paper_id: "p1",
      slot: "project_folder",
      status: "provided",
      url: "https://docs.google.com/document/d/typed-by-a-human",
    };
    const { bySlot } = plan(
      paper({ artifacts: { submission_url: "https://openreview.net/forum?id=x" } }),
      [answered],
    );
    expect(bySlot.has("project_folder")).toBe(false);
  });

  it("plans nothing at all for a paper with no artifacts", () => {
    const result = plan(paper());
    expect(result.slots).toEqual([]);
    expect(result.venue).toBeUndefined();
  });
});
