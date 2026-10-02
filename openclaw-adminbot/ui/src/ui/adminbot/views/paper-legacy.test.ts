/* @vitest-environment jsdom */
// The flat view of My Projects & Papers: that every field is on the page, and that what is typed
// reaches the right one of the two stores behind it.
import { html, render } from "lit";
import { describe, expect, it } from "vitest";
import { adminBotPaperSlots } from "../../../../../extensions/adminbot/src/contracts/paper-slots.js";
import type { PaperCycle } from "../auth/session.ts";
import type { AdminBotPaperRecord, AdminBotPaperSaveInput } from "../controllers/admin.ts";
import {
  collectLegacyWrites,
  emptyPaperLegacyState,
  legacyGroups,
  renderPaperLegacy,
  type PaperLegacyState,
} from "./paper-legacy.ts";

function paper(overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "Causal abstraction",
    authors: ["Ada Lovelace", "Bob Coauthor"],
    current_step: "overleaf_writing",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function cycle(slots: PaperCycle["slots"] = []): PaperCycle {
  return { slots } as unknown as PaperCycle;
}

type Drawn = {
  container: HTMLElement;
  state: PaperLegacyState;
  saved: AdminBotPaperSaveInput[];
  slotWrites: Array<{ paperId: string; slot: string; input: Record<string, unknown> }>;
  loaded: string[];
  exits: number;
};

function draw(
  options: { papers?: AdminBotPaperRecord[]; slots?: Record<string, PaperCycle> } = {},
): Drawn {
  document.body.replaceChildren();
  const state = emptyPaperLegacyState();
  const saved: AdminBotPaperSaveInput[] = [];
  const slotWrites: Drawn["slotWrites"] = [];
  const loaded: string[] = [];
  let exits = 0;
  const container = document.createElement("div");
  document.body.append(container);
  const props = {
    state,
    papers: options.papers ?? [paper()],
    slots: options.slots ?? { p1: cycle() },
    onLoadSlots: (id: string) => loaded.push(id),
    onSavePaper: (input: AdminBotPaperSaveInput) => saved.push(input),
    onSaveSlot: (paperId: string, slot: string, input: Record<string, unknown>) =>
      slotWrites.push({ paperId, slot, input }),
    onChange: () => render(renderPaperLegacy(props), container),
    onExit: () => {
      exits += 1;
    },
  };
  render(renderPaperLegacy(props), container);
  return { container, state, saved, slotWrites, loaded, exits: exits };
}

function type(container: HTMLElement, testId: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  if (!input) {
    throw new Error(`no control ${testId}`);
  }
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("legacyGroups", () => {
  it("shows the same OpenReview identity warning in the flat paper form", () => {
    const { container } = draw({
      slots: {
        p1: cycle([
          {
            paper_id: "p1",
            slot: "submission",
            status: "provided",
            url: "https://openreview.net/forum?id=Paper123",
            verified_by: "openreview",
            verified_title: "A renamed paper",
            previous_submission_id: "Older123",
          },
        ]),
      },
    });
    expect(container.querySelector('[data-testid="openreview-identity"]')?.textContent).toContain(
      "Resubmission reported by OpenReview",
    );
  });
  it("puts every evidence slot on the page, so nothing is only reachable from the card", () => {
    const keys = new Set(
      legacyGroups()
        .flatMap((group) => group.fields)
        .filter((field) => field.kind === "slot")
        .map((field) => field.key),
    );
    expect(keys.size).toBe(adminBotPaperSlots.length);
    for (const slot of adminBotPaperSlots) {
      expect(keys.has(slot)).toBe(true);
    }
  });

  it("carries the record fields the card can edit, so the flat view is not a subset", () => {
    const keys = legacyGroups()
      .flatMap((group) => group.fields)
      .filter((field) => field.kind === "record")
      .map((field) => field.key);
    for (const key of ["title", "alias", "authors", "venue", "venueDecision", "acceptedVenue"]) {
      expect(keys).toContain(key);
    }
  });
});

describe("renderPaperLegacy", () => {
  it("draws one profile-style section per paper", () => {
    const { container } = draw({
      papers: [paper(), paper({ id: "p2", title: "Robustness bounds" })],
      slots: { p1: cycle(), p2: cycle() },
    });
    expect(container.querySelector('[data-testid="paper-legacy-paper-p1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="paper-legacy-paper-p2"]')).not.toBeNull();
    // The profile's own markup, which is the whole point of this view.
    expect(container.querySelectorAll(".profile__field-group").length).toBeGreaterThan(1);
  });

  it("shows the stored value in each control", () => {
    const { container } = draw({
      papers: [paper({ alias: "cais", venue: "EMNLP 2026" })],
    });
    const alias = container.querySelector<HTMLInputElement>(
      '[data-testid="paper-legacy-p1-alias"]',
    );
    const authors = container.querySelector<HTMLInputElement>(
      '[data-testid="paper-legacy-p1-authors"]',
    );
    expect(alias?.value).toBe("cais");
    expect(authors?.value).toBe("Ada Lovelace, Bob Coauthor");
  });

  it("fills a link slot from the evidence the host loaded", () => {
    const { container } = draw({
      slots: {
        p1: cycle([
          { paper_id: "p1", slot: "arxiv", status: "provided", url: "https://arxiv.org/abs/1" },
        ]),
      },
    });
    const arxiv = container.querySelector<HTMLInputElement>(
      '[data-testid="paper-legacy-p1-arxiv"]',
    );
    expect(arxiv?.value).toBe("https://arxiv.org/abs/1");
  });

  it("asks the host for evidence once per paper", async () => {
    const { loaded } = draw({ slots: {} });
    await Promise.resolve();
    expect(loaded).toEqual(["p1"]);
  });

  it("marks a bad link and leaves the value in place to be fixed", () => {
    const { container } = draw();
    type(container, "paper-legacy-p1-arxiv", "http://arxiv.org/abs/1");
    const error = container.querySelector('[data-testid="paper-legacy-error-p1-arxiv"]');
    expect(error).not.toBeNull();
    const arxiv = container.querySelector<HTMLInputElement>(
      '[data-testid="paper-legacy-p1-arxiv"]',
    );
    expect(arxiv?.value).toBe("http://arxiv.org/abs/1");
  });

  it("renders a derived slot as a fact rather than a control that would do nothing", () => {
    const { container } = draw();
    // x_draft's status is read off paper_social_drafts and the service rejects a direct write.
    const derived = container.querySelector('[data-testid="paper-legacy-p1-x_draft"]');
    expect(derived?.tagName).toBe("SPAN");
  });
});

describe("collectLegacyWrites", () => {
  it("sends nothing when nothing was typed", () => {
    const state = emptyPaperLegacyState();
    expect(collectLegacyWrites(state, paper(), cycle())).toEqual({ record: null, slots: [] });
  });

  it("routes a record field to the paper write and a slot to its own", () => {
    const state = emptyPaperLegacyState();
    state.edits.set(
      "p1",
      new Map([
        ["title", "A better title"],
        ["arxiv", "https://arxiv.org/abs/2401.00001"],
      ]),
    );
    const writes = collectLegacyWrites(state, paper(), cycle());
    expect(writes.record?.title).toBe("A better title");
    // Untouched record fields ride along, because upsertPaper takes the whole record.
    expect(writes.record?.authors).toEqual(["Ada Lovelace", "Bob Coauthor"]);
    expect(writes.slots).toEqual([
      { slot: "arxiv", input: { url: "https://arxiv.org/abs/2401.00001" } },
    ]);
  });

  // The controller reads `isArchival === "true"`. This form used to send "yes", so renaming an
  // archival paper quietly recorded it as non-archival.
  it("keeps an archival paper archival when another field is saved", () => {
    const state = emptyPaperLegacyState();
    state.edits.set("p1", new Map([["title", "Renamed"]]));
    const writes = collectLegacyWrites(state, paper({ is_archival: true }), cycle());
    expect(writes.record?.isArchival).toBe("true");
  });

  // An older record holds the track in `presentation_type`. The write splits it: the track goes to
  // its own field and the format, which that record never had, goes out blank.
  it("splits a combined track into its own field", () => {
    const state = emptyPaperLegacyState();
    state.edits.set("p1", new Map([["title", "Renamed"]]));
    const writes = collectLegacyWrites(state, paper({ presentation_type: "findings" }), cycle());
    expect(writes.record?.publicationTrack).toBe("findings");
    expect(writes.record?.presentationType).toBe("");
  });

  it("sends no slot writes when only the record changed", () => {
    const state = emptyPaperLegacyState();
    state.edits.set("p1", new Map([["title", "Renamed"]]));
    // The whole reason the slots are diffed: a typo fix in the title must not fire 24 requests.
    expect(collectLegacyWrites(state, paper(), cycle()).slots).toEqual([]);
  });

  it("holds back a field that failed validation and still sends the rest", () => {
    const state = emptyPaperLegacyState();
    state.edits.set(
      "p1",
      new Map([
        ["arxiv", "not-a-url"],
        ["poster", "https://drive.google.com/file/d/x"],
      ]),
    );
    const writes = collectLegacyWrites(state, paper(), cycle());
    expect(writes.slots.map((write) => write.slot)).toEqual(["poster"]);
  });

  it("writes a boolean slot as done rather than as text", () => {
    const state = emptyPaperLegacyState();
    state.edits.set("p1", new Map([["fixes_merged", "yes"]]));
    expect(collectLegacyWrites(state, paper(), cycle()).slots).toEqual([
      { slot: "fixes_merged", input: { done: true } },
    ]);
  });

  it("carries the poster's free-text note alongside its state", () => {
    const state = emptyPaperLegacyState();
    state.edits.set(
      "p1",
      new Map([
        ["poster_physical", "printed"],
        ["poster_physical__note", "In the lab cupboard"],
      ]),
    );
    expect(collectLegacyWrites(state, paper(), cycle()).slots).toEqual([
      {
        slot: "poster_physical",
        input: { value_text: "printed", value_note: "In the lab cupboard" },
      },
    ]);
  });

  it("never writes a derived slot, whose status comes from the drafts", () => {
    const state = emptyPaperLegacyState();
    state.edits.set("p1", new Map([["x_draft", "yes"]]));
    expect(collectLegacyWrites(state, paper(), cycle()).slots).toEqual([]);
  });

  it("holds a half-typed year back rather than deciding the paper with it", () => {
    const state = emptyPaperLegacyState();
    state.edits.set(
      "p1",
      new Map([
        ["title", "Renamed"],
        ["acceptedYear", "20"],
      ]),
    );
    const writes = collectLegacyWrites(state, paper(), cycle());
    // The title still saves; the year is left off rather than sent as a decision about the paper.
    expect(writes.record?.title).toBe("Renamed");
    expect(writes.record?.acceptedYear).toBeUndefined();
  });
});

describe("saving from the form", () => {
  it("sends both halves on Save and clears what went out", () => {
    const drawn = draw();
    type(drawn.container, "paper-legacy-p1-title", "Renamed");
    type(drawn.container, "paper-legacy-p1-arxiv", "https://arxiv.org/abs/2401.00002");
    drawn.container
      .querySelector<HTMLButtonElement>('[data-testid="paper-legacy-save-p1"]')
      ?.click();
    expect(drawn.saved.at(-1)?.title).toBe("Renamed");
    expect(drawn.slotWrites).toEqual([
      { paperId: "p1", slot: "arxiv", input: { url: "https://arxiv.org/abs/2401.00002" } },
    ]);
    expect(drawn.state.edits.get("p1")?.size ?? 0).toBe(0);
  });

  it("keeps a refused value after a save, so it can be seen and fixed", () => {
    const drawn = draw();
    type(drawn.container, "paper-legacy-p1-arxiv", "nope");
    drawn.container
      .querySelector<HTMLButtonElement>('[data-testid="paper-legacy-save-p1"]')
      ?.click();
    expect(drawn.slotWrites).toEqual([]);
    expect(drawn.state.edits.get("p1")?.get("arxiv")).toBe("nope");
  });
});

describe("minimizing a paper", () => {
  const card = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLElement>(`[data-testid="paper-legacy-paper-${id}"]`)!;
  const heading = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLButtonElement>(`[data-testid="paper-legacy-collapse-${id}"]`)!;
  const form = (container: HTMLElement, id: string) => card(container, id).querySelector("form");

  // The promise of this view is every field on one page, so it cannot arrive folded up.
  it("opens every paper", () => {
    const drawn = draw({ papers: [paper(), paper({ id: "p2" })] });
    expect(form(drawn.container, "p1")).not.toBeNull();
    expect(form(drawn.container, "p2")).not.toBeNull();
    expect(heading(drawn.container, "p1").getAttribute("aria-expanded")).toBe("true");
  });

  it("folds the card away on a click, and opens it again on the next one", () => {
    const drawn = draw();
    heading(drawn.container, "p1").click();
    expect(form(drawn.container, "p1")).toBeNull();
    expect(card(drawn.container, "p1").classList.contains("paper-legacy__paper--collapsed")).toBe(
      true,
    );
    expect(heading(drawn.container, "p1").getAttribute("aria-expanded")).toBe("false");

    heading(drawn.container, "p1").click();
    expect(form(drawn.container, "p1")).not.toBeNull();
    expect(heading(drawn.container, "p1").getAttribute("aria-expanded")).toBe("true");
  });

  // The one thing that would make a clickable card unusable: the form is inside the card, so
  // neither a click on a field nor one that missed a field may fold the paper away.
  it("leaves an open card open for a click anywhere but the heading", () => {
    const drawn = draw();
    drawn.container
      .querySelector<HTMLInputElement>('[data-testid="paper-legacy-p1-title"]')!
      .click();
    expect(drawn.state.collapsed.has("p1")).toBe(false);

    // The card's own padding -- the gap beside a field, the space under the last row.
    card(drawn.container, "p1").click();
    expect(form(drawn.container, "p1")).not.toBeNull();
    expect(drawn.state.collapsed.has("p1")).toBe(false);
  });

  // Nothing is left inside a folded card to click instead, and one line is a small target.
  it("opens a folded card from anywhere on it", () => {
    const drawn = draw();
    heading(drawn.container, "p1").click();
    card(drawn.container, "p1").click();
    expect(form(drawn.container, "p1")).not.toBeNull();
    expect(drawn.state.collapsed.has("p1")).toBe(false);
  });

  it("folds one paper without touching the rest", () => {
    const drawn = draw({
      papers: [paper(), paper({ id: "p2", title: "Second paper" })],
      slots: { p1: cycle(), p2: cycle() },
    });
    heading(drawn.container, "p1").click();
    expect(form(drawn.container, "p1")).toBeNull();
    expect(form(drawn.container, "p2")).not.toBeNull();
  });

  // Folding a paper away to get at the next one should not cost the line that says where it stands.
  it("keeps the step on a folded card", () => {
    const drawn = draw();
    heading(drawn.container, "p1").click();
    expect(card(drawn.container, "p1").textContent).toContain("Overleaf");
  });

  // The form leaves the page when the card folds, and a debounce still counting down would go with
  // it. What was typed is in state rather than in the input, so the write is still there to make.
  it("saves a pending edit on the way down", () => {
    const drawn = draw();
    type(drawn.container, "paper-legacy-p1-title", "Renamed");
    heading(drawn.container, "p1").click();
    expect(drawn.saved.at(-1)?.title).toBe("Renamed");
  });
});

describe("folding one section of a paper", () => {
  const band = (container: HTMLElement, id: string, group: string) =>
    container.querySelector<HTMLElement>(`[data-testid="paper-legacy-group-${id}-${group}"]`)!;
  const heading = (container: HTMLElement, id: string, group: string) =>
    container.querySelector<HTMLButtonElement>(
      `[data-testid="paper-legacy-group-toggle-${id}-${group}"]`,
    )!;
  const rows = (container: HTMLElement, id: string, group: string) =>
    band(container, id, group).querySelector(".profile__field-grid");

  // Same promise as the cards: everything is on the page until the reader says otherwise.
  it("opens every section", () => {
    const drawn = draw();
    for (const group of legacyGroups()) {
      expect(rows(drawn.container, "p1", group.id)).not.toBeNull();
      expect(heading(drawn.container, "p1", group.id).getAttribute("aria-expanded")).toBe("true");
    }
  });

  it("hides that section's rows on a click, and brings them back on the next one", () => {
    const drawn = draw();
    heading(drawn.container, "p1", "venue").click();
    expect(rows(drawn.container, "p1", "venue")).toBeNull();
    expect(
      band(drawn.container, "p1", "venue").classList.contains("paper-legacy__group--collapsed"),
    ).toBe(true);
    expect(heading(drawn.container, "p1", "venue").getAttribute("aria-expanded")).toBe("false");

    heading(drawn.container, "p1", "venue").click();
    expect(rows(drawn.container, "p1", "venue")).not.toBeNull();
    expect(heading(drawn.container, "p1", "venue").getAttribute("aria-expanded")).toBe("true");
  });

  it("leaves the sections beside it alone", () => {
    const drawn = draw();
    heading(drawn.container, "p1", "venue").click();
    expect(rows(drawn.container, "p1", "project")).not.toBeNull();
    expect(rows(drawn.container, "p1", "slots-core")).not.toBeNull();
  });

  // Per paper, not per section name: folding Venue away on one paper must not fold it on the
  // nine below it, which is the whole reason the key carries the paper id.
  it("folds one paper's section without touching the same section on another", () => {
    const drawn = draw({
      papers: [paper(), paper({ id: "p2", title: "Second paper" })],
      slots: { p1: cycle(), p2: cycle() },
    });
    heading(drawn.container, "p1", "venue").click();
    expect(rows(drawn.container, "p1", "venue")).toBeNull();
    expect(rows(drawn.container, "p2", "venue")).not.toBeNull();
  });

  // The heading is inside the form, so a click on it must not also fold the paper away.
  it("leaves the card itself open", () => {
    const drawn = draw();
    heading(drawn.container, "p1", "venue").click();
    expect(drawn.state.collapsed.has("p1")).toBe(false);
    expect(band(drawn.container, "p1", "project")).not.toBeNull();
  });

  // What a folded band is still worth saying. Project carries six fields and this paper answers
  // three of them: a title, its authors, and the step it is on.
  it("says how much of a folded section is answered", () => {
    const drawn = draw();
    heading(drawn.container, "p1", "project").click();
    const count = drawn.container.querySelector(
      '[data-testid="paper-legacy-group-count-p1-project"]',
    );
    expect(count?.textContent?.replace(/\s+/gu, " ").trim()).toBe("3 of 6 filled");
  });

  // The rows leave the page when the band folds, and a debounce still counting down would go with
  // them. Same flush the card makes on the way down.
  it("sends what was typed in the section before it folds", () => {
    const drawn = draw();
    type(drawn.container, "paper-legacy-p1-title", "Renamed");
    heading(drawn.container, "p1", "project").click();
    expect(drawn.saved.at(-1)?.title).toBe("Renamed");
  });
});

describe("the card's own controls", () => {
  function drawWithExtras(): Drawn & { rerender: () => void } {
    document.body.replaceChildren();
    const state = emptyPaperLegacyState();
    const container = document.createElement("div");
    document.body.append(container);
    const props = {
      state,
      papers: [paper()],
      slots: { p1: cycle() },
      onSavePaper: () => {},
      onSaveSlot: () => {},
      onChange: () => render(renderPaperLegacy(props), container),
      onExit: () => {},
      renderPaperExtras: (record: AdminBotPaperRecord) => ({
        top: html`<p data-testid=${`top-${record.id}`}></p>`,
        bottom: html`<p data-testid=${`bottom-${record.id}`}></p>`,
      }),
    };
    const rerender = () => render(renderPaperLegacy(props), container);
    rerender();
    return { container, state, saved: [], slotWrites: [], loaded: [], exits: 0, rerender };
  }

  it("draws them above and below the form", () => {
    const { container } = drawWithExtras();
    const top = container.querySelector('[data-testid="top-p1"]');
    const form = container.querySelector(".profile__form");
    const bottom = container.querySelector(
      '[data-testid="paper-legacy-extras-p1"] [data-testid="bottom-p1"]',
    );
    expect(top && form && bottom).toBeTruthy();
    expect(top!.compareDocumentPosition(form!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(form!.compareDocumentPosition(bottom!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // A folded card is one line; its controls fold with it.
  it("folds them away with the card", () => {
    const drawn = drawWithExtras();
    drawn.state.collapsed.add("p1");
    drawn.rerender();
    expect(drawn.container.querySelector('[data-testid="top-p1"]')).toBeNull();
    expect(drawn.container.querySelector('[data-testid="bottom-p1"]')).toBeNull();
  });
});
