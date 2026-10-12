/* @vitest-environment jsdom */
// The head professor's review of one paper, opened from My Desk's PI review queue or an Active
// Papers row: a review, not the authors' checklist.
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperCycle } from "../api/papers.ts";
import { makeProps, paper } from "./projects.test-helpers.ts";
import { renderPaperReviewDialog } from "./review-dialog.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

const reviewed = paper({ id: "p-1", title: "Meta agents for reliable science" });

function feedbackCycle(): Record<string, PaperCycle> {
  return {
    [reviewed.id]: {
      slots: [
        {
          paper_id: reviewed.id,
          slot: "feedback_arxiv",
          status: "provided",
          value_text: JSON.stringify({
            reason: "Ready for arXiv?",
            url: "https://overleaf.com/project/test",
          }),
        },
      ],
    } as never,
  };
}

function draw(overrides: Partial<ReturnType<typeof makeProps>["props"]> = {}, onClose = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  const { props } = makeProps();
  Object.assign(props, overrides);
  const redraw = () =>
    render(renderPaperReviewDialog({ paper: reviewed, props, onClose }), container);
  redraw();
  return { container, onClose, props, redraw };
}

describe("renderPaperReviewDialog", () => {
  it("opens as a review of the paper, not the authors' checklist", () => {
    const { container } = draw({ slots: feedbackCycle() });
    const dialog = container.querySelector<HTMLDialogElement>('[data-testid="paper-card-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('[data-testid="paper-pi-review"]')).not.toBeNull();
    expect(dialog?.querySelector('[data-testid="paper-slots-p-1"]')).toBeNull();
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

  it("saves feedback separately from publication approval", () => {
    const onSaveSlot = vi.fn();
    const { container } = draw({ onSaveSlot, slots: feedbackCycle() });
    const textarea = container.querySelector("textarea")!;
    textarea.value = "Clarify Figure 2.";
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const [id, slot, input] = onSaveSlot.mock.calls[0];
    expect([id, slot]).toEqual([reviewed.id, "feedback_arxiv"]);
    expect(JSON.parse(input.value_text)).toMatchObject({
      reviewed: true,
      review_note: "Clarify Figure 2.",
    });
    expect(onSaveSlot).not.toHaveBeenCalledWith(reviewed.id, "pi_approval", expect.anything());
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Approve publication"))!
      .click();
    expect(onSaveSlot).toHaveBeenCalledWith(reviewed.id, "pi_approval", { done: true });
  });

  it("keeps a typed review after a failed save and offers retry when loading fails", () => {
    const { container, props, redraw } = draw({ slots: feedbackCycle() });
    container.querySelector("textarea")!.value = "Keep my feedback";
    props.slotsError = "Save failed";
    redraw();
    expect(container.querySelector("textarea")!.value).toBe("Keep my feedback");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Save failed");
    props.slots = {};
    props.onLoadSlots = vi.fn();
    redraw();
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Retry")!
      .click();
    expect(props.onLoadSlots).toHaveBeenCalledWith(reviewed.id);
  });
});
