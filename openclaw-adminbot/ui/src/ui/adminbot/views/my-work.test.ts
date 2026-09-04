// My Projects & Papers: the card list, what a closed card says, and the global nudge above it.
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";
import type { PaperCycle, PaperNudgeBatch, PaperSlotOverviewRow } from "../auth/session.ts";
import type { AdminBotPaperRecord, AdminBotPaperSaveInput } from "../controllers/admin.ts";
import { renderMyWork, type MyWorkProps, ownPapers } from "./my-work.ts";

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
  /** Omitted by default, so the control's absence is the tested default rather than an accident. */
  onDeletePaper?: boolean;
  title?: string;
  projectDraft?: string | null;
  /** Omitted by default, so the checkbox's absence without a check state is the tested default. */
  channelCheck?: import("../controllers/admin.ts").SlackChannelCheck;
  overview?: PaperSlotOverviewRow[];
  slots?: Record<string, PaperCycle>;
  openIds?: string[];
  canNudge?: boolean;
  nudging?: boolean;
  nudgeBatches?: PaperNudgeBatch[] | null;
  nudgeSelected?: string[];
  notice?: string | null;
  error?: string | null;
  personal?: boolean;
  /** Reuse a state object across two draws, for the controls that keep a draft in view state. */
  state?: AppViewState;
};

