// My Projects & Papers: the card list, what a closed card says, and the global nudge above it.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";
import type { PaperCycle, PaperNudgeBatch, PaperSlotOverviewRow } from "../auth/session.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import { renderMyWork, type MyWorkProps } from "./my-work.ts";

function paper(overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "Causal abstraction",
    authors: ["Ada Lovelace"],
    current_step: "overleaf_writing",
    submitted_by_member_id: "ada",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function batch(fields: Partial<PaperNudgeBatch> = {}): PaperNudgeBatch {
  return {
    member_id: "ada",
    member_name: "Ada Lovelace",
    deliverable: true,
    item_count: 2,
    paper_titles: ["Causal abstraction"],
    message: "*Causal abstraction* still needs:\n\u2022 Talk slides",
    ...fields,
  };
}

function overviewRow(overrides: Partial<PaperSlotOverviewRow> = {}): PaperSlotOverviewRow {
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

type DrawOptions = {
  papers?: AdminBotPaperRecord[];
  overview?: PaperSlotOverviewRow[];
  slots?: Record<string, PaperCycle>;
  openIds?: string[];
  canNudge?: boolean;
  nudging?: boolean;
  nudgeBatches?: PaperNudgeBatch[] | null;
  nudgeSelected?: string[];
  notice?: string | null;
  error?: string | null;
};

function draw(options: DrawOptions = {}) {
  const toggled: string[] = [];
  const nudges: number[] = [];
  const reviews: number[] = [];
  const picked: string[] = [];
  const state = {
    memberId: "ada",
    adminBotData: {
      papers: options.papers ?? [paper()],
      members: [],
      settings: {},
    },
    myWorkBlockerDraft: null,
    myWorkProjectDraft: null,
  } as unknown as AppViewState;
  const props: MyWorkProps = {
    onSavePaper: () => {},
    overview: options.overview ?? [overviewRow()],
    slots: options.slots ?? {},
    openIds: options.openIds ?? [],
    slotsBusyId: null,
    slotsError: options.error ?? null,
    slotsNotice: options.notice ?? null,
    nudging: options.nudging ?? false,
    canNudge: options.canNudge ?? true,
    nudgeBatches: options.nudgeBatches ?? null,
    nudgeLoading: false,
    nudgeSelected: options.nudgeSelected ?? [],
    onReviewNudges: () => reviews.push(1),
    onToggleNudgeRecipient: (id: string) => picked.push(id),
    onToggleCard: (id) => toggled.push(id),
    onSaveSlot: () => {},
    onNudgeAuthors: () => nudges.push(1),
    memberId: "ada",
    memberName: (id: string) => id,
    onSaveDraft: () => {},
    onCirculateDraft: () => {},
    onConsent: () => {},
    onSetAttendee: () => {},
    onSetReimbursement: () => {},
  };
  const container = document.createElement("div");
  document.body.append(container);
  render(renderMyWork(state, props), container);
  return { container, toggled, nudges, reviews, picked };
}

describe("renderMyWork", () => {
  it("opens as a list of cards with the form closed", () => {
    const { container } = draw();
    expect(container.querySelector('[data-testid="my-work-item-p1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="paper-slots-p1"]')).toBeNull();
  });

  it("puts the whole head in the toggle, not a chevron off to one side", () => {
    const { container, toggled } = draw();
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="my-work-toggle-p1"]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    // The title lives inside the button, so pointing at the paper is pointing at the control.
    expect(toggle?.textContent).toContain("Causal abstraction");
    toggle?.click();
    expect(toggled).toEqual(["p1"]);
  });

  it("shows the checklist once the card is open", () => {
    const { container } = draw({ openIds: ["p1"] });
    expect(container.querySelector('[data-testid="paper-slots-p1"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="my-work-toggle-p1"]')?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="my-work-item-p1"]')?.hasAttribute("data-open"),
    ).toBe(true);
  });

  it("keeps the panel in the DOM so aria-controls always resolves", () => {
    // Open or closed, the id the toggle points at has to exist -- a control referencing a missing
    // element is a broken announcement, not a hidden one.
    for (const openIds of [[], ["p1"]]) {
      const { container } = draw({ openIds });
      const toggle = container.querySelector('[data-testid="my-work-toggle-p1"]');
      const panelId = toggle?.getAttribute("aria-controls") ?? "";
      const panel = container.querySelector(`[id="${panelId}"]`);
      expect(panelId).toBe("my-work-body-p1");
      expect(container.querySelectorAll(".my-work-item__body")).toHaveLength(1);
      expect(panel).not.toBeNull();
      expect(panel?.hasAttribute("hidden")).toBe(openIds.length === 0);
    }
  });

  it("keeps the card head to phrasing content, which is all a button may hold", () => {
    const { container } = draw({
      overview: [overviewRow({ venue: "ICLR 2027", deadline: "2026-09-24" })],
    });
    const toggle = container.querySelector('[data-testid="my-work-toggle-p1"]');
    // Browsers cope with a <div> or a <p> in here, but it is invalid and assistive technology is
    // entitled to treat it as such.
    expect(
      toggle?.querySelectorAll("div, p, h1, h2, h3, h4, ul, ol, section, article"),
    ).toHaveLength(0);
  });

  it("summarises a closed card with the count and what is outstanding, not a bare percentage", () => {
    const { container } = draw();
    const head = container.querySelector('[data-testid="my-work-toggle-p1"]');
    expect(head?.textContent).toContain("3/21");
    expect(head?.textContent).toContain("1 outstanding");
  });

  it("says so when a paper has everything in", () => {
    const { container } = draw({
      overview: [overviewRow({ provided_count: 21, missing_slots: [] })],
    });
    expect(container.textContent).toContain("Everything is in");
  });

  it("carries the venue and its deadline as the card's subtitle", () => {
    const { container } = draw({
      overview: [overviewRow({ venue: "ICLR 2027", deadline: "2026-09-24" })],
    });
    const head = container.querySelector('[data-testid="my-work-toggle-p1"]');
    expect(head?.textContent).toContain("ICLR 2027");
    expect(head?.textContent).toContain("2026-09-24");
  });

  it("counts only live papers with something outstanding on the review button", () => {
    const { container, reviews } = draw({
      papers: [paper(), paper({ id: "p2", title: "Second" })],
      overview: [overviewRow(), overviewRow({ paper_id: "p2", dormant: true })],
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="my-work-review-nudges"]',
    );
    expect(button?.textContent).toContain("1");
    button?.click();
    // Opening the preview sends nothing -- that is the whole point of the manual flow.
    expect(reviews).toEqual([1]);
  });

  it("sends nothing until the preview is open and Send is pressed", () => {
    const closed = draw();
    expect(closed.container.querySelector('[data-testid="my-work-nudge-authors"]')).toBeNull();

    const open = draw({ nudgeBatches: [batch()], nudgeSelected: ["ada"] });
    const send = open.container.querySelector<HTMLButtonElement>(
      '[data-testid="my-work-nudge-authors"]',
    );
    expect(send).not.toBeNull();
    send?.click();
    expect(open.nudges).toEqual([1]);
  });

  it("shows the message verbatim, so somebody reads what goes out under their name", () => {
    const { container } = draw({
      nudgeBatches: [batch({ message: "*Causal abstraction* still needs:\n• Talk slides" })],
      nudgeSelected: ["ada"],
    });
    expect(container.querySelector(".nudge-preview__message")?.textContent).toContain(
      "• Talk slides",
    );
  });

  it("shows an unreachable person, unticked and unticking", () => {
    // "We cannot reach this person" is worth seeing when you are wondering why they never answer.
    const { container } = draw({
      nudgeBatches: [batch({ member_id: "bob", member_name: "Bob", deliverable: false })],
      nudgeSelected: [],
    });
    const pick = container.querySelector<HTMLInputElement>('[data-testid="nudge-pick-bob"]');
    expect(pick?.disabled).toBe(true);
    expect(container.textContent).toContain("No Slack account on file");
  });

  it("will not send with nobody ticked", () => {
    const { container } = draw({ nudgeBatches: [batch()], nudgeSelected: [] });
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="my-work-nudge-authors"]')?.disabled,
    ).toBe(true);
  });

  it("lets an admin drop one person from this round", () => {
    const { container, picked } = draw({ nudgeBatches: [batch()], nudgeSelected: ["ada"] });
    container.querySelector<HTMLInputElement>('[data-testid="nudge-pick-ada"]')?.click();
    expect(picked).toEqual(["ada"]);
  });

  it("disables the review button rather than hiding it when the lab is caught up", () => {
    const { container } = draw({ overview: [overviewRow({ missing_slots: [] })] });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="my-work-review-nudges"]',
    );
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
  });

  it("keeps the global nudge off a member's page -- it messages the whole lab", () => {
    const { container } = draw({ canNudge: false });
    expect(container.querySelector('[data-testid="my-work-review-nudges"]')).toBeNull();
    expect(container.querySelector('[data-testid="my-work-nudge-authors"]')).toBeNull();
  });

  it("shows what the last nudge run did, and any failure, above the list", () => {
    const { container } = draw({
      notice: "Nudged 2 authors.",
      error: "Could not reach AdminBot.",
    });
    expect(container.querySelector(".my-work__notice-line")?.textContent).toContain("Nudged 2");
    expect(container.querySelector(".my-work__error-line")?.textContent).toContain("Could not");
  });
});
