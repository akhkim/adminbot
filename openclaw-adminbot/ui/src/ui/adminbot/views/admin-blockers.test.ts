/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import {
  type AdminBotPaperRecord,
  type AdminBotPaperSaveInput,
  createEmptyAdminBotDashboardData,
} from "../controllers/admin.ts";
import { renderAdminBot, type AdminBotProps, type BlockerSort } from "./admin.ts";
import { blockerOf } from "./my-work.ts";

function paper(overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "Causal Abstraction",
    authors: ["Pat Doe"],
    current_step: "brainstorm",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    ...overrides,
  } as AdminBotPaperRecord;
}

const papers: AdminBotPaperRecord[] = [
  paper({
    id: "late",
    title: "Zebra Effects",
    current_step: "submission",
    artifacts: {
      blocker_stage: "submission",
      blocker_title: "OpenReview rejects the PDF font subset",
      blocker_note: "Type 3 fonts are not allowed. Re-exported from Overleaf twice.",
      blocker_at: "2026-08-01T00:00:00Z",
    },
  }),
  paper({
    id: "early",
    title: "Alpha Priors",
    current_step: "brainstorm",
    artifacts: {
      blocker_stage: "brainstorm",
      blocker_title: "Waiting on compute quota",
      blocker_note: "Aurora queue is full until next week.",
      blocker_at: "2026-08-14T00:00:00Z",
    },
  }),
  paper({ id: "clear", title: "No Problems Here" }),
];

function props(overrides: Partial<AdminBotProps> = {}): AdminBotProps {
  return {
    panel: "papers",
    mode: "admin",
    connected: true,
    loading: false,
    error: null,
    data: { ...createEmptyAdminBotDashboardData(), papers, loadedAt: Date.now() },
    busyActionId: null,
    notice: null,
    onRefresh: () => undefined,
    onApprove: () => undefined,
    onRemove: () => undefined,
    onExecute: () => undefined,
    onSaveMember: () => undefined,
    onSaveOwnProfile: () => undefined,
    onSavePaper: () => undefined,
    onDeletePaper: () => undefined,
    onSaveSettings: () => undefined,
    onSaveSensitiveInfo: () => undefined,
    ...overrides,
  } as AdminBotProps;
}

function draw(overrides: Partial<AdminBotProps> = {}): HTMLElement {
  const host = document.createElement("div");
  render(renderAdminBot(props(overrides)), host);
  return host;
}

function titles(host: HTMLElement): string[] {
  return [...host.querySelectorAll(".blocker__title")].map((node) => node.textContent?.trim() ?? "");
}

describe("reported blockers", () => {
  it("lists only papers that have one", () => {
    expect(titles(draw())).toHaveLength(2);
  });

  it("sorts by pipeline stage, not by insertion order", () => {
    // Brainstorm precedes submission in paperSteps, so Alpha Priors leads regardless of input order.
    expect(titles(draw({ blockerSort: "stage" }))[0]).toBe("Waiting on compute quota");
  });

  it("sorts oldest first by age", () => {
    expect(titles(draw({ blockerSort: "age" }))[0]).toBe("OpenReview rejects the PDF font subset");
  });

  it("sorts by paper title", () => {
    expect(titles(draw({ blockerSort: "paper" }))[0]).toBe("Waiting on compute quota");
  });

  it("keeps the full report behind the summary", () => {
    const host = draw();
    const details = host.querySelector<HTMLDetailsElement>(".blocker");
    expect(details?.open).toBe(false);
    expect(host.querySelector(".blocker__note")?.textContent).toContain("Aurora queue is full");
  });

  it("reports every sort key the buttons offer", () => {
    const seen: BlockerSort[] = [];
    const host = draw({ onBlockerSort: (key) => seen.push(key) });
    for (const button of host.querySelectorAll<HTMLButtonElement>("[data-testid^=blocker-sort-]")) {
      button.click();
    }
    expect(seen).toEqual(["stage", "age", "paper"]);
  });

  it("treats a cleared title as resolved, which is what the Resolved button writes", () => {
    const cleared: AdminBotPaperSaveInput = {
      id: "late",
      title: "Zebra Effects",
      authors: [],
      currentStep: "submission",
      blockerStage: "",
      blockerTitle: "",
      blockerNote: "",
      blockerAt: "",
    };
    expect(cleared.blockerTitle).toBe("");
    expect(blockerOf(paper({ artifacts: { blocker_title: "  " } }))).toBeUndefined();
  });
});
