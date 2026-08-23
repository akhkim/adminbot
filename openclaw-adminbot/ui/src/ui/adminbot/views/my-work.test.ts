// My Projects & Papers: the card list, what a closed card says, and the global nudge above it.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";
import type { PaperCycle, PaperNudgeBatch, PaperSlotOverviewRow } from "../auth/session.ts";
import type { AdminBotPaperRecord, AdminBotPaperSaveInput } from "../controllers/admin.ts";
import { renderMyWork, type MyWorkProps, ownPapers } from "./my-work.ts";

// The draft dialog is imperative and talks to AdminBot, so the interesting assertion is what the
// card hands it, not what it renders.
const openDraft = vi.fn();
vi.mock("../linkedin-draft-dialog.ts", () => ({
  openLinkedInDraftDialog: (...args: unknown[]) => openDraft(...args),
}));

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
  /** Passed straight through as MyWorkProps.papers -- the Active Papers scoping. */
  scopedPapers?: AdminBotPaperRecord[];
  title?: string;
  projectDraft?: string | null;
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
  const saved: AdminBotPaperSaveInput[] = [];
  const state = {
    memberId: "ada",
    adminBotData: {
      papers: options.papers ?? [paper()],
      members: [],
      settings: {},
    },
    settings: { adminBotUrl: "https://admin.safe.eu" },
    myWorkBlockerDraft: null,
    myWorkProjectDraft: options.projectDraft ?? null,
  } as unknown as AppViewState;
  const props: MyWorkProps = {
    onSavePaper: (input: AdminBotPaperSaveInput) => saved.push(input),
    ...(options.scopedPapers ? { papers: options.scopedPapers } : {}),
    ...(options.title ? { title: options.title } : {}),
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
  return { container, toggled, nudges, reviews, picked, saved };
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

describe("ownPapers — whose paper is it", () => {
  function stateWith(authors: string[], memberName: string) {
    return {
      memberId: "me",
      adminBotData: {
        members: [{ id: "me", name: memberName, privilege_level: "member", access: [] }],
        papers: [
          {
            id: "p1",
            title: "Preserving Historical Truth",
            authors,
            current_step: "arxiv_polish",
            submitted_by_member_id: "someone-else",
          },
        ],
      },
    } as never;
  }

  it("finds a paper where the author list marks equal contribution", () => {
    // Regression: a co-first author could not see their own paper, because the venue's asterisk
    // made the name compare unequal to the roster's.
    const papers = ownPapers(stateWith(["Francesco Ortu*", "Joeun Yook*"], "Joeun Yook"));
    expect(papers.map((p) => p.title)).toEqual(["Preserving Historical Truth"]);
  });

  it("finds a paper listing the name with an accent the roster omits", () => {
    expect(ownPapers(stateWith(["Bernhard Schölkopf"], "Bernhard Scholkopf"))).toHaveLength(1);
  });

  it("does not claim somebody else's paper", () => {
    expect(ownPapers(stateWith(["Andrew Yook", "Jane Doe"], "Joeun Yook"))).toHaveLength(0);
  });
});

describe("target venue", () => {
  const year = new Date().getUTCFullYear();

  // jsdom does not re-run the select's reset steps when lit stamps `selected` onto an option, so
  // `select.value` reads as whatever the last option is. The attribute is what the browser acts
  // on, so that is what these assert.
  function chosen(select: HTMLSelectElement | null) {
    return [...(select?.options ?? [])].find((option) => option.hasAttribute("selected"))?.value;
  }

  function selects(container: Element) {
    return {
      year: container.querySelector<HTMLSelectElement>('[data-testid="target-venue-year-p1"]'),
      venue: container.querySelector<HTMLSelectElement>('[data-testid="target-venue-p1"]'),
    };
  }

  it("splits the target into a year and a venue, grouped by whether it is archival", () => {
    const { container } = draw({ openIds: ["p1"] });
    const { year: yearSelect, venue } = selects(container);
    expect([...(yearSelect?.options ?? [])].map((option) => option.value)).toEqual([
      String(year - 1),
      String(year),
      String(year + 1),
      String(year + 2),
    ]);
    const groups = [...(venue?.querySelectorAll("optgroup") ?? [])].map((group) => group.label);
    expect(groups).toEqual(["Archival", "Non-archival"]);
    expect([...(venue?.options ?? [])].map((option) => option.value)).toContain("EMNLP-main");
    expect([...(venue?.options ?? [])].map((option) => option.value)).toContain("ICLR-workshop");
  });

  it("opens on what the paper already names", () => {
    const { container } = draw({
      openIds: ["p1"],
      papers: [paper({ artifacts: { conference: "ACL 2027 (demo)" } })],
    });
    const { year: yearSelect, venue } = selects(container);
    expect(chosen(yearSelect)).toBe("2027");
    expect(chosen(venue)).toBe("ACL-demo");
  });

  it("writes the two selects back as one venue string", () => {
    const { container, saved } = draw({
      openIds: ["p1"],
      papers: [paper({ artifacts: { conference: "ACL 2027 (demo)", confidence: "50" } })],
    });
    const { year: yearSelect, venue } = selects(container);
    yearSelect!.value = "2027";
    venue!.value = "NeurIPS";
    venue!.dispatchEvent(new Event("change"));
    expect(saved.at(-1)?.conference).toBe("NeurIPS 2027");
    // Moving the year alone keeps the venue: a slipped paper is the common edit here.
    yearSelect!.value = String(year + 2);
    yearSelect!.dispatchEvent(new Event("change"));
    expect(saved.at(-1)?.conference).toBe(`NeurIPS ${year + 2}`);
    expect(saved.at(-1)?.confidence).toBe("50");
  });

  it("keeps a venue the list cannot name rather than retargeting the paper", () => {
    // Targets written before this list existed came from the deadline board, in its wording.
    const { container, saved } = draw({
      openIds: ["p1"],
      papers: [paper({ artifacts: { conference: "EMNLP 2026 (system demonstrations)" } })],
    });
    const { year: yearSelect, venue } = selects(container);
    expect(chosen(venue)).toBe("EMNLP 2026 (system demonstrations)");
    // Editing the year around it must not rewrite a venue this list cannot spell.
    venue!.value = "EMNLP 2026 (system demonstrations)";
    yearSelect!.value = String(year + 1);
    yearSelect!.dispatchEvent(new Event("change"));
    expect(saved.at(-1)?.conference).toBe("EMNLP 2026 (system demonstrations)");
  });

  it("offers the same two selects when registering a paper", () => {
    const { container, saved } = draw({ projectDraft: "Causal abstraction" });
    const form = container.querySelector<HTMLFormElement>("#my-work-add-form");
    const venue = container.querySelector<HTMLSelectElement>('[data-testid="register-venue"]');
    const yearSelect = container.querySelector<HTMLSelectElement>(
      '[data-testid="register-venue-year"]',
    );
    expect(venue).not.toBeNull();
    yearSelect!.value = String(year + 1);
    venue!.value = "COLM-workshop";
    form?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(saved.at(-1)?.conference).toBe(`COLM ${year + 1} (workshop)`);
  });
});

describe("draft the LinkedIn post", () => {
  it("hands the dialog the console's configured AdminBot URL", () => {
    // Regression: the button called the dialog with no settings, so it resolved the service from
    // this page's own hostname and every draft failed as "AdminBot is not reachable".
    openDraft.mockClear();
    const { container } = draw({ openIds: ["p1"] });
    container.querySelector<HTMLButtonElement>('[data-testid="my-work-linkedin-p1"]')?.click();
    expect(openDraft).toHaveBeenCalledTimes(1);
    expect(openDraft.mock.calls[0][1]).toEqual({
      settings: { adminBotUrl: "https://admin.safe.eu" },
    });
  });
});

describe("finished papers", () => {
  const done = { completed_at: "2026-07-14T18:03:11.000Z" };

  it("keeps the completed ones out of the live list, in their own disclosure", () => {
    const { container } = draw({
      papers: [
        paper({ id: "p1", title: "Causal abstraction" }),
        paper({ id: "p2", title: "Shipped last summer", artifacts: done }),
      ],
      overview: [
        overviewRow({ paper_id: "p1" }),
        overviewRow({ paper_id: "p2", title: "Shipped last summer" }),
      ],
    });
    const live = container.querySelector(".my-work__items");
    expect(live?.querySelector('[data-testid="my-work-item-p1"]')).not.toBeNull();
    expect(live?.querySelector('[data-testid="my-work-item-p2"]')).toBeNull();
    const bucket = container.querySelector('[data-testid="my-work-completed"]');
    expect(bucket?.querySelector('[data-testid="my-work-item-p2"]')).not.toBeNull();
    // The heading counts them, so a collapsed disclosure still says how much is in there.
    expect(bucket?.querySelector("summary")?.textContent).toContain("(1)");
  });

  it("marks a finished card as finished even while it is closed", () => {
    const { container } = draw({ papers: [paper({ artifacts: done })] });
    expect(container.querySelector('[data-testid="my-work-done-badge-p1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="my-work-item-p1"]')?.className).toContain(
      "my-work-item--done",
    );
  });

  it("stamps the paper when the author says they presented it", () => {
    const { container, saved } = draw({
      openIds: ["p1"],
      papers: [paper({ venue_decision: "accept" })],
    });
    const button = container.querySelector<HTMLButtonElement>('[data-testid="paper-complete-p1"]');
    expect(button?.disabled).toBe(false);
    button?.click();
    expect(saved.at(-1)?.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it("refuses, with a reason, until a venue has accepted", () => {
    const { container } = draw({ openIds: ["p1"], papers: [paper()] });
    const button = container.querySelector<HTMLButtonElement>('[data-testid="paper-complete-p1"]');
    expect(button?.disabled).toBe(true);
    expect(container.querySelector(".paper-completion__why")?.textContent).toMatch(/accepted/i);
  });

  it("reopens by clearing the stamp, not by deleting the key", () => {
    // "" has to reach the service: an omitted field is a field the merge leaves alone, which
    // would make Reopen a button that does nothing.
    const { container, saved } = draw({
      openIds: ["p1"],
      papers: [paper({ venue_decision: "accept", artifacts: done })],
    });
    container.querySelector<HTMLButtonElement>('[data-testid="paper-reopen-p1"]')?.click();
    expect(saved.at(-1)?.completedAt).toBe("");
  });
});

describe("who may chase the lab", () => {
  it("keeps the whole nudge surface off a member's page, preview included", () => {
    // The preview is the sensitive half: it names everyone who owes something and quotes the
    // message. Reaching it needs the admin-only button, but it refuses on its own too.
    const { container } = draw({ canNudge: false, nudgeBatches: [batch()] });
    expect(container.querySelector('[data-testid="my-work-review-nudges"]')).toBeNull();
    expect(container.querySelector('[data-testid="my-work-nudge-preview"]')).toBeNull();
    expect(container.querySelector('[data-testid="my-work-nudge-authors"]')).toBeNull();
  });

  it("still shows it to an admin", () => {
    const { container } = draw({ canNudge: true, nudgeBatches: [batch()] });
    expect(container.querySelector('[data-testid="my-work-nudge-preview"]')).not.toBeNull();
  });
});

describe("Active Papers draws the same workspace", () => {
  it("renders the papers it is handed, not just the viewer's own", () => {
    // The member owns nothing here: `papers` is the whole lab, which is what the admin tab passes.
    const notMine = paper({
      id: "p9",
      title: "Somebody else's paper",
      authors: ["Grace Hopper"],
      submitted_by_member_id: "someone-else",
    });
    const { container } = draw({
      papers: [],
      scopedPapers: [notMine],
      overview: [overviewRow({ paper_id: "p9", title: "Somebody else's paper" })],
      title: "All papers",
    });
    expect(container.querySelector('[data-testid="my-work-item-p9"]')).not.toBeNull();
    expect(container.querySelector(".my-work__section-title")?.textContent).toContain("All papers");
  });

  it("falls back to the viewer's own papers when no set is handed to it", () => {
    const { container } = draw({ papers: [paper({ id: "p1" })] });
    expect(container.querySelector('[data-testid="my-work-item-p1"]')).not.toBeNull();
    expect(container.querySelector(".my-work__section-title")?.textContent).not.toContain(
      "All papers",
    );
  });
});