function draw(options: DrawOptions = {}) {
  const channelToggles: boolean[] = [];
  // Every draw starts from an empty document. Containers used to pile up in `document.body`, and
  // an `#id` selector resolves through the document's id map before it checks containment -- so a
  // second card carrying the same id as an earlier test's found the earlier element, failed the
  // containment check and came back null.
  document.body.replaceChildren();
  const toggled: string[] = [];
  const nudges: number[] = [];
  const reviews: number[] = [];
  const picked: string[] = [];
  const saved: AdminBotPaperSaveInput[] = [];
  const deleted: string[] = [];
  const state =
    options.state ??
    ({
      memberId: "ada",
      adminBotData: {
        papers: options.papers ?? [paper()],
        members: [],
        settings: {},
      },
      settings: { adminBotUrl: "https://admin.safe.eu" },
      myWorkBlockerDraft: null,
      myWorkProjectDraft: options.projectDraft ?? null,
      myWorkProjectAlias: "",
      myWorkProjectError: null,
      myWorkProjectEdits: {},
      myWorkProjectVenues: [],
    } as unknown as AppViewState);
  const props: MyWorkProps = {
    onSavePaper: (input: AdminBotPaperSaveInput) => saved.push(input),
    ...(options.onDeletePaper
      ? { onDeletePaper: (record: AdminBotPaperRecord) => deleted.push(record.id) }
      : {}),
    ...(options.scopedPapers ? { papers: options.scopedPapers } : {}),
    ...(options.channelCheck
      ? {
          channelCheck: options.channelCheck,
          onChannelCheckToggle: (enabled: boolean) => channelToggles.push(enabled),
        }
      : {}),
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
    personal: options.personal ?? false,
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
  return {
    container,
    toggled,
    nudges,
    reviews,
    picked,
    saved,
    state,
    deleted,
    channelToggles,
    rerender: () => render(renderMyWork(state, props), container),
  };
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

  it("does not claim everything is in on a paper the lab has simply stopped chasing", () => {
    // The regression: `missing_slots` is empty for a rejected paper because nothing is nudged on
    // one, and the summary read that emptiness as completion -- so a paper with nothing on file
    // but a rejection logged announced "Everything is in".
    const { container } = draw({
      overview: [overviewRow({ provided_count: 0, closed: true, missing_slots: [] })],
    });
    expect(container.textContent).not.toContain("Everything is in");
    expect(container.textContent).toContain("Rejected");
  });

  it("says the work is waiting rather than done when nothing is chaseable yet", () => {
    const { container } = draw({
      overview: [overviewRow({ provided_count: 3, missing_slots: [] })],
    });
    expect(container.textContent).not.toContain("Everything is in");
    expect(container.textContent).toContain("Waiting on earlier steps");
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

  // The point of the recorded links: a paper one coauthor files shows up for all of them, whatever
  // the paper happens to call them.
  it("shows a coauthor a paper somebody else filed, by recorded link rather than by spelling", () => {
    const state = {
      memberId: "andrew-kim",
      adminBotData: {
        members: [{ id: "andrew-kim", name: "Andrew Kim", privilege_level: "member", access: [] }],
        papers: [
          {
            id: "adminbot",
            title: "AdminBot",
            // The printed list spells him a way the roster does not, and he did not file it.
            authors: ["Joeun Yook*", "A. K. Kim", "Zhijing Jin"],
            author_links: [
              { name: "Joeun Yook*", member_id: "joeun-yook" },
              { name: "A. K. Kim", member_id: "andrew-kim" },
              { name: "Zhijing Jin", member_id: "zhijing-jin" },
            ],
            current_step: "brainstorming_docs",
            submitted_by_member_id: "joeun-yook",
          },
        ],
      },
    } as never;
    expect(ownPapers(state).map((paper) => paper.title)).toEqual(["AdminBot"]);
  });

  it("does not show a paper to an external coauthor's address", () => {
    const state = {
      memberId: "bs@tue.mpg.de",
      adminBotData: {
        members: [{ id: "bs@tue.mpg.de", name: "Bernhard", privilege_level: "member", access: [] }],
        papers: [
          {
            id: "adminbot",
            title: "AdminBot",
            authors: ["Joeun Yook", "Bernhard Schölkopf"],
            // An external is an email on the paper, never a member id, so nothing keys off them.
            author_links: [
              { name: "Joeun Yook", member_id: "joeun-yook" },
              { name: "Bernhard Schölkopf", email: "bs@tue.mpg.de" },
            ],
            current_step: "brainstorming_docs",
            submitted_by_member_id: "joeun-yook",
          },
        ],
      },
    } as never;
    expect(ownPapers(state)).toHaveLength(0);
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
    // Three groups, not two: workshops are their own, because "is this archival" is a question the
    // CFP answers per workshop rather than something the catalog can state for the venue. The
    // ICLR-workshop assertion below has always depended on that group existing.
    const groups = [...(venue?.querySelectorAll("optgroup") ?? [])].map((group) => group.label);
    expect(groups).toEqual(["Archival", "Non-archival", "Workshops (check the CFP)"]);
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

  it("offers one conference select per row, the conference before the year", () => {
    const { container } = draw({ projectDraft: "Causal abstraction" });
    // Regression: the form carried two selects sharing one form name, so FormData read the first
    // -- the one with no sensible default -- and the "defaults to the next deadline" hint below
    // it was never true.
    expect(container.querySelectorAll('[data-testid^="register-venue-"]').length).toBeGreaterThan(
      0,
    );
    const row = container.querySelector('[data-testid="register-venue-row-0"]');
    const order = [...(row?.querySelectorAll("select") ?? [])].map((select) =>
      select.getAttribute("data-testid"),
    );
    expect(order).toEqual(["register-venue-0", "register-venue-year-0", "register-venue-odds-0"]);
  });

  /**
   * Fill the two answers the create form insists on.
   *
   * The alias becomes the project's Slack channel and the start date is a fact about the project
   * rather than about when it was typed in, so the form refuses without them -- these tests are
   * about venue rows, and would otherwise be blocked by a rule they are not testing.
   */
  function fillProjectBasics(container: Element) {
    const alias = container.querySelector<HTMLInputElement>('[data-testid="my-work-add-alias"]');
    const started = container.querySelector<HTMLInputElement>(
      '[data-testid="my-work-add-started-on"]',
    );
    alias!.value = "cais";
    started!.value = "2026-01-15";
  }

  // The alias is what the project's Slack channel gets named after, so it is collected when the
  // project is created rather than chased for afterwards.
  it("files the alias lowercased and the start date as typed", () => {
    const { container, saved } = draw({ projectDraft: "Causal AI Scientist" });
    const alias = container.querySelector<HTMLInputElement>('[data-testid="my-work-add-alias"]');
    const started = container.querySelector<HTMLInputElement>(
      '[data-testid="my-work-add-started-on"]',
    );
    // Typed the way a person says it; stored the way Slack needs it.
    alias!.value = "CAIS";
    started!.value = "2026-01-15";
    container
      .querySelector<HTMLFormElement>("#my-work-add-form")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));

    expect(saved.at(-1)?.alias).toBe("cais");
    expect(saved.at(-1)?.startedOn).toBe("2026-01-15");
  });

  // The reported bug: "if you try to add a new project where the title is the same as the short
  // name, it fails and no project is created". The short name is the thing at fault, not the match
  // -- copying the title into that box brings its punctuation and its length along, and neither can
  // be a Slack channel name. What made it a bug rather than a validation message is that the submit
  // handler returned without saying anything, so the member saw a filled-in form and no project.
  it.each([
    ["an apostrophe", "Bob's Project"],
    ["a colon", "Agents: a survey"],
    ["more than the alias limit", "A Very Long Project Title That Goes On"],
  ])("says why it refused a short name carrying %s", (_label, text) => {
    const { container, saved, rerender } = draw({ projectDraft: text });
    container.querySelector<HTMLInputElement>('[data-testid="my-work-add-alias"]')!.value = text;
    container.querySelector<HTMLInputElement>('[data-testid="my-work-add-started-on"]')!.value =
      "2026-01-15";
    container
      .querySelector<HTMLFormElement>("#my-work-add-form")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    rerender();

    expect(saved).toHaveLength(0);
    const error = container.querySelector('[data-testid="my-work-add-error"]');
    expect(error?.textContent ?? "").toContain("cannot be a Slack channel name");
  });

  // A title and a short name that happen to be the same word were never the problem, and still are
  // not: the pair below is what the reporter thought they were hitting.
  it("files a project whose title and short name are the same word", () => {
    const { container, saved } = draw({ projectDraft: "CAIS" });
    container.querySelector<HTMLInputElement>('[data-testid="my-work-add-alias"]')!.value = "CAIS";
    container.querySelector<HTMLInputElement>('[data-testid="my-work-add-started-on"]')!.value =
      "2026-01-15";
    container
      .querySelector<HTMLFormElement>("#my-work-add-form")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));

    expect(saved).toHaveLength(1);
    expect(saved.at(-1)).toMatchObject({ title: "CAIS", alias: "cais", id: "cais" });
    expect(container.querySelector('[data-testid="my-work-add-error"]')).toBeNull();
  });

  it("names the missing answer rather than doing nothing", () => {
    const { container, saved, rerender } = draw({ projectDraft: "Causal AI Scientist" });
    container
      .querySelector<HTMLFormElement>("#my-work-add-form")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    rerender();

    expect(saved).toHaveLength(0);
    expect(
      container.querySelector('[data-testid="my-work-add-error"]')?.textContent ?? "",
    ).toContain("short name");
  });

  // Both are conditions on creating the project, not fields to fill in later: a start date typed a
  // month afterwards is a guess, and a project with no alias has no channel name.
  it("refuses to file a project with no alias or no start date", () => {
    const { container, saved } = draw({ projectDraft: "Causal AI Scientist" });
    const form = container.querySelector<HTMLFormElement>("#my-work-add-form");
    form?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(saved).toHaveLength(0);

    // An alias Slack could not take is refused rather than quietly rewritten -- an author should
    // not discover what their channel was called afterwards.
    container.querySelector<HTMLInputElement>('[data-testid="my-work-add-alias"]')!.value =
      "C.A.I.S. v2";
    container.querySelector<HTMLInputElement>('[data-testid="my-work-add-started-on"]')!.value =
      "2026-01-15";
    form?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(saved).toHaveLength(0);
  });

  describe("the Slack channel already-exists check", () => {
    const check = (over: Partial<import("../controllers/admin.ts").SlackChannelCheck> = {}) => ({
      enabled: false,
      channels: null,
      loading: false,
      error: null,
      ...over,
    });
    const typeAlias = (container: HTMLElement, value: string, rerender: () => void) => {
      const input = container.querySelector<HTMLInputElement>('[data-testid="my-work-add-alias"]')!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      rerender();
    };

    it("is not offered when the page has no way to answer it", () => {
      const { container } = draw({ projectDraft: "Causal abstraction" });
      expect(container.querySelector('[data-testid="my-work-channel-exists"]')).toBeNull();
    });

    it("reports the tick so the channel names can be loaded", () => {
      const { container, channelToggles } = draw({
        projectDraft: "Causal abstraction",
        channelCheck: check(),
      });
      container.querySelector<HTMLInputElement>('[data-testid="my-work-channel-exists"]')!.click();
      expect(channelToggles).toEqual([true]);
    });

    it("confirms an alias that matches a real channel", () => {
      const { container, rerender } = draw({
        projectDraft: "Causal abstraction",
        channelCheck: check({ enabled: true, channels: ["proj-cais", "random-active"] }),
      });
      typeAlias(container, "CAIS", rerender);
      expect(container.querySelector('[data-testid="my-work-channel-check-ok"]')).not.toBeNull();
    });

    it("refuses a submit whose alias names no channel, and says what is near it", () => {
      const { container, saved, rerender } = draw({
        projectDraft: "Causal abstraction",
        channelCheck: check({ enabled: true, channels: ["proj-cais"] }),
      });
      typeAlias(container, "cais2", rerender);
      container.querySelector<HTMLInputElement>('[data-testid="my-work-add-started-on"]')!.value =
        "2026-01-15";
      const mismatch = container.querySelector('[data-testid="my-work-channel-check-mismatch"]');
      expect(mismatch?.textContent).toContain("proj-cais");

      container
        .querySelector<HTMLFormElement>("#my-work-add-form")
        ?.dispatchEvent(new Event("submit", { cancelable: true }));
      expect(saved).toHaveLength(0);
    });

    it("files the project when the box is ticked and the channel is there", () => {
      const { container, saved, rerender } = draw({
        projectDraft: "Causal abstraction",
        channelCheck: check({ enabled: true, channels: ["proj-cais"] }),
      });
      typeAlias(container, "cais", rerender);
      container.querySelector<HTMLInputElement>('[data-testid="my-work-add-started-on"]')!.value =
        "2026-01-15";
      container
        .querySelector<HTMLFormElement>("#my-work-add-form")
        ?.dispatchEvent(new Event("submit", { cancelable: true }));
      expect(saved).toHaveLength(1);
      expect(saved[0]?.alias).toBe("cais");
    });

    it("never blocks a submit when the lookup could not run", () => {
      // The failure this must not have: refusing a correct alias because Slack was unreachable.
      const { container, saved, rerender } = draw({
        projectDraft: "Causal abstraction",
        channelCheck: check({ enabled: true, channels: null, error: "Slack is unreachable." }),
      });
      typeAlias(container, "cais", rerender);
      container.querySelector<HTMLInputElement>('[data-testid="my-work-add-started-on"]')!.value =
        "2026-01-15";
      expect(
        container.querySelector('[data-testid="my-work-channel-check-unavailable"]')?.textContent,
      ).toContain("still file");
      container
        .querySelector<HTMLFormElement>("#my-work-add-form")
        ?.dispatchEvent(new Event("submit", { cancelable: true }));
      expect(saved).toHaveLength(1);
    });

    it("checks nothing while the box is unticked", () => {
      const { container, saved, rerender } = draw({
        projectDraft: "Causal abstraction",
        channelCheck: check({ enabled: false, channels: ["proj-cais"] }),
      });
      typeAlias(container, "brand-new", rerender);
      container.querySelector<HTMLInputElement>('[data-testid="my-work-add-started-on"]')!.value =
        "2026-01-15";
      container
        .querySelector<HTMLFormElement>("#my-work-add-form")
        ?.dispatchEvent(new Event("submit", { cancelable: true }));
      expect(saved).toHaveLength(1);
    });
  });

  it("registers a paper against the venue and year picked on the row", () => {
    const { container, saved, state } = draw({ projectDraft: "Causal abstraction" });
    const form = container.querySelector<HTMLFormElement>("#my-work-add-form");
    const venue = container.querySelector<HTMLSelectElement>('[data-testid="register-venue-0"]');
    const yearSelect = container.querySelector<HTMLSelectElement>(
      '[data-testid="register-venue-year-0"]',
    );
    expect(venue).not.toBeNull();
    fillProjectBasics(container);
    // The rows report through change into view state rather than through FormData, so that adding
    // a second venue does not lose what was typed into the first.
    yearSelect!.value = String(year + 1);
    yearSelect!.dispatchEvent(new Event("change"));
    venue!.value = "COLM-workshop";
    venue!.dispatchEvent(new Event("change"));
    form?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(saved.at(-1)?.conference).toBe(`COLM ${year + 1} (workshop)`);
    expect(state.myWorkProjectVenues).toEqual([]);
  });

  it("takes several conferences, each with its own probability", () => {
    // A paper genuinely can be 80% one venue and 50% another: independent bets on the same work,
    // not a distribution that has to sum to anything.
    const { container, saved, state } = draw({ projectDraft: "Causal abstraction" });
    const pick = (testid: string, value: string) => {
      const select = container.querySelector<HTMLSelectElement>(`[data-testid="${testid}"]`);
      select!.value = value;
      select!.dispatchEvent(new Event("change"));
    };
    pick("register-venue-0", "COLM-workshop");
    pick("register-venue-odds-0", "80");
    container.querySelector<HTMLButtonElement>('[data-testid="register-venue-add"]')?.click();
    expect(state.myWorkProjectVenues).toHaveLength(2);

    fillProjectBasics(container);
    // Submitted straight from state rather than after a re-render: the handlers read live state,
    // so a form that has not been redrawn still files what was actually picked.
    container
      .querySelector<HTMLFormElement>("#my-work-add-form")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));

    const targets = JSON.parse(saved.at(-1)?.venueTargets ?? "[]");
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ venue_id: "COLM-workshop", confidence: 80 });
    // The second row carries its own odds, defaulted rather than inherited from the first.
    expect(targets[1]).toMatchObject({ confidence: 50 });
    // The first target still lands in the legacy pair the deadline board and stage nudges read.
    expect(saved.at(-1)?.conference).toContain("COLM");
    expect(saved.at(-1)?.confidence).toBe("80");
  });
});

