// The evidence checklist inside a paper card: what each field offers, and what it says when the
// answer on file cannot be used.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { PaperflowStageRow, PaperSlotRow } from "../auth/session.ts";
import { renderPaperSlots, type PaperDetailsProps } from "./paper-slots.ts";

type Saved = {
  slot: string;
  input: { url?: string; value_text?: string; done?: boolean };
};

/**
 * `showAll` defaults to true here because most of these cases assert how one specific field
 * renders, and the card's default view deliberately hides fields that are still waiting on
 * upstream evidence. The filtering itself is covered by its own describe block below.
 */
function draw(
  slots: PaperSlotRow[],
  loading = false,
  extra: { stages?: PaperflowStageRow[]; details?: PaperDetailsProps; showAll?: boolean } = {},
) {
  const saved: Saved[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderPaperSlots({
      paperId: "p1",
      slots,
      loading,
      showAllSlots: extra.showAll ?? true,
      onToggleShowAll: () => {},
      ...(extra.stages ? { stages: extra.stages } : {}),
      ...(extra.details ? { details: extra.details } : {}),
      onSaveSlot: (slot, input) => saved.push({ slot, input }),
    }),
    container,
  );
  return { container, saved };
}

function stage(fields: Partial<PaperflowStageRow> & { stage: string }): PaperflowStageRow {
  return { label: fields.stage, node: "RV", state: "upcoming", ...fields };
}

function row(fields: Partial<PaperSlotRow> & { slot: string }): PaperSlotRow {
  return { paper_id: "p1", status: "missing", nudge_count: 0, ...fields };
}

