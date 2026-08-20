// The evidence checklist inside a paper card: what each field offers, and what it says when the
// answer on file cannot be used.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { PaperSlotRow } from "../auth/session.ts";
import { renderPaperSlots } from "./paper-slots.ts";

type Saved = {
  slot: string;
  input: { url?: string; value_text?: string; done?: boolean };
};

function draw(slots: PaperSlotRow[], loading = false) {
  const saved: Saved[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderPaperSlots({
      paperId: "p1",
      slots,
      loading,
      onSaveSlot: (slot, input) => saved.push({ slot, input }),
    }),
    container,
  );
  return { container, saved };
}

function row(fields: Partial<PaperSlotRow> & { slot: string }): PaperSlotRow {
  return { paper_id: "p1", status: "missing", nudge_count: 0, ...fields };
}

describe("renderPaperSlots", () => {
  it("shows every slot, filled or not -- the card is the checklist", () => {
    const { container } = draw([]);
    expect(container.querySelectorAll(".paper-slot")).toHaveLength(25);
  });

  it("renders a link slot as a URL box and a bool slot as a checkbox", () => {
    const { container } = draw([]);
    const link = container.querySelector<HTMLInputElement>(
      '[data-testid="paper-slot-p1-overleaf_edit"]',
    );
    const bool = container.querySelector<HTMLInputElement>(
      '[data-testid="paper-slot-p1-pdf_ready"]',
    );
    expect(link?.type).toBe("url");
    expect(bool?.type).toBe("checkbox");
  });

  it("sends the value, never a status -- the service decides what counts as provided", () => {
    const { container, saved } = draw([]);
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="paper-slot-p1-project_folder"]',
    );
    if (!input) throw new Error("no input");
    input.value = "https://docs.google.com/document/d/x";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(saved).toEqual([
      { slot: "project_folder", input: { url: "https://docs.google.com/document/d/x" } },
    ]);
  });

  it("keeps a refused link on screen next to the reason", () => {
    const { container } = draw([
      row({
        slot: "arxiv",
        status: "invalid",
        url: "https://arxiv.org/pdf/1",
        invalid_reason: "the link must be a /abs/ URL",
      }),
    ]);
    const field = container.querySelector<HTMLInputElement>('[data-testid="paper-slot-p1-arxiv"]');
    expect(field?.value).toBe("https://arxiv.org/pdf/1");
    expect(container.textContent).toContain("the link must be a /abs/ URL");
  });

  it("says what a blocked slot is waiting for instead of hiding it", () => {
    const { container } = draw([]);
    const overleaf = container.querySelector('[data-testid="paper-slot-row-p1-overleaf_edit"]');
    expect(overleaf?.className).toContain("paper-slot--blocked");
    expect(overleaf?.textContent).toContain("Waiting on Project folder");
  });

  it("stops asking once the upstream slot is in", () => {
    const { container } = draw([row({ slot: "project_folder", status: "provided" })]);
    const overleaf = container.querySelector('[data-testid="paper-slot-row-p1-overleaf_edit"]');
    expect(overleaf?.className).not.toContain("paper-slot--blocked");
  });

  it("locks a waived slot and says who lifted it", () => {
    const { container } = draw([
      row({
        slot: "poster",
        status: "waived",
        waived_reason: "no poster session",
      }),
    ]);
    const field = container.querySelector<HTMLInputElement>('[data-testid="paper-slot-p1-poster"]');
    expect(field?.disabled).toBe(true);
    expect(container.textContent).toContain("no poster session");
  });

  it("marks the advisory slot optional, since nothing waits on it", () => {
    const { container } = draw([]);
    const sheet = container.querySelector('[data-testid="paper-slot-row-p1-backend_sheet"]');
    expect(sheet?.textContent).toContain("optional");
  });

  it("renders the credential as a password field and never echoes it back", () => {
    const { container } = draw([row({ slot: "arxiv_paper_password", status: "provided" })]);
    const field = container.querySelector<HTMLInputElement>(
      '[data-testid="paper-slot-p1-arxiv_paper_password"]',
    );
    expect(field?.type).toBe("password");
    // The service only returns the value to an author or an admin, and even then the card has no
    // reason to put it on screen -- "on file" is the whole answer.
    expect(field?.value).toBe("");
    expect(field?.placeholder).toContain("On file");
  });

  it("gives the enum slot a state and a place, and locks the place until a state is picked", () => {
    const { container, saved } = draw([]);
    const state = container.querySelector<HTMLSelectElement>(
      '[data-testid="paper-slot-p1-poster_physical"]',
    );
    const note = container.querySelector<HTMLInputElement>(
      '[data-testid="paper-slot-note-p1-poster_physical"]',
    );
    expect(state?.tagName).toBe("SELECT");
    expect(note?.disabled).toBe(true);
    if (!state) throw new Error("no state control");
    state.value = "printed";
    state.dispatchEvent(new Event("change", { bubbles: true }));
    expect(saved[0]).toMatchObject({ slot: "poster_physical", input: { value_text: "printed" } });
  });

  it("shows a derived gate as a readout, since the service refuses a direct write", () => {
    const { container } = draw([]);
    const gate = container.querySelector<HTMLInputElement>('[data-testid="paper-slot-p1-x_draft"]');
    expect(gate?.disabled).toBe(true);
    expect(
      container.querySelector('[data-testid="paper-slot-row-p1-x_draft"]')?.textContent,
    ).toContain("Waiting on an approved draft");
  });

  it("shows the accepted shape on a link slot, from the same rules the service enforces", () => {
    const { container } = draw([]);
    const overleaf = container.querySelector('[data-testid="paper-slot-row-p1-overleaf_edit"]');
    expect(overleaf?.textContent).toContain("overleaf.com");
    expect(overleaf?.textContent).toContain("/project/");
  });
});
