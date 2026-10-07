import { describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import type { AdminBotPaperSlot, AdminBotPaperSlotRecord } from "../../contracts/paper-slots.js";
import { isProjectActive, summarizeProject } from "./my-projects.js";

const NOW = new Date("2026-10-07T12:00:00Z");

function paper(overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "Synthetic Paper",
    authors: ["Alice"],
    current_step: "overleaf_writing",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    ...overrides,
  } as AdminBotPaperRecord;
}

function provided(...slots: AdminBotPaperSlot[]): AdminBotPaperSlotRecord[] {
  return slots.map((slot) => ({ paper_id: "p1", slot, status: "provided" }));
}

describe("isProjectActive", () => {
  it("drops rejected, completed, and dormant papers", () => {
    expect(isProjectActive(paper(), NOW)).toBe(true);
    expect(isProjectActive(paper({ venue_decision: "reject" }), NOW)).toBe(false);
    expect(isProjectActive(paper({ artifacts: { completed_at: "2026-09-01" } }), NOW)).toBe(false);
    expect(isProjectActive(paper({ created_at: "2023-01-01T00:00:00Z" }), NOW)).toBe(false);
    expect(
      isProjectActive(paper({ created_at: "2023-01-01T00:00:00Z", dormant_override: true }), NOW),
    ).toBe(true);
  });
});

describe("summarizeProject", () => {
  it("counts a fresh paper's open work per lane, with only the unblocked items ready", () => {
    const summary = summarizeProject(paper(), [], []);
    expect(summary.lanes.core.open).toBeGreaterThan(0);
    // Only the project folder has nothing upstream of it.
    expect(summary.lanes.core.ready).toBe(1);
    expect(summary.todos[0]).toMatchObject({ id: "project_folder", lane: "core", ready: true });
    expect(summary.lanes.venue).toEqual({ open: 2, ready: 0 });
    expect(summary.provided_count).toBe(0);
  });

  it("clears a lane once its required slots are settled, and waits on the venue after submission", () => {
    const writing = provided(
      "project_folder",
      "overleaf_edit",
      "papermentor_review",
      "fixes_merged",
      "pdf_ready",
    );
    const summary = summarizeProject(
      paper(),
      [...writing, ...provided("submission", "submission_id")],
      [],
    );
    expect(summary.lanes.core).toEqual({ open: 0, ready: 0 });
    // Submitted, decision pending: the venue lane still has one thing open, and nobody can do it.
    expect(summary.lanes.venue).toEqual({ open: 1, ready: 0 });
    expect(summary.todos.find((todo) => todo.lane === "venue")?.id).toBe("venue_decision");
    // The PDF unblocks the archival lane's first step.
    expect(summary.todos.find((todo) => todo.id === "drive_pdf_arxiv")?.ready).toBe(true);
  });

  it("reads the pre-registered venue targets off the record", () => {
    const summary = summarizeProject(
      paper({
        artifacts: {
          venue_targets: JSON.stringify([
            { venue_id: "iclr2027", label: "ICLR 2027", confidence: 99 },
          ]),
        },
      }),
      [],
      [],
    );
    expect(summary.venue_targets).toEqual([
      { venue_id: "iclr2027", label: "ICLR 2027", confidence: 99 },
    ]);
  });
});