describe("renderPaperSlots", () => {
  it("shows every slot when the card is expanded -- the checklist is still all there", () => {
    const { container } = draw([]);
    // 24 slots, four of which are the second half of a node their parent already draws, so the
    // card is 20 rows. The chart has 20-odd nodes; the card used to claim 25 steps it did not
    // have, which is what made it read as longer than the process it describes.
    expect(container.querySelectorAll(".paper-slot")).toHaveLength(20);
    expect(container.querySelectorAll(".paper-slot__child")).toHaveLength(4);
  });

  it("draws the two halves of a node in one row rather than two", () => {
    const { container } = draw([]);
    // The submission page and its id are both node SB. Two rows made the card claim two steps.
    const parent = container.querySelector('[data-testid="paper-slot-row-p1-submission"]');
    expect(parent?.querySelector('[data-testid="paper-slot-child-p1-submission_id"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="paper-slot-row-p1-submission_id"]')).toBeNull();
  });

  it("titles a merged row after the node, not after whichever half is the parent", () => {
    const { container } = draw([]);
    const parent = container.querySelector('[data-testid="paper-slot-row-p1-overleaf_edit"]');
    expect(parent?.querySelector(".paper-slot__label")?.textContent).toContain("Overleaf");
  });

  it("orders the sections as the chart numbers them: trunk, then Branch 1 to 4", () => {
    const { container } = draw([]);
    const branches = [...container.querySelectorAll("[data-testid^='paper-slots-branch-p1-']")].map(
      (node) => node.getAttribute("data-testid"),
    );
    expect(branches).toEqual([
      "paper-slots-branch-p1-core",
      "paper-slots-branch-p1-talk",
      "paper-slots-branch-p1-social",
      "paper-slots-branch-p1-archive",
      "paper-slots-branch-p1-venue",
    ]);
  });

  it("marks the trunk apart from the branches that hang off it", () => {
    const { container } = draw([]);
    const trunk = container.querySelector('[data-testid="paper-slots-branch-p1-core"]');
    const branch = container.querySelector('[data-testid="paper-slots-branch-p1-venue"]');
    expect(trunk?.classList.contains("paper-slots__group--trunk")).toBe(true);
    expect(branch?.classList.contains("paper-slots__group--branch")).toBe(true);
    // The chart's own edge label, so the card can be read beside the diagram.
    expect(branch?.querySelector(".paper-slots__branch-number")?.textContent).toContain("Branch 4");
  });

  it("has no rebuttal field: the bcc loop closes that stage now", () => {
    const { container } = draw([]);
    expect(container.querySelector('[data-testid="paper-slot-p1-rebuttal_doc"]')).toBeNull();
  });

  describe("the venue ladder", () => {
    const stages = [
      stage({
        stage: "reviews_out",
        label: "Reviews",
        state: "closed",
        closed_at: "2026-08-12T00:00:00.000Z",
        closed_by_subject: "ARR reviews available",
        closed_by: "email_bcc",
      }),
      stage({ stage: "rebuttal", label: "Rebuttal window", state: "closed", closed_by: "admin" }),
      stage({ stage: "decision", label: "Decision", state: "waiting" }),
      stage({ stage: "camera_ready", label: "Camera ready" }),
      stage({ stage: "conference", label: "Conference attendance" }),
    ];

    it("shows what closed a rung, so a stage that closed itself can be checked", () => {
      const { container } = draw([], false, { stages });
      const reviews = container.querySelector('[data-testid="paper-stage-p1-reviews_out"]');
      expect(reviews?.textContent).toContain("ARR reviews available");
    });

    it("names the one rung anybody can act on, and what the action is", () => {
      const { container } = draw([], false, { stages });
      const decision = container.querySelector('[data-testid="paper-stage-p1-decision"]');
      expect(decision?.textContent).toContain("bcc us when it lands");
    });

    it("offers no control at all: nothing a person does closes these", () => {
      const { container } = draw([], false, { stages });
      const ladder = container.querySelector('[data-testid="paper-stages-p1"]');
      expect(ladder?.querySelectorAll("input, select, button")).toHaveLength(0);
    });

    it("distinguishes not-yet-reached from waiting, rather than collapsing both to blank", () => {
      const { container } = draw([], false, { stages });
      // Otherwise an unsubmitted paper looks like one whose decision is overdue.
      const upcoming = container.querySelector('[data-testid="paper-stage-p1-camera_ready"]');
      expect(upcoming?.classList.contains("paper-stage--upcoming")).toBe(true);
    });

    it("is absent entirely when the card has no stage data", () => {
      const { container } = draw([]);
      expect(container.querySelector('[data-testid="paper-stages-p1"]')).toBeNull();
    });
  });

  describe("the paper's own details", () => {
    const details = (onSaveDetails?: PaperDetailsProps["onSaveDetails"]): PaperDetailsProps => ({
      authors: ["Ada Lovelace", "Rahul Babu Shrestha"],
      feedbackGivers: ["Bernhard Schölkopf"],
      venue: "ICLR 2027",
      ...(onSaveDetails ? { onSaveDetails } : {}),
    });

    it("lets an author edit the author list, which decides who the stage emails reach", () => {
      const saves: unknown[] = [];
      const { container } = draw([], false, {
        details: details((next) => saves.push(next)),
      });
      const field = container.querySelector<HTMLInputElement>('[data-testid="paper-authors-p1"]');
      expect(field?.value).toBe("Ada Lovelace, Rahul Babu Shrestha");
      field!.value = "Rahul Babu Shrestha, Ada Lovelace";
      field!.dispatchEvent(new Event("change"));
      expect(saves).toEqual([
        expect.objectContaining({ authors: ["Rahul Babu Shrestha", "Ada Lovelace"] }),
      ]);
    });

    it("keeps feedback givers apart from authors", () => {
      const { container } = draw([], false, { details: details(() => {}) });
      const givers = container.querySelector<HTMLInputElement>(
        '[data-testid="paper-feedback-givers-p1"]',
      );
      expect(givers?.value).toBe("Bernhard Schölkopf");
    });

    it("takes the aimed conference, which the stage emails quote", () => {
      const saves: Array<{ venue: string }> = [];
      const { container } = draw([], false, {
        details: details((next) => saves.push(next)),
      });
      const venue = container.querySelector<HTMLInputElement>('[data-testid="paper-venue-p1"]');
      expect(venue?.value).toBe("ICLR 2027");
      venue!.value = "NeurIPS 2027";
      venue!.dispatchEvent(new Event("change"));
      expect(saves[0]?.venue).toBe("NeurIPS 2027");
    });

    it("drops blank entries rather than storing an author nobody can resolve", () => {
      const saves: Array<{ authors: string[] }> = [];
      const { container } = draw([], false, {
        details: details((next) => saves.push(next)),
      });
      const field = container.querySelector<HTMLInputElement>('[data-testid="paper-authors-p1"]');
      field!.value = "Ada Lovelace, , Rahul Babu Shrestha,";
      field!.dispatchEvent(new Event("change"));
      expect(saves[0]?.authors).toEqual(["Ada Lovelace", "Rahul Babu Shrestha"]);
    });

    it("renders read-only for somebody who may not edit the paper", () => {
      const { container } = draw([], false, { details: details() });
      expect(container.querySelector('[data-testid="paper-authors-p1"]')).toBeNull();
      expect(container.querySelector(".paper-detail__readonly")?.textContent).toContain(
        "Ada Lovelace",
      );
    });
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

describe("renderPaperSlots -- only what is ready", () => {
  it("fills the grid without showing the whole checklist", () => {
    // Two competing failures: 25 boxes is a wall, and 2 boxes leaves the grid looking broken
    // and says nothing about what comes next. The working set sits between them.
    const { container } = draw([], false, { showAll: false });
    const shown = container.querySelectorAll(".paper-slot");
    expect(shown.length).toBeGreaterThanOrEqual(5);
    expect(shown.length).toBeLessThanOrEqual(9);
  });

  it("includes what opens next, not only what is unblocked today", () => {
    // overleaf_edit waits on project_folder alone, so it is the next thing to open and is
    // worth showing now -- it is what makes the sequence legible.
    const { container } = draw([], false, { showAll: false });
    expect(container.querySelector('[data-testid="paper-slot-p1-overleaf_edit"]')).not.toBeNull();
  });

  it("hides work that is more than one step away", () => {
    const { container } = draw([], false, { showAll: false });
    // arxiv sits behind several unfinished slots, so it is not part of the working set yet.
    expect(container.querySelector('[data-testid="paper-slot-p1-arxiv"]')).toBeNull();
    expect(container.querySelector('[data-testid="paper-slot-p1-project_folder"]')).not.toBeNull();
  });

  it("reveals the next field once its upstream is provided", () => {
    const { container } = draw(
      [
        row({
          slot: "project_folder",
          status: "provided",
          url: "https://docs.google.com/document/d/x",
        }),
      ],
      false,
      { showAll: false },
    );
    expect(container.querySelector('[data-testid="paper-slot-p1-overleaf_edit"]')).not.toBeNull();
  });

  it("keeps a wrong answer on screen so it can be corrected", () => {
    // An invalid value is shown even when its branch is otherwise out of reach: hiding it would
    // leave a paper permanently "needs fixing" with nowhere to fix it.
    const { container } = draw(
      [row({ slot: "arxiv", status: "invalid", url: "nope", invalid_reason: "that is not a URL" })],
      false,
      { showAll: false },
    );
    expect(container.querySelector('[data-testid="paper-slot-p1-arxiv"]')).not.toBeNull();
  });

  it("drops a finished field out of the working set", () => {
    const { container } = draw(
      [
        row({
          slot: "project_folder",
          status: "provided",
          url: "https://docs.google.com/document/d/x",
        }),
      ],
      false,
      { showAll: false },
    );
    expect(container.querySelector('[data-testid="paper-slot-p1-project_folder"]')).toBeNull();
  });

  it("says how many are held back, so nothing looks lost", () => {
    const { container } = draw([], false, { showAll: false });
    expect(container.querySelector(".paper-slots__filter-text")?.textContent).toContain(
      "further off",
    );
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
    // Every field, not every row: four of them are the nested half of a merged row, and a merged
    // row must not quietly lose the guidance its second field had.
    const fields = container.querySelectorAll(".paper-slot, .paper-slot__child");
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
