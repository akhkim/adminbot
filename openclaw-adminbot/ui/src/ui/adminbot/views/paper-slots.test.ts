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
/**
 * Render the card and wait for it to actually exist.
 *
 * The checklist now hands each branch's cards to <adminbot-paper-slot-deck>, a custom element, so
 * the rows arrive one microtask later than the synchronous `render()` call: the element has to
 * upgrade and Lit has to run its first update. Querying straight after `render` finds an empty
 * container -- which is what made every assertion in this file report zero rows.
 */
async function draw(
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
  await customElements.whenDefined("adminbot-paper-slot-deck");
  await Promise.all(
    [...container.querySelectorAll("adminbot-paper-slot-deck")].map(
      (deck) => (deck as HTMLElement & { updateComplete?: Promise<unknown> }).updateComplete,
    ),
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
  it("shows every slot when the card is expanded -- the checklist is still all there", async () => {
    const { container } = await draw([]);
    // The deck rework made a merged node a header row plus one child per half, so the four
    // second-halves became five child rows (both halves of "Published" are children now) and the
    // parent is a label with a status pill. The invariant that matters is unchanged: every field
    // in the registry is somewhere on the card.
    expect(container.querySelectorAll(".paper-slot")).toHaveLength(20);
    expect(container.querySelectorAll(".paper-slot__child")).toHaveLength(5);
  });

  it("draws the two halves of a node in one row rather than two", async () => {
    const { container } = await draw([]);
    // The submission page and its id are both node SB. Two rows made the card claim two steps.
    const parent = container.querySelector('[data-testid="paper-slot-row-p1-submission"]');
    expect(parent?.querySelector('[data-testid="paper-slot-child-p1-submission_id"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="paper-slot-row-p1-submission_id"]')).toBeNull();
  });

  it("titles a merged row after the node, not after whichever half is the parent", async () => {
    const { container } = await draw([]);
    const parent = container.querySelector('[data-testid="paper-slot-row-p1-overleaf_edit"]');
    expect(parent?.querySelector(".paper-slot__label")?.textContent).toContain("Overleaf");
  });

  it("orders the sections as the chart numbers them: trunk, then Branch 1 to 4", async () => {
    const { container } = await draw([]);
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

  it("marks the trunk apart from the branches that hang off it", async () => {
    const { container } = await draw([]);
    const trunk = container.querySelector('[data-testid="paper-slots-branch-p1-core"]');
    const branch = container.querySelector('[data-testid="paper-slots-branch-p1-venue"]');
    expect(trunk?.classList.contains("paper-slots__group--trunk")).toBe(true);
    expect(branch?.classList.contains("paper-slots__group--branch")).toBe(true);
    // The chart's own edge label, so the card can be read beside the diagram.
    expect(branch?.querySelector(".paper-slots__branch-number")?.textContent).toContain("Branch 4");
  });

  it("has no rebuttal field: the bcc loop closes that stage now", async () => {
    const { container } = await draw([]);
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

    it("shows what closed a rung, so a stage that closed itself can be checked", async () => {
      const { container } = await draw([], false, { stages });
      const reviews = container.querySelector('[data-testid="paper-stage-p1-reviews_out"]');
      expect(reviews?.textContent).toContain("ARR reviews available");
    });

    it("names the one rung anybody can act on, and what the action is", async () => {
      const { container } = await draw([], false, { stages });
      const decision = container.querySelector('[data-testid="paper-stage-p1-decision"]');
      expect(decision?.textContent).toContain("bcc us when it lands");
    });

    it("offers no control at all: nothing a person does closes these", async () => {
      const { container } = await draw([], false, { stages });
      const ladder = container.querySelector('[data-testid="paper-stages-p1"]');
      expect(ladder?.querySelectorAll("input, select, button")).toHaveLength(0);
    });

    it("distinguishes not-yet-reached from waiting, rather than collapsing both to blank", async () => {
      const { container } = await draw([], false, { stages });
      // Otherwise an unsubmitted paper looks like one whose decision is overdue.
      const upcoming = container.querySelector('[data-testid="paper-stage-p1-camera_ready"]');
      expect(upcoming?.classList.contains("paper-stage--upcoming")).toBe(true);
    });

    it("is absent entirely when the card has no stage data", async () => {
      const { container } = await draw([]);
      expect(container.querySelector('[data-testid="paper-stages-p1"]')).toBeNull();
    });
  });

  describe("the paper's own details", () => {
    const details = (onSaveDetails?: PaperDetailsProps["onSaveDetails"]): PaperDetailsProps => ({
      authors: ["Ada Lovelace", "Rahul Babu Shrestha"],
      feedbackGivers: ["Bernhard Schölkopf"],
      venue: "ICLR 2027",
      authorRoles: "Ada ran the experiments. Rahul built the dataset.",
      ...(onSaveDetails ? { onSaveDetails } : {}),
    });

    it("lets an author edit the author list, which decides who the stage emails reach", async () => {
      const saves: unknown[] = [];
      const { container } = await draw([], false, {
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

    it("keeps feedback givers apart from authors", async () => {
      const { container } = await draw([], false, { details: details(() => {}) });
      const givers = container.querySelector<HTMLInputElement>(
        '[data-testid="paper-feedback-givers-p1"]',
      );
      expect(givers?.value).toBe("Bernhard Schölkopf");
    });

    it("takes the aimed conference, which the stage emails quote", async () => {
      const saves: Array<{ venue: string }> = [];
      const { container } = await draw([], false, {
        details: details((next) => saves.push(next)),
      });
      const venue = container.querySelector<HTMLInputElement>('[data-testid="paper-venue-p1"]');
      expect(venue?.value).toBe("ICLR 2027");
      venue!.value = "NeurIPS 2027";
      venue!.dispatchEvent(new Event("change"));
      expect(saves[0]?.venue).toBe("NeurIPS 2027");
    });

    it("takes what each author does as a paragraph, and sends it with the save", async () => {
      const saves: Array<{ authorRoles: string }> = [];
      const { container } = await draw([], false, {
        details: details((next) => saves.push(next)),
      });
      const roles = container.querySelector<HTMLTextAreaElement>(
        '[data-testid="paper-author-roles-p1"]',
      );
      expect(roles?.value).toBe("Ada ran the experiments. Rahul built the dataset.");
      roles!.value = "  Ada wrote §4. Zhijing advised throughout.  ";
      roles!.dispatchEvent(new Event("change"));
      // Trimmed on the way out, so a paragraph of whitespace is not a filled-in field.
      expect(saves[0]?.authorRoles).toBe("Ada wrote §4. Zhijing advised throughout.");
      // The rest of the details ride along unchanged rather than being cleared.
      expect(saves[0]).toMatchObject({ venue: "ICLR 2027" });
    });

    it("shows the contributions paragraph read-only to somebody who may not edit", async () => {
      const { container } = await draw([], false, { details: details() });
      expect(container.querySelector('[data-testid="paper-author-roles-p1"]')).toBeNull();
      expect(container.textContent).toContain("Ada ran the experiments.");
    });

    it("drops blank entries rather than storing an author nobody can resolve", async () => {
      const saves: Array<{ authors: string[] }> = [];
      const { container } = await draw([], false, {
        details: details((next) => saves.push(next)),
      });
      const field = container.querySelector<HTMLInputElement>('[data-testid="paper-authors-p1"]');
      field!.value = "Ada Lovelace, , Rahul Babu Shrestha,";
      field!.dispatchEvent(new Event("change"));
      expect(saves[0]?.authors).toEqual(["Ada Lovelace", "Rahul Babu Shrestha"]);
    });

    it("renders read-only for somebody who may not edit the paper", async () => {
      const { container } = await draw([], false, { details: details() });
      expect(container.querySelector('[data-testid="paper-authors-p1"]')).toBeNull();
      expect(container.querySelector(".paper-detail__readonly")?.textContent).toContain(
        "Ada Lovelace",
      );
    });
  });

  it("renders a link slot as a URL box and a bool slot as a checkbox", async () => {
    const { container } = await draw([]);
    const link = container.querySelector<HTMLInputElement>(
      '[data-testid="paper-slot-p1-overleaf_edit"]',
    );
    const bool = container.querySelector<HTMLInputElement>(
      '[data-testid="paper-slot-p1-pdf_ready"]',
    );
    expect(link?.type).toBe("url");
    expect(bool?.type).toBe("checkbox");
  });

  it("sends the value, never a status -- the service decides what counts as provided", async () => {
    const { container, saved } = await draw([]);
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

  it("keeps a refused link on screen next to the reason", async () => {
    const { container } = await draw([
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

  it("dims a slot that is not reachable yet, without narrating why", async () => {
    // The "Waiting on X" line, the "unblocks Y" line and the host/path spec were three rows of
    // small grey type under every field. The dimming carries the same meaning without turning the
    // card into a dependency graph.
    const { container } = await draw([]);
    const overleaf = container.querySelector('[data-testid="paper-slot-row-p1-overleaf_edit"]');
    expect(overleaf?.className).toContain("paper-slot--blocked");
    expect(overleaf?.textContent).not.toContain("Waiting on");
    expect(overleaf?.textContent).not.toContain("unblocks");
  });

  it("stops asking once the upstream slot is in", async () => {
    const { container } = await draw([row({ slot: "project_folder", status: "provided" })]);
    const overleaf = container.querySelector('[data-testid="paper-slot-row-p1-overleaf_edit"]');
    expect(overleaf?.className).not.toContain("paper-slot--blocked");
  });

  it("locks a waived slot and says who lifted it", async () => {
    const { container } = await draw([
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

  it("marks the advisory slot optional, since nothing waits on it", async () => {
    const { container } = await draw([]);
    const sheet = container.querySelector('[data-testid="paper-slot-row-p1-backend_sheet"]');
    expect(sheet?.textContent).toContain("optional");
  });

  it("renders the credential as a password field and never echoes it back", async () => {
    const { container } = await draw([row({ slot: "arxiv_paper_password", status: "provided" })]);
    const field = container.querySelector<HTMLInputElement>(
      '[data-testid="paper-slot-p1-arxiv_paper_password"]',
    );
    expect(field?.type).toBe("password");
    // The service only returns the value to an author or an admin, and even then the card has no
    // reason to put it on screen -- "on file" is the whole answer.
    expect(field?.value).toBe("");
    expect(field?.placeholder).toContain("On file");
  });

  it("gives the enum slot a state and a place, and locks the place until a state is picked", async () => {
    const { container, saved } = await draw([]);
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

  it("shows a derived gate as a readout, since the service refuses a direct write", async () => {
    const { container } = await draw([]);
    const gate = container.querySelector<HTMLInputElement>('[data-testid="paper-slot-p1-x_draft"]');
    expect(gate?.disabled).toBe(true);
    expect(
      container.querySelector('[data-testid="paper-slot-row-p1-x_draft"]')?.textContent,
    ).toContain("Waiting on an approved draft");
  });

  it("shows the accepted shape on a link slot, from the same rules the service enforces", async () => {
    const { container } = await draw([]);
    const overleaf = container.querySelector('[data-testid="paper-slot-row-p1-overleaf_edit"]');
    expect(overleaf?.textContent).toContain("overleaf.com");
    expect(overleaf?.textContent).toContain("/project/");
  });
});

describe("renderPaperSlots -- only what is ready", () => {
  it("keeps every field in the deck rather than hiding what is not ready", async () => {
    // This reverses the old working-set rule, deliberately: 25 boxes was a wall only while they
    // were a grid, and the deck shows one card at a time with arrows through the rest. A settled
    // field keeps rendering with its done pill, so paging back reviews the history too.
    const { container } = await draw([], false, { showAll: false });
    expect(container.querySelectorAll(".paper-slot")).toHaveLength(20);
  });

  it("includes what opens next, not only what is unblocked today", async () => {
    // overleaf_edit waits on project_folder alone, so it is the next thing to open and is
    // worth showing now -- it is what makes the sequence legible.
    const { container } = await draw([], false, { showAll: false });
    expect(container.querySelector('[data-testid="paper-slot-p1-overleaf_edit"]')).not.toBeNull();
  });

  it("keeps far-off work in the deck, marked as waiting rather than removed", async () => {
    const { container } = await draw([], false, { showAll: false });
    // arxiv sits behind several unfinished slots. It is still a card in the deck -- the deck says
    // what it waits on rather than dropping it, which is what makes flipping through the branch a
    // picture of the whole process.
    expect(container.querySelector('[data-testid="paper-slot-p1-arxiv"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="paper-slot-p1-project_folder"]')).not.toBeNull();
  });

  it("reveals the next field once its upstream is provided", async () => {
    const { container } = await draw(
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

  it("keeps a wrong answer on screen so it can be corrected", async () => {
    // An invalid value is shown even when its branch is otherwise out of reach: hiding it would
    // leave a paper permanently "needs fixing" with nowhere to fix it.
    const { container } = await draw(
      [row({ slot: "arxiv", status: "invalid", url: "nope", invalid_reason: "that is not a URL" })],
      false,
      { showAll: false },
    );
    expect(container.querySelector('[data-testid="paper-slot-p1-arxiv"]')).not.toBeNull();
  });

  it("keeps a finished field in the deck", async () => {
    const { container } = await draw(
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
    // Finished fields stay in the deck with their done pill: the deck is the branch's history as
    // well as its to-do list.
    expect(container.querySelector('[data-testid="paper-slot-p1-project_folder"]')).not.toBeNull();
  });

  it("says how many are held back, so nothing looks lost", async () => {
    const { container } = await draw([], false, { showAll: false });
    expect(container.querySelector(".paper-slots__filter-text")?.textContent).toContain(
      "further off",
    );
  });
});

describe("social draft gates", () => {
  it("opens the drafting tool instead of offering a checkbox nobody can tick", async () => {
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
    // This one renders inline rather than through `draw`, so it has to flush the deck itself.
    await customElements.whenDefined("adminbot-paper-slot-deck");
    await Promise.all(
      [...container.querySelectorAll("adminbot-paper-slot-deck")].map(
        (deck) => (deck as HTMLElement & { updateComplete?: Promise<unknown> }).updateComplete,
      ),
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
  it("shows a worked example rather than the shape of a URL", async () => {
    // "https://…" tells someone what a URL looks like, which they knew, and nothing about
    // which URL. The arXiv slot is the sharpest case: /abs/ and /pdf/ are both valid URLs.
    const { container } = await draw([]);
    const arxiv = container.querySelector<HTMLInputElement>('[data-testid="paper-slot-p1-arxiv"]');
    expect(arxiv?.placeholder).toBe("https://arxiv.org/abs/2306.05836");
    expect(arxiv?.placeholder).not.toBe("https://…");
  });

  it("gives the submission id a real specimen, not 'e.g. 4821'", async () => {
    const { container } = await draw([]);
    const id = container.querySelector<HTMLInputElement>(
      '[data-testid="paper-slot-p1-submission_id"]',
    );
    expect(id?.placeholder).toBe("Ax7Kq2Lm9P");
  });

  it("puts a help control on every field, including the checkbox ones", async () => {
    const { container } = await draw([]);
    // Every field, not every row. A merged node renders as a header row plus one child per half,
    // and the header is a label and a pill rather than a field -- so it is the children that must
    // each keep their guidance, which is the thing a merged row could quietly lose.
    const fields = [...container.querySelectorAll(".paper-slot, .paper-slot__child")].filter(
      (row) => !row.querySelector(".paper-slot__children"),
    );
    const withoutHelp = fields.filter((row) => !row.querySelector(".paper-slot__help"));
    expect(withoutHelp).toEqual([]);
    expect(fields.length).toBeGreaterThan(20);
  });

  // A question mark next to a field reads as a query about the field; an "i" says there is an
  // explanation here, which is what the badge actually offers.
  it("marks the help badge with an info glyph, not a question mark", async () => {
    const { container } = await draw([]);
    const badge = container.querySelector<HTMLElement>(
      '[data-testid="paper-slot-help-p1-overleaf_edit"]',
    );
    expect(badge?.textContent?.trim()).toBe("i");
    expect(badge?.getAttribute("aria-label")).toContain("Overleaf project link");
  });

  it("explains in the popover what to put, and repeats the example", async () => {
    const { container } = await draw([]);
    const help = container.querySelector(
      '[data-testid="paper-slot-help-p1-overleaf_edit"]',
    )?.parentElement;
    expect(help?.textContent).toContain("address bar");
    expect(help?.textContent).toContain("overleaf.com/project/");
  });
});
