// The impact statement card and the PI's review card on synthetic papers: what each says is owed,
// and what each sends back.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { PaperSlotRow } from "../api/papers.ts";
import { readPaperImpact, renderPaperImpact, renderPaperImpactReview } from "./paper-impact.ts";

const written = {
  risk: "Models comply with disguised harmful requests.",
  intervention: "A refusal probe catches the disguise.",
  users: "Deployment teams gate releases on it.",
};

function slotRows(value?: object): PaperSlotRow[] {
  return value
    ? [{ slot: "impact_statement", value_text: JSON.stringify(value) } as PaperSlotRow]
    : [];
}

function drawAuthor(title: string, value?: object) {
  const saved: Array<{ slot: string; input: { value_text?: string } }> = [];
  const container = document.createElement("div");
  render(
    renderPaperImpact({
      paper: { title },
      slots: slotRows(value),
      loading: false,
      onSaveSlot: (slot, input) => saved.push({ slot, input }),
    }),
    container,
  );
  return { container, saved };
}

describe("renderPaperImpact", () => {
  it("opens and says required when a safety paper has no statement, and shows why", () => {
    const { container } = drawAuthor("Jailbreak probes for chat models");
    expect(container.querySelector("details")?.open).toBe(true);
    expect(container.querySelector('[data-testid="paper-impact-state"]')?.textContent).toBe(
      "Required — missing",
    );
    expect(container.querySelector('[data-testid="paper-impact-verdict"]')?.textContent).toContain(
      "jailbreak",
    );
  });

  it("names the answers a draft still needs", () => {
    const { container } = drawAuthor("Jailbreak probes for chat models", { risk: "x" });
    const missing = container.querySelector('[data-testid="paper-impact-missing"]')?.textContent;
    expect(missing).toContain("How does the work reduce that risk?");
    expect(missing).not.toContain("concrete risk");
  });

  it("stays closed and optional for an unrelated paper", () => {
    const { container } = drawAuthor("Faster sparse attention kernels");
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelector('[data-testid="paper-impact-state"]')?.textContent).toBe(
      "Optional",
    );
  });

  it("sends only the prompt answers, never a review or a correction", () => {
    const { container, saved } = drawAuthor("Jailbreak probes for chat models", {
      ...written,
      reviewed: true,
    });
    container.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(saved).toHaveLength(1);
    const sent = JSON.parse(saved[0]?.input.value_text ?? "{}");
    expect(Object.keys(sent).toSorted()).toEqual(
      ["assumptions", "experiment", "intervention", "risk", "users"].toSorted(),
    );
    expect(sent.risk).toBe(written.risk);
  });
});

describe("renderPaperImpactReview", () => {
  it("marks a waiting statement high priority and sends the review with the note", () => {
    const sent: string[] = [];
    const container = document.createElement("div");
    const status = readPaperImpact({ title: "Jailbreak probes" }, slotRows(written));
    render(
      renderPaperImpactReview({ status, busy: false, onSave: (v) => sent.push(v) }),
      container,
    );
    expect(container.textContent).toContain("High priority");
    const note = container.querySelector("textarea") as HTMLTextAreaElement;
    note.value = "Clear.";
    container.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({
      ...written,
      reviewed: true,
      review_note: "Clear.",
    });
  });

  it("renders nothing for an unrelated paper nobody has written or corrected", () => {
    const container = document.createElement("div");
    const status = readPaperImpact({ title: "Sparse kernels" }, []);
    render(renderPaperImpactReview({ status, busy: false, onSave: () => {} }), container);
    expect(container.textContent?.trim()).toBe("");
  });
});