describe("project acceptance", () => {
  it("sends the venue decision selected on an author's project card", () => {
    const { container, saved } = draw({ openIds: ["p1"], papers: [paper()] });
    const decision = container.querySelector<HTMLSelectElement>(
      '[data-testid="paper-decision-p1"]',
    )!;
    decision.value = "accept";
    decision.dispatchEvent(new Event("change", { bubbles: true }));

    expect(saved.at(-1)).toMatchObject({
      id: "p1",
      title: "Causal abstraction",
      venueDecision: "accept",
    });
  });

  it("sends every acceptance detail, including explicit clears", () => {
    const accepted = paper({
      venue_decision: "accept",
      accepted_venue: "ICLR 2027",
      accepted_year: 2027,
      is_archival: true,
      presentation_type: "spotlight",
    });
    const { container, saved } = draw({ openIds: ["p1"], papers: [accepted] });

    const venue = container.querySelector<HTMLInputElement>(
      '[data-testid="paper-accepted-venue-p1"]',
    )!;
    venue.value = "";
    venue.dispatchEvent(new Event("change", { bubbles: true }));
    const year = container.querySelector<HTMLInputElement>(
      '[data-testid="paper-accepted-year-p1"]',
    )!;
    year.value = "";
    year.dispatchEvent(new Event("change", { bubbles: true }));
    const archival = container.querySelector<HTMLSelectElement>(
      '[data-testid="paper-archival-p1"]',
    )!;
    archival.value = "";
    archival.dispatchEvent(new Event("change", { bubbles: true }));
    const presentation = container.querySelector<HTMLSelectElement>(
      '[data-testid="paper-presentation-p1"]',
    )!;
    presentation.value = "";
    presentation.dispatchEvent(new Event("change", { bubbles: true }));

    expect(saved.slice(-4)).toEqual([
      expect.objectContaining({ acceptedVenue: "" }),
      expect.objectContaining({ acceptedYear: "" }),
      expect.objectContaining({ isArchival: "" }),
      expect.objectContaining({ presentationType: "" }),
    ]);
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

describe("the banners above the list", () => {
  const decided = {
    id: "d1",
    title: "A decided paper",
    authors: ["Ada Lovelace"],
    current_step: "submission",
    venue_decision: "accept",
    accepted_venue: "EMNLP 2026",
  } as never;

  it("draws the decision banner on the member's own page", () => {
    const { container } = draw({ scopedPapers: [decided], personal: true });
    expect(container.querySelector('[data-testid="decision-banner-d1"]')).not.toBeNull();
  });

  it("draws none of them on Active Papers", () => {
    // The admin view shares this renderer for the cards and the writes. The banners are addressed
    // to one person: a decision prompt on somebody else's paper invites an admin to answer a
    // question that was asked of the author.
    const { container } = draw({ scopedPapers: [decided] });
    expect(container.querySelector('[data-testid="decision-banner-d1"]')).toBeNull();
    expect(container.querySelector('[data-testid="prereg-open"]')).toBeNull();
  });
});

describe("deleting a paper", () => {
  it("offers nothing when the page passed no handler", () => {
    // The service decides who may delete; a page that cannot wire the call must not show a button
    // that always fails.
    const { container } = draw({ openIds: ["p1"] });
    expect(container.querySelector('[data-testid="delete-paper-p1"]')).toBeNull();
  });

  it("asks before deleting, and does nothing when the confirm is declined", () => {
    const original = globalThis.confirm;
    globalThis.confirm = () => false;
    try {
      const { container, deleted } = draw({ openIds: ["p1"], onDeletePaper: true });
      const button = container.querySelector<HTMLButtonElement>('[data-testid="delete-paper-p1"]');
      expect(button).not.toBeNull();
      // Renders the string, not the key path. A duplicate `myWork` section in en.ts shipped this
      // button reading "myWork.delete.action" -- t() found nothing and fell back to the key.
      expect(button?.textContent?.trim()).toBe("Delete this paper");
      expect(button?.textContent).not.toContain("myWork.delete");
      button?.click();
      expect(deleted).toEqual([]);
    } finally {
      globalThis.confirm = original;
    }
  });

  it("deletes the paper once the confirm is accepted", () => {
    const original = globalThis.confirm;
    globalThis.confirm = () => true;
    try {
      const { container, deleted } = draw({ openIds: ["p1"], onDeletePaper: true });
      container.querySelector<HTMLButtonElement>('[data-testid="delete-paper-p1"]')?.click();
      expect(deleted).toEqual(["p1"]);
    } finally {
      globalThis.confirm = original;
    }
  });

  it("does not render the control at all until the card is opened", () => {
    // Stronger than hiding it: a closed card renders no body content, so there is nothing to hit
    // by accident while scrolling a long list of papers.
    const closed = draw({ onDeletePaper: true });
    expect(closed.container.querySelector('[data-testid="delete-paper-p1"]')).toBeNull();

    const open = draw({ openIds: ["p1"], onDeletePaper: true });
    expect(open.container.querySelector('[data-testid="delete-paper-p1"]')).not.toBeNull();
  });
});

describe("declaring a target venue", () => {
  // Declaring where a paper is going *is* pre-registering it. These two selects wrote only
  // `artifacts.conference`, while every reader of "is this pre-registered" looks at
  // `artifacts.venue_targets` -- so an author who set their target here was still counted as not
  // having pre-registered, and still got asked to.
  function retarget(record: AdminBotPaperRecord) {
    const { container, saved } = draw({ papers: [record], openIds: ["p1"] });
    const venue = container.querySelector<HTMLSelectElement>('[data-testid="target-venue-p1"]');
    if (!venue) {
      throw new Error("venue select missing");
    }
    venue.value = "ICLR";
    venue.dispatchEvent(new Event("change", { bubbles: true }));
    return saved.at(-1);
  }

  function targetsOf(input: { venueTargets?: string } | undefined) {
    return JSON.parse(input?.venueTargets || "[]") as Array<{
      venue_id: string;
      confidence: number;
    }>;
  }

  it("registers the paper for the venue it was just pointed at", () => {
    const written = retarget(paper());
    expect(written?.conference).toContain("ICLR");
    const targets = targetsOf(written);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.venue_id).toBe("ICLR");
    // The odds select is untouched here, so the target takes the same default Add a project uses
    // rather than a zero, which would read as "certainly not going".
    expect(targets[0]?.confidence).toBe(50);
  });

  it("replaces its own venue instead of stacking a second entry for it", () => {
    const written = retarget(
      paper({
        artifacts: {
          conference: "ICLR 2026",
          venue_targets: JSON.stringify([{ venue_id: "ICLR", label: "ICLR 2026", confidence: 30 }]),
        },
      } as Partial<AdminBotPaperRecord>),
    );
    expect(targetsOf(written)).toHaveLength(1);
  });

  it("leaves a venue the paper is also aimed at alone", () => {
    // Somebody adjusting the year on this card must not drop the second venue they registered
    // through the pre-registration dialog.
    const written = retarget(
      paper({
        artifacts: {
          venue_targets: JSON.stringify([
            { venue_id: "arr_2026_october", label: "ARR October", confidence: 80 },
          ]),
        },
      } as Partial<AdminBotPaperRecord>),
    );
    const ids = targetsOf(written).map((target) => target.venue_id);
    expect(ids).toContain("arr_2026_october");
    expect(ids).toContain("ICLR");
  });
});

describe("hiding a paper from your own list", () => {
  // The complaint this answers: somebody with thirty papers cannot navigate the list. Hiding is a
  // view preference -- it writes nothing to the paper, so a coauthor's page is untouched.
  afterEach(() => {
    localStorage.clear();
  });

  function twoPapers() {
    return [paper(), paper({ id: "p2", title: "Second paper" })];
  }

  it("takes the row off the list without touching the paper", () => {
    const first = draw({ papers: twoPapers() });
    expect(first.container.textContent).toContain("Second paper");

    first.container.querySelector<HTMLButtonElement>('[data-testid="my-work-hide-p2"]')?.click();

    const after = draw({ papers: twoPapers() });
    expect(after.container.textContent).not.toContain("Second paper");
    // Still on the record: nothing was saved, so no coauthor's page changed.
    expect(after.saved).toEqual([]);
  });

  it("says how many it is holding back", () => {
    const first = draw({ papers: twoPapers() });
    first.container.querySelector<HTMLButtonElement>('[data-testid="my-work-hide-p2"]')?.click();

    const after = draw({ papers: twoPapers() });
    const line = after.container.querySelector('[data-testid="my-work-hidden-line"]');
    // A list that silently shrinks is indistinguishable from one that lost rows.
    expect(line?.textContent).toContain("1");
  });

  it("gives them back in one click", () => {
    const first = draw({ papers: twoPapers() });
    first.container.querySelector<HTMLButtonElement>('[data-testid="my-work-hide-p2"]')?.click();

    const hidden = draw({ papers: twoPapers() });
    hidden.container
      .querySelector<HTMLButtonElement>('[data-testid="my-work-show-hidden"]')
      ?.click();

    const restored = draw({ papers: twoPapers() });
    expect(restored.container.textContent).toContain("Second paper");
    expect(restored.container.querySelector('[data-testid="my-work-hidden-line"]')).toBeNull();
  });

  it("offers no hidden line when nothing is hidden", () => {
    const { container } = draw({ papers: twoPapers() });
    expect(container.querySelector('[data-testid="my-work-hidden-line"]')).toBeNull();
  });
});

// A project's title changes as the work finds its shape, and the three answers the create form
// insists on used to be fixed from the moment it was filed. The service always allowed them
// through OWN_PAPER_EDITABLE_FIELDS; there was simply nowhere to type them.
describe("editing a project's own details", () => {
  const openCard = () => draw({ openIds: ["p1"], papers: [paper()] });

  it("saves a new title, short name and start date", () => {
    const { container, saved, rerender } = openCard();
    const title = container.querySelector<HTMLInputElement>(
      '[data-testid="my-work-details-title-p1"]',
    )!;
    title.value = "A better title";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    rerender();

    const alias = container.querySelector<HTMLInputElement>(
      '[data-testid="my-work-details-alias-p1"]',
    )!;
    alias.value = "Renamed";
    alias.dispatchEvent(new Event("input", { bubbles: true }));
    rerender();

    container.querySelector<HTMLButtonElement>('[data-testid="my-work-details-save-p1"]')!.click();

    expect(saved.at(-1)).toMatchObject({
      id: "p1",
      title: "A better title",
      // Stored the way Slack needs it, the same as on the create form.
      alias: "renamed",
    });
  });

  it("refuses a short name Slack could not take, and says why", () => {
    const { container, saved, rerender } = openCard();
    const alias = container.querySelector<HTMLInputElement>(
      '[data-testid="my-work-details-alias-p1"]',
    )!;
    alias.value = "Bob's Project";
    alias.dispatchEvent(new Event("input", { bubbles: true }));
    rerender();

    container.querySelector<HTMLButtonElement>('[data-testid="my-work-details-save-p1"]')!.click();
    rerender();

    expect(saved).toHaveLength(0);
    expect(
      container.querySelector('[data-testid="my-work-details-error-p1"]')?.textContent ?? "",
    ).toContain("cannot be a Slack channel name");
  });

  it("refuses an empty title", () => {
    const { container, saved, rerender } = openCard();
    const title = container.querySelector<HTMLInputElement>(
      '[data-testid="my-work-details-title-p1"]',
    )!;
    title.value = "   ";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    rerender();

    container.querySelector<HTMLButtonElement>('[data-testid="my-work-details-save-p1"]')!.click();
    rerender();

    expect(saved).toHaveLength(0);
    expect(
      container.querySelector('[data-testid="my-work-details-error-p1"]')?.textContent ?? "",
    ).toContain("title");
  });

  // Nothing typed yet is nothing to save: the button would otherwise re-file the record unchanged.
  it("keeps the save button inert until something changes", () => {
    const { container, rerender } = openCard();
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="my-work-details-save-p1"]')
        ?.disabled,
    ).toBe(true);

    const title = container.querySelector<HTMLInputElement>(
      '[data-testid="my-work-details-title-p1"]',
    )!;
    title.value = "Changed";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    rerender();

    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="my-work-details-save-p1"]')
        ?.disabled,
    ).toBe(false);
  });
});

