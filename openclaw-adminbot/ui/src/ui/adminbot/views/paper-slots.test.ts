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

/**
 * `showAll` defaults to true here because most of these cases assert how one specific field
 * renders, and the card's default view deliberately hides fields that are still waiting on
 * upstream evidence. The filtering itself is covered by its own describe block below.
 */
function draw(slots: PaperSlotRow[], loading = false, showAll = true) {
  const saved: Saved[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderPaperSlots({
      paperId: "p1",
      slots,
      loading,
      showAllSlots: showAll,
      onToggleShowAll: () => {},
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
  it("shows every slot when the card is expanded -- the checklist is still all there", () => {
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

  it("dims a slot that is not reachable yet, without narrating why", () => {
    // The "Waiting on X" line, the "unblocks Y" line and the host/path spec were three rows of
    // small grey type under every field. The dimming carries the same meaning without turning the
    // card into a dependency graph.
    const { container } = draw([]);
    const overleaf = container.querySelector('[data-testid="paper-slot-row-p1-overleaf_edit"]');
    expect(overleaf?.className).toContain("paper-slot--blocked");
    expect(overleaf?.textContent).not.toContain("Waiting on");
    expect(overleaf?.textContent).not.toContain("unblocks");
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

describe("renderPaperSlots -- only what is ready", () => {
  it("fills the grid without showing the whole checklist", () => {
    // Two competing failures: 25 boxes is a wall, and 2 boxes leaves the grid looking broken
    // and says nothing about what comes next. The working set sits between them.
    const { container } = draw([], false, false);
    const shown = container.querySelectorAll(".paper-slot");
    expect(shown.length).toBeGreaterThanOrEqual(5);
    expect(shown.length).toBeLessThanOrEqual(9);
  });

  it("includes what opens next, not only what is unblocked today", () => {
    // overleaf_edit waits on project_folder alone, so it is the next thing to open and is
    // worth showing now -- it is what makes the sequence legible.
    const { container } = draw([], false, false);
    expect(container.querySelector('[data-testid="paper-slot-p1-overleaf_edit"]')).not.toBeNull();
  });

  it("hides work that is more than one step away", () => {
    const { container } = draw([], false, false);
    // arxiv sits behind several unfinished slots, so it is not part of the working set yet.
    expect(container.querySelector('[data-testid="paper-slot-p1-arxiv"]')).toBeNull();
    expect(container.querySelector('[data-testid="paper-slot-p1-project_folder"]')).not.toBeNull();
  });

  it("reveals the next field once its upstream is provided", () => {
    const { container } = draw(
      [row({ slot: "project_folder", status: "provided", url: "https://docs.google.com/document/d/x" })],
      false,
      false,
    );
    expect(container.querySelector('[data-testid="paper-slot-p1-overleaf_edit"]')).not.toBeNull();
  });

  it("keeps a wrong answer on screen so it can be corrected", () => {
    // An invalid value is shown even when its branch is otherwise out of reach: hiding it would
    // leave a paper permanently "needs fixing" with nowhere to fix it.
    const { container } = draw(
      [row({ slot: "arxiv", status: "invalid", url: "nope", invalid_reason: "that is not a URL" })],
      false,
      false,
    );
    expect(container.querySelector('[data-testid="paper-slot-p1-arxiv"]')).not.toBeNull();
  });

  it("drops a finished field out of the working set", () => {
    const { container } = draw(
      [row({ slot: "project_folder", status: "provided", url: "https://docs.google.com/document/d/x" })],
      false,
      false,
    );
    expect(container.querySelector('[data-testid="paper-slot-p1-project_folder"]')).toBeNull();
  });

  it("says how many are held back, so nothing looks lost", () => {
    const { container } = draw([], false, false);
    expect(container.querySelector(".paper-slots__filter-text")?.textContent).toContain("further off");
  });
});

describe("social draft gates", () => {
  it("opens the drafting tool instead of offering a checkbox nobody can tick", () => {
    // The gate reads its truth from paper_social_drafts, so a checkbox here could only ever
    // disagree with it. What the author wants when they click it is the drafting tool.
    const opened: string[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderPaperSlots({
        paperId: "p1",
        slots: [],
        loading: false,
        showAllSlots: true,
        onSaveSlot: () => {},
        onOpenDraft: (platform) => opened.push(platform),
      }),
      container,
    );
    const gate = container.querySelector<HTMLButtonElement>(
      '[data-testid="paper-slot-p1-linkedin_draft"]',
    );
    expect(gate?.tagName).toBe("BUTTON");
    gate?.click();
    expect(opened).toEqual(["linkedin"]);
  });
});

describe("field guidance", () => {
  it("shows a worked example rather than the shape of a URL", () => {
    // "https://…" tells someone what a URL looks like, which they knew, and nothing about
    // which URL. The arXiv slot is the sharpest case: /abs/ and /pdf/ are both valid URLs.
    const { container } = draw([]);
    const arxiv = container.querySelector<HTMLInputElement>('[data-testid="paper-slot-p1-arxiv"]');
    expect(arxiv?.placeholder).toBe("https://arxiv.org/abs/2306.05836");
    expect(arxiv?.placeholder).not.toBe("https://…");
  });

  it("gives the submission id a real specimen, not 'e.g. 4821'", () => {
    const { container } = draw([]);
    const id = container.querySelector<HTMLInputElement>(
      '[data-testid="paper-slot-p1-submission_id"]',
    );
    expect(id?.placeholder).toBe("Ax7Kq2Lm9P");
  });

  it("puts a help control on every field, including the checkbox ones", () => {
    const { container } = draw([]);
    const helps = container.querySelectorAll(".paper-slot__help");
    const fields = container.querySelectorAll(".paper-slot");
    expect(helps.length).toBe(fields.length);
  });

  it("explains in the popover what to put, and repeats the example", () => {
    const { container } = draw([]);
    const help = container.querySelector(
      '[data-testid="paper-slot-help-p1-overleaf_edit"]',
    )?.parentElement;
    expect(help?.textContent).toContain("address bar");
    expect(help?.textContent).toContain("overleaf.com/project/");
  });
});
