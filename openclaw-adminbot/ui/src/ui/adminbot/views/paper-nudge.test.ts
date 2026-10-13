/* @vitest-environment jsdom */
// The lab-wide author nudge on Active Papers: preview first, send on a press, and nothing at all for
// anyone who may not chase the lab.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { PaperNudgeBatch, PaperSlotOverviewRow } from "../api/paper-admin.ts";
import { createEmptyAdminBotDashboardData } from "../controllers/admin.ts";
import { renderAdminBot, type AdminBotProps } from "./admin.ts";
import { renderPaperNudge, type PaperNudgeProps } from "./paper-nudge.ts";

function batch(fields: Partial<PaperNudgeBatch> = {}): PaperNudgeBatch {
  return {
    member_id: "ada",
    member_name: "Ada Lovelace",
    deliverable: true,
    item_count: 2,
    paper_titles: ["Causal abstraction"],
    message: "*Causal abstraction* still needs:\n• Talk slides",
    ...fields,
  };
}

function row(overrides: Partial<PaperSlotOverviewRow> = {}): PaperSlotOverviewRow {
  return {
    paper_id: "p1",
    title: "Causal abstraction",
    current_step: "overleaf_writing",
    provided_count: 3,
    required_count: 21,
    dormant: false,
    closed: false,
    missing_slots: ["overleaf"],
    escalating: false,
    ...overrides,
  };
}

function draw(overrides: Partial<PaperNudgeProps> = {}) {
  const calls = { reviews: 0, sends: 0, picked: [] as string[] };
  const props: PaperNudgeProps = {
    overview: [row()],
    canNudge: true,
    nudgeBatches: null,
    nudgeLoading: false,
    nudgeSelected: [],
    nudging: false,
    notice: null,
    onReviewNudges: () => {
      calls.reviews += 1;
    },
    onToggleNudgeRecipient: (id) => calls.picked.push(id),
    onNudgeAuthors: () => {
      calls.sends += 1;
    },
    ...overrides,
  };
  const container = document.createElement("div");
  // In the document: a detached checkbox's click fires no change event.
  document.body.replaceChildren(container);
  render(renderPaperNudge(props), container);
  return { container, calls };
}

describe("renderPaperNudge", () => {
  it("counts only live papers with something outstanding on the review button", () => {
    const { container, calls } = draw({
      overview: [row(), row({ paper_id: "p2", dormant: true })],
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="my-work-review-nudges"]',
    );
    expect(button?.textContent).toContain("1");
    button?.click();
    // Opening the preview sends nothing -- that is the whole point of the manual flow.
    expect(calls).toMatchObject({ reviews: 1, sends: 0 });
  });

  it("sends nothing until the preview is open and Send is pressed", () => {
    expect(draw().container.querySelector('[data-testid="my-work-nudge-authors"]')).toBeNull();
    const open = draw({ nudgeBatches: [batch()], nudgeSelected: ["ada"] });
    open.container
      .querySelector<HTMLButtonElement>('[data-testid="my-work-nudge-authors"]')!
      .click();
    expect(open.calls.sends).toBe(1);
  });

  it("shows the message verbatim, so somebody reads what goes out under their name", () => {
    const { container } = draw({ nudgeBatches: [batch()], nudgeSelected: ["ada"] });
    expect(container.querySelector(".nudge-preview__message")?.textContent).toContain(
      "• Talk slides",
    );
  });

  it("shows an unreachable person, unticked and unticking", () => {
    const { container } = draw({
      nudgeBatches: [batch({ member_id: "bob", member_name: "Bob", deliverable: false })],
    });
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="nudge-pick-bob"]')?.disabled,
    ).toBe(true);
    expect(container.textContent).toContain("No Slack account on file");
  });

  it("will not send with nobody ticked, and lets an admin drop one person", () => {
    const none = draw({ nudgeBatches: [batch()], nudgeSelected: [] });
    expect(
      none.container.querySelector<HTMLButtonElement>('[data-testid="my-work-nudge-authors"]')
        ?.disabled,
    ).toBe(true);
    const some = draw({ nudgeBatches: [batch()], nudgeSelected: ["ada"] });
    some.container.querySelector<HTMLInputElement>('[data-testid="nudge-pick-ada"]')!.click();
    expect(some.calls.picked).toEqual(["ada"]);
  });

  it("disables the review button rather than hiding it when the lab is caught up", () => {
    const { container } = draw({ overview: [row({ missing_slots: [] })] });
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="my-work-review-nudges"]')?.disabled,
    ).toBe(true);
  });

  it("says what the last run did", () => {
    const { container } = draw({ notice: "Nudged 2 authors." });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Nudged 2");
  });

  it("draws nothing, preview included, for anyone who may not chase the lab", () => {
    const { container } = draw({ canNudge: false, nudgeBatches: [batch()] });
    expect(container.querySelector('[data-testid="paper-nudge"]')).toBeNull();
    expect(container.querySelector('[data-testid="my-work-nudge-preview"]')).toBeNull();
  });
});

describe("the nudge on Active Papers", () => {
  function papersPanel(overrides: Partial<AdminBotProps>) {
    const container = document.createElement("div");
    render(
      renderAdminBot({
        panel: "papers",
        connected: true,
        loading: false,
        error: null,
        data: {
          ...createEmptyAdminBotDashboardData(),
          loadedAt: 1,
          papers: [
            {
              id: "p1",
              title: "Causal abstraction",
              authors: ["Ada Lovelace"],
              current_step: "overleaf_writing",
              created_at: "2026-06-01T00:00:00.000Z",
              updated_at: "2026-06-01T00:00:00.000Z",
            },
          ],
        },
        onSavePaper: () => {},
        onRefresh: () => {},
        ...overrides,
      } as unknown as AdminBotProps),
      container,
    );
    return container;
  }
  const nudge = (over: Partial<PaperNudgeProps> = {}): PaperNudgeProps => ({
    overview: [row()],
    canNudge: true,
    nudgeBatches: null,
    nudgeLoading: false,
    nudgeSelected: [],
    nudging: false,
    notice: null,
    onReviewNudges: () => {},
    onToggleNudgeRecipient: () => {},
    onNudgeAuthors: () => {},
    ...over,
  });

  it("is a board under the table for an administrator", () => {
    const container = papersPanel({ mode: "admin", paperNudge: nudge() });
    expect(container.querySelector('[data-testid="paper-nudge"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="my-work-review-nudges"]')).not.toBeNull();
  });

  it("opens its board while the preview is up, so the messages are not folded away", () => {
    const container = papersPanel({
      mode: "admin",
      paperNudge: nudge({ nudgeBatches: [batch()], nudgeSelected: ["ada"] }),
    });
    const board = container.querySelector('[data-testid="paper-nudge"]')?.closest("details");
    expect(board?.open).toBe(true);
  });

  it("is absent when the surface hands over no nudge, as it does outside admin mode", () => {
    const container = papersPanel({ mode: "admin" });
    expect(container.querySelector('[data-testid="paper-nudge"]')).toBeNull();
  });

  it("is absent on the members' read-only view even if one is handed over", () => {
    const container = papersPanel({
      mode: "general",
      signedInMemberId: "ada",
      paperNudge: nudge(),
    });
    expect(container.querySelector('[data-testid="paper-nudge"]')).toBeNull();
    expect(container.querySelector('[data-testid="my-work-review-nudges"]')).toBeNull();
  });
});