// Saving the way the profile page saves: a beat after typing stops, or on the way out. The explicit
// button stays, so these cover what it does not -- see adminbot/autosave.ts for the shared timing.
// The sheet is the page, not a column in it. `.my-work` caps itself at a readable measure for the
// card list; a sixty-column table wants the window, and the cap was leaving a third of it empty.
describe("the sheet's width", () => {
  it("drops the reading-measure cap the card list keeps", () => {
    const papers = [paper(), paper({ id: "p2" }), paper({ id: "p3" })];
    const first = draw({ papers });
    // The sheet is opt-in: the cards are still the surface until somebody asks for it.
    first.container.querySelector<HTMLButtonElement>('[data-testid="my-work-open-grid"]')!.click();
    const { container } = draw({ papers });
    expect(container.querySelector(".my-work")?.classList.contains("my-work--sheet")).toBe(true);
    // And back out again, so the next test in this file does not inherit an open sheet.
    container.querySelector<HTMLButtonElement>(".paper-grid__tools .btn:last-of-type")?.click();
  });

  it("keeps the cap on the card list", () => {
    const { container } = draw({ papers: [paper()] });
    const cards = container.querySelector(".my-work");
    expect(cards?.classList.contains("my-work--sheet")).toBe(false);
  });
});

describe("project details autosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const typeInto = (
    container: HTMLElement,
    testid: string,
    value: string,
    rerender: () => void,
  ) => {
    const input = container.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`)!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    rerender();
  };

  const leaveForm = (container: HTMLElement) => {
    container
      .querySelector<HTMLFormElement>(".my-work-details__form")!
      .dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  };

  it("commits a beat after typing stops, with nothing pressed", () => {
    const { container, saved, rerender } = draw({ openIds: ["p1"], papers: [paper()] });
    typeInto(container, "my-work-details-title-p1", "A better title", rerender);

    // Still inside the debounce: a keystroke is not a decision.
    vi.advanceTimersByTime(500);
    expect(saved).toHaveLength(0);

    vi.advanceTimersByTime(500);
    expect(saved.at(-1)).toMatchObject({ id: "p1", title: "A better title" });
  });

  it("restarts the timer on every keystroke rather than saving mid-word", () => {
    const { container, saved, rerender } = draw({ openIds: ["p1"], papers: [paper()] });
    for (const value of ["A", "Ab", "Abc"]) {
      typeInto(container, "my-work-details-title-p1", value, rerender);
      vi.advanceTimersByTime(600);
    }
    expect(saved).toHaveLength(0);

    vi.advanceTimersByTime(900);
    expect(saved).toHaveLength(1);
    expect(saved.at(-1)).toMatchObject({ title: "Abc" });
  });

  it("holds a draft it cannot write instead of firing a doomed request", () => {
    const { container, saved, rerender } = draw({ openIds: ["p1"], papers: [paper()] });
    typeInto(container, "my-work-details-alias-p1", "Bob's Project", rerender);
    vi.advanceTimersByTime(5000);

    expect(saved).toHaveLength(0);
    // And says nothing yet: the member may be three characters into typing it.
    expect(container.querySelector('[data-testid="my-work-details-error-p1"]')).toBeNull();
  });

  // The case that made the create form lose a project silently: a draft that cannot be written has
  // no pending timer, so a plain flush would do nothing and the member would leave none the wiser.
  it("explains an unwritable draft when focus leaves, rather than dropping it", () => {
    const { container, saved, rerender } = draw({ openIds: ["p1"], papers: [paper()] });
    typeInto(container, "my-work-details-alias-p1", "Bob's Project", rerender);
    leaveForm(container);
    rerender();

    expect(saved).toHaveLength(0);
    expect(
      container.querySelector('[data-testid="my-work-details-error-p1"]')?.textContent ?? "",
    ).toContain("cannot be a Slack channel name");
  });

  it("commits immediately when focus leaves mid-debounce", () => {
    const { container, saved, rerender } = draw({ openIds: ["p1"], papers: [paper()] });
    typeInto(container, "my-work-details-title-p1", "Left early", rerender);
    leaveForm(container);

    expect(saved.at(-1)).toMatchObject({ title: "Left early" });
  });

  it("writes once when the debounce and the blur both come due", () => {
    const { container, saved, rerender } = draw({ openIds: ["p1"], papers: [paper()] });
    typeInto(container, "my-work-details-title-p1", "Once only", rerender);
    vi.advanceTimersByTime(900);
    expect(saved).toHaveLength(1);

    // The record has not come back yet, so the draft still differs from what is stored.
    leaveForm(container);
    expect(saved).toHaveLength(1);
  });

  // A failed write leaves the signature recorded, so the automatic paths would suppress the retry.
  // The button is a deliberate act and must always reach the service.
  it("re-sends on an explicit press even when the values have not changed since", () => {
    const { container, saved, rerender } = draw({ openIds: ["p1"], papers: [paper()] });
    typeInto(container, "my-work-details-title-p1", "Retry me", rerender);
    vi.advanceTimersByTime(900);
    expect(saved).toHaveLength(1);

    rerender();
    container.querySelector<HTMLButtonElement>('[data-testid="my-work-details-save-p1"]')!.click();
    expect(saved).toHaveLength(2);
    expect(saved.at(-1)).toMatchObject({ title: "Retry me" });
  });

  it("leaves a form nobody touched alone", () => {
    const { container, saved } = draw({ openIds: ["p1"], papers: [paper()] });
    leaveForm(container);
    vi.advanceTimersByTime(5000);
    expect(saved).toHaveLength(0);
  });

  it("still says changes save themselves", () => {
    const { container } = draw({ openIds: ["p1"], papers: [paper()] });
    expect(container.querySelector(".my-work-details__autosave-hint")?.textContent?.trim()).toBe(
      "Changes save automatically.",
    );
  });
});
