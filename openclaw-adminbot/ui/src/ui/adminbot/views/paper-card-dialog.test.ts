/* @vitest-environment jsdom */
// The paper card Active Papers opens from a row, in place of the deck it used to stack under it.
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import { renderPaperCardDialog, type MyWorkProps } from "./my-work.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

const paper = {
  id: "p-1",
  title: "Meta agents for reliable science",
  authors: ["Mira Member"],
  current_step: "overleaf_writing",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as AdminBotPaperRecord;

function props(overrides: Partial<MyWorkProps> = {}): MyWorkProps {
  return {
    onSavePaper: vi.fn(),
    overview: [],
    slots: {},
    // Deliberately empty: the dialog must open the card regardless, because it was opened to read
    // this paper and asking for a second click is asking the same question twice.
    openIds: [],
    slotsBusyId: null,
    slotsError: null,
    slotsNotice: null,
    nudging: false,
    canNudge: true,
    nudgeBatches: null,
    nudgeLoading: false,
    nudgeSelected: [],
    onReviewNudges: vi.fn(),
    onToggleNudgeRecipient: vi.fn(),
    onToggleCard: vi.fn(),
    onSaveSlot: vi.fn(),
    onNudgeAuthors: vi.fn(),
    ...overrides,
  } as unknown as MyWorkProps;
}

function state(): AppViewState {
  return {
    adminBotData: { members: [], papers: [paper] },
    myWorkBlockerDraft: null,
    myWorkCoauthorDraft: {},
    adminBotPaperSlotsOpen: [],
  } as unknown as AppViewState;
}

function draw(onClose = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderPaperCardDialog({ state: state(), props: props(), paper, onClose }), container);
  return { container, onClose };
}

describe("renderPaperCardDialog", () => {
  it("opens the card expanded, rather than as a closed row in a dialog", () => {
    const { container } = draw();
    const dialog = container.querySelector<HTMLDialogElement>('[data-testid="paper-card-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('[data-testid="my-work-item-p-1"]')).not.toBeNull();
    expect(
      dialog?.querySelector('[data-testid="my-work-toggle-p-1"]')?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("names the paper it is about", () => {
    const { container } = draw();
    expect(container.querySelector(".paper-card-dialog__header")?.textContent).toContain(
      "Meta agents for reliable science",
    );
  });

  it("hands the close back so the host can forget which paper was open", () => {
    const { container, onClose } = draw();
    container.querySelector<HTMLButtonElement>('[data-testid="paper-card-dialog-close"]')?.click();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("focused PI paper review", () => {
  it("saves feedback separately from publication approval", () => {
    const onSaveSlot = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderPaperCardDialog({
        state: state(),
        paper,
        reviewOnly: true,
        onClose: vi.fn(),
        props: props({
          onSaveSlot,
          slots: {
            [paper.id]: {
              slots: [
                {
                  paper_id: paper.id,
                  slot: "feedback_arxiv",
                  status: "provided",
                  value_text: JSON.stringify({
                    reason: "Ready for arXiv?",
                    url: "https://overleaf.com/project/test",
                  }),
                },
              ],
            },
          } as never,
        }),
      }),
      container,
    );
    expect(container.querySelector('[data-testid="paper-pi-review"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="my-work-item-p-1"]')).toBeNull();
    const textarea = container.querySelector("textarea")!;
    textarea.value = "Clarify Figure 2.";
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const [id, slot, input] = onSaveSlot.mock.calls[0];
    expect([id, slot]).toEqual([paper.id, "feedback_arxiv"]);
    expect(JSON.parse(input.value_text)).toMatchObject({
      reviewed: true,
      review_note: "Clarify Figure 2.",
    });
    expect(onSaveSlot).not.toHaveBeenCalledWith(paper.id, "pi_approval", expect.anything());
    const approve = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Approve publication"),
    )!;
    approve.click();
    expect(onSaveSlot).toHaveBeenCalledWith(paper.id, "pi_approval", { done: true });
  });
  it("keeps a typed review after a failed save and offers retry when loading fails", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const reviewProps = props({
      slots: {
        [paper.id]: {
          slots: [
            {
              slot: "feedback_arxiv",
              status: "provided",
              value_text: JSON.stringify({
                reason: "Review this draft",
                url: "https://overleaf.com/project/test",
              }),
            },
          ],
        },
      } as never,
    });
    const drawReview = () =>
      render(
        renderPaperCardDialog({
          state: state(),
          props: reviewProps,
          paper,
          reviewOnly: true,
          onClose: vi.fn(),
        }),
        container,
      );
    drawReview();
    container.querySelector("textarea")!.value = "Keep my feedback";
    reviewProps.slotsError = "Save failed";
    drawReview();
    expect(container.querySelector("textarea")!.value).toBe("Keep my feedback");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Save failed");
    reviewProps.slots = {};
    reviewProps.onLoadSlots = vi.fn();
    drawReview();
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Retry")!
      .click();
    expect(reviewProps.onLoadSlots).toHaveBeenCalledWith(paper.id);
  });
});
