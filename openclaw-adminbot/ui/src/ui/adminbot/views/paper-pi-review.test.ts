/* @vitest-environment jsdom */
// The head professor's focused review, opened from the professor desk's review queue.
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import { renderPaperPiReviewDialog, type PaperPiReviewProps } from "./paper-pi-review.ts";

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

function props(overrides: Partial<PaperPiReviewProps> = {}): PaperPiReviewProps {
  return {
    slots: {},
    slotsBusyId: null,
    slotsError: null,
    onSaveSlot: vi.fn(),
    ...overrides,
  };
}

const feedbackRequest = (paperId?: string) =>
  ({
    [paper.id]: {
      slots: [
        {
          ...(paperId ? { paper_id: paperId } : {}),
          slot: "feedback_arxiv",
          status: "provided",
          value_text: JSON.stringify({
            reason: "Ready for arXiv?",
            url: "https://overleaf.com/project/test",
          }),
        },
      ],
    },
  }) as never;

describe("focused PI paper review", () => {
  it("saves feedback separately from publication approval", () => {
    const onSaveSlot = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderPaperPiReviewDialog({
        paper,
        onClose: vi.fn(),
        props: props({ onSaveSlot, slots: feedbackRequest(paper.id) }),
      }),
      container,
    );
    expect(container.querySelector('[data-testid="paper-pi-review"]')).not.toBeNull();
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
    const reviewProps = props({ slots: feedbackRequest() });
    const drawReview = () =>
      render(renderPaperPiReviewDialog({ props: reviewProps, paper, onClose: vi.fn() }), container);
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

  it("reports a close from the dialog's close button", () => {
    const onClose = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    render(renderPaperPiReviewDialog({ props: props(), paper, onClose }), container);
    (container.querySelector('[data-testid="paper-card-dialog-close"]') as HTMLElement).click();
    expect(onClose).toHaveBeenCalled();
  });
});
