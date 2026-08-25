/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DeadlineProposal,
  DeadlineProposalInput,
  DeadlineProposalStore,
} from "../data/deadline-proposals.ts";
import type { DeadlineVenue } from "../data/deadlines.ts";
import {
  archivalLabelOf,
  buildDeadlineBoardEntries,
  entriesForDeadlinePeriod,
  filterDeadlineBoardEntries,
  groupDeadlineBoardEntries,
  priorDeadlineRevisions,
  priorityLabelOf,
  renderDeadlines,
  workshopSourceLinks,
} from "./deadlines.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-24T12:00:00Z"));
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

async function settle(container: HTMLElement): Promise<void> {
  const element = container.querySelector("adminbot-deadlines-view") as {
    updateComplete?: Promise<unknown>;
  };
  await element?.updateComplete;
  await Promise.resolve();
  await element?.updateComplete;
}

async function renderView(view: "cards" | "default" = "cards"): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderDeadlines(), container);
  await settle(container);
  if (view === "cards") {
    buttonNamed(container, "Cards").click();
    await settle(container);
  }
  return container;
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === name,
  )!;
}

function proposalInput(): DeadlineProposalInput {
  return {
    name: "Example Workshop",
    parentConference: "EMNLP",
    parentYear: "2026",
    entryType: "workshop",
    deadlineDate: "2026-09-14",
    deadlineTime: "23:59",
    timezone: "Etc/GMT+12",
    homepageUrl: "https://example.org/workshop",
    cfpUrl: "https://example.org/cfp",
    openReviewUrl: "https://openreview.net/group?id=example",
    note: "Verify the archival route.",
  };
}

class TestProposalStore implements DeadlineProposalStore {
  proposals: DeadlineProposal[];

  constructor(proposals: DeadlineProposal[] = []) {
    this.proposals = proposals;
  }

  async list() {
    return this.proposals;
  }

  async listPublished() {
    return [];
  }

  async submit(input: DeadlineProposalInput, _idempotencyKey: string) {
    const proposal: DeadlineProposal = {
      id: "proposal-1",
      deadline_id: "community-1",
      status: "pending",
      submitter_member_id: "member-1",
      submitter_name: "Member One",
      current_revision: 1,
      action_id: "action-1",
      payload_hash: "hash-1",
      duplicate_deadline_ids: [],
      deadline: input,
      revisions: [],
      created_at: "2026-08-25T08:00:00Z",
      updated_at: "2026-08-25T08:00:00Z",
    };
    this.proposals = [proposal, ...this.proposals];
    return proposal;
  }

  async revise(id: string, input: DeadlineProposalInput) {
    const proposal = this.proposals.find((row) => row.id === id)!;
    const revised: DeadlineProposal = {
      ...proposal,
      current_revision: proposal.current_revision + 1,
      deadline: input,
      payload_hash: "hash-2",
      updated_at: "2026-08-25T09:00:00Z",
    };
    this.proposals = this.proposals.map((row) => (row.id === id ? revised : row));
    return revised;
  }

  async decide(proposal: DeadlineProposal, status: "published" | "rejected") {
    const reviewed: DeadlineProposal = {
      ...proposal,
      status,
      updated_at: "2026-08-25T09:00:00Z",
      ...(status === "published" ? { published_at: "2026-08-25T09:00:00Z" } : {}),
    };
    this.proposals = this.proposals.map((row) => (row.id === proposal.id ? reviewed : row));
    return reviewed;
  }
}

describe("deadline board model", () => {
  it("keeps workshop CFP/homepage and OpenReview links independent", () => {
    const workshop = {
      entry_type: "workshop",
      cfp_url: "https://workshop.example/cfp",
      homepage_url: "https://workshop.example",
      openreview_url: "https://openreview.net/group?id=Example/Workshop",
    } as DeadlineVenue;
    expect(workshopSourceLinks(workshop)).toEqual({
      titleUrl: "https://workshop.example",
      sourceUrl: "https://workshop.example/cfp",
      sourceLabel: "Call for papers",
      openReviewUrl: "https://openreview.net/group?id=Example/Workshop",
    });
    expect(workshopSourceLinks({ ...workshop, cfp_url: "", openreview_url: "" })).toEqual({
      titleUrl: "https://workshop.example",
      sourceUrl: "https://workshop.example",
      sourceLabel: "Official site",
      openReviewUrl: "",
    });
  });

  it("keeps all valid generated rows in chronological order", () => {
    const entries = buildDeadlineBoardEntries();
    expect(entries.length).toBeGreaterThan(100);
    for (let index = 1; index < entries.length; index += 1) {
      expect(entries[index].instant).toBeGreaterThanOrEqual(entries[index - 1].instant);
    }
  });

  it("retains expired deadlines newest first", () => {
    const now = Date.now();
    const past = entriesForDeadlinePeriod(buildDeadlineBoardEntries(), now, "past");
    expect(past.length).toBeGreaterThan(0);
    expect(past.every((entry) => entry.instant <= now)).toBe(true);
    expect(past.map((entry) => entry.instant)).toEqual(
      past.map((entry) => entry.instant).toSorted((left, right) => right - left),
    );
  });

  it("applies type, archival-status, and priority filters independently", () => {
    const entries = buildDeadlineBoardEntries();
    const filtered = filterDeadlineBoardEntries(entries, "", "", {
      entryType: "workshop",
      archivalStatus: "mixed",
      priority: "standard",
    });

    expect(filtered.length).toBeGreaterThan(0);
    expect(
      filtered.every(
        (entry) =>
          entry.venue.entry_type === "workshop" &&
          entry.venue.archival_status === "mixed" &&
          entry.venue.venue_priority === "standard",
      ),
    ).toBe(true);
  });

  it("filters against the generated group label and concrete venue name", () => {
    const entries = buildDeadlineBoardEntries();
    const group = filterDeadlineBoardEntries(entries, "ICLR 2027", "");
    expect(group.length).toBeGreaterThan(1);
    expect(group.every((entry) => entry.venue.venue_group === "ICLR 2027")).toBe(true);

    const searched = filterDeadlineBoardEntries(entries, "", "impact-speech");
    expect(searched).toHaveLength(1);
    expect(searched[0].venue.name).toContain("IMPACT-SPEECH");
  });

  it("exposes only earlier deadline revisions as history", () => {
    const revisions = [
      { observed_at: "2026-08-01T00:00:00Z", deadline_aoe: "2026-09-24 23:59:59" },
      { observed_at: "2026-08-02T00:00:00Z", deadline_aoe: "2026-09-25 23:59:59" },
    ];
    expect(priorDeadlineRevisions({ revisions } as DeadlineVenue)).toEqual([revisions[0]]);
  });

  it("keeps venue priority and publication policy as independent labels", () => {
    const venue = {
      archival_status: "archival",
      entry_type: "main_conference",
      venue_priority: "primary",
    } as DeadlineVenue;
    expect(priorityLabelOf(venue)).toBe("Primary");
    expect(archivalLabelOf(venue)).toBe("Archival");
    expect(
      priorityLabelOf({ ...venue, entry_type: "demo_track", venue_priority: "secondary" }),
    ).toBe("Secondary");
    expect(priorityLabelOf({ ...venue, entry_type: "arr_commitment" })).toBe("Primary");
    expect(priorityLabelOf({ ...venue, entry_type: "workshop", venue_priority: "standard" })).toBe(
      "",
    );
    expect(archivalLabelOf({ ...venue, archival_status: "unknown" })).toBe(
      "Archival status not established",
    );
    expect(archivalLabelOf({ ...venue, archival_status: "non_archival" })).toBe("Non-archival");
    expect(archivalLabelOf({ ...venue, archival_status: "mixed" })).toBe("Archival + non-archival");
  });

  it("groups the filtered chronology without duplicating deadlines", () => {
    const entries = buildDeadlineBoardEntries();
    const groups = groupDeadlineBoardEntries(entries);

    expect(groups[0].instant).toBe(groups[0].entries[0].instant);
    expect(groups.map((group) => group.label).toSorted()).toEqual(
      [...new Set(entries.map((entry) => entry.venue.venue_group))].toSorted(),
    );
    expect(groups.flatMap((group) => group.entries)).toHaveLength(entries.length);
    expect(
      groups
        .flatMap((group) => group.entries)
        .map((entry) => entry.venue.id)
        .toSorted(),
    ).toEqual(entries.map((entry) => entry.venue.id).toSorted());
    const neurips = entries.filter((entry) => entry.venue.venue_group === "NeurIPS 2026 Workshops");
    const neuripsGroup = groups.find((group) => group.label === "NeurIPS 2026 Workshops");
    expect(neurips.length).toBeGreaterThan(100);
    expect(neuripsGroup?.entries.length).toBe(neurips.length);
    expect(neuripsGroup?.sections.nonArchival.length).toBe(neurips.length);
    expect(neuripsGroup?.sections.unknown.length).toBe(0);
    const emnlpGroup = groups.find((group) => group.label === "EMNLP 2026 Workshops");
    expect(emnlpGroup?.sections.mixed.length).toBeGreaterThan(0);
    expect(emnlpGroup?.sections.unknown.length).toBe(0);
    expect(groups.find((group) => group.label === "EMNLP 2026")?.sections.archival.length).toBe(1);
  });
});

describe("renderDeadlines", () => {
  it("disables anonymous proposals without adding a notice row", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderDeadlines({ role: "anonymous", proposalStore: new TestProposalStore() }),
      container,
    );
    await settle(container);

    const propose = buttonNamed(container, "Propose a new deadline");
    expect(propose.disabled).toBe(true);
    expect(propose.closest<HTMLElement>(".deadline-proposal-trigger")?.title).toBe(
      "Sign in to use deadline proposals.",
    );
    expect(propose.getAttribute("aria-describedby")).toBe("deadline-proposal-sign-in-hint");
    expect(container.querySelector(".deadline-proposal__notice")).toBeNull();
    expect(container.querySelector('[data-testid="deadline-my-proposals"]')).toBeNull();
    expect(container.querySelector('[data-testid="deadline-review-proposals"]')).toBeNull();
    propose.click();
    expect(container.querySelector('[data-testid="deadline-proposal-form-panel"]')).toBeNull();
  });

  it("lets a signed-in member submit a pending server-backed proposal", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const store = new TestProposalStore();
    render(
      renderDeadlines({ role: "member", memberId: "member-1", proposalStore: store }),
      container,
    );
    await settle(container);

    buttonNamed(container, "Propose a new deadline").click();
    await settle(container);
    expect(container.querySelector('[data-testid="deadline-review-proposals"]')).toBeNull();
    expect(container.textContent).toContain("remain private until an administrator");
    expect(
      container.querySelector<HTMLDialogElement>('[data-testid="deadline-proposal-drawer"]')?.open,
    ).toBe(true);

    const form = container.querySelector<HTMLFormElement>(".deadline-proposal__form")!;
    const homepage = form.elements.namedItem("homepageUrl") as HTMLInputElement;
    const cfp = form.elements.namedItem("cfpUrl") as HTMLInputElement;
    expect(homepage.required).toBe(true);
    expect(cfp.required).toBe(false);
    expect(
      [...form.querySelectorAll<HTMLInputElement>('input[type="url"]')].map((input) => input.name),
    ).toEqual(["homepageUrl", "cfpUrl", "openReviewUrl"]);
    const parentConference = form.elements.namedItem("parentConference") as HTMLInputElement;
    expect(parentConference.getAttribute("role")).toBe("combobox");
    parentConference.focus();
    await settle(container);
    expect(
      [...container.querySelectorAll('[role="option"]')].map((option) =>
        option.textContent?.trim(),
      ),
    ).toEqual(expect.arrayContaining(["EMNLP", "NeurIPS"]));
    parentConference.value = "New Conference";
    parentConference.dispatchEvent(new Event("input", { bubbles: true }));
    expect(
      (form.elements.namedItem("timezone") as HTMLSelectElement).selectedOptions[0]?.textContent,
    ).toContain("AoE — Anywhere on Earth (UTC−12)");
    const values = proposalInput();
    for (const [name, value] of Object.entries(values)) {
      if (name === "parentConference") {
        continue;
      }
      const control = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
      control.value = value;
    }
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(container);

    expect(store.proposals).toHaveLength(1);
    expect(store.proposals[0]).toMatchObject({
      status: "pending",
      submitter_member_id: "member-1",
      deadline: { name: "Example Workshop", parentConference: "New Conference" },
    });
    expect(container.textContent).toContain("It is not public until approved.");
    expect(container.querySelector('[data-testid="deadline-proposal-form-panel"]')).toBeNull();
    expect(
      container.querySelector<HTMLDialogElement>('[data-testid="deadline-proposal-drawer"]')?.open,
    ).toBe(false);

    container.querySelector<HTMLButtonElement>('[data-testid="deadline-my-proposals"]')!.click();
    await settle(container);
    const ownProposals = container.querySelector('[data-testid="deadline-proposal-review-panel"]')!;
    expect(ownProposals.textContent).toContain("My deadline proposals");
    expect(ownProposals.textContent).toContain("Submitted by you");
    expect(ownProposals.textContent).not.toContain("member-1");
    expect(ownProposals.querySelector(".deadline-proposal-row__actions")).toBeNull();
  });

  it("lets administrators publish the payload shown in the review queue", async () => {
    const input = proposalInput();
    const memberProposal: DeadlineProposal = {
      id: "proposal-1",
      deadline_id: "community-1",
      status: "pending",
      submitter_member_id: "member-1",
      submitter_name: "Ada Member",
      current_revision: 1,
      action_id: "action-1",
      payload_hash: "hash-1",
      duplicate_deadline_ids: [],
      deadline: input,
      revisions: [],
      created_at: "2026-08-25T08:00:00Z",
      updated_at: "2026-08-25T08:00:00Z",
    };
    const store = new TestProposalStore([
      memberProposal,
      {
        ...memberProposal,
        id: "proposal-2",
        deadline_id: "community-2",
        submitter_member_id: "admin-1",
        submitter_name: "Admin One",
        action_id: "action-2",
        payload_hash: "hash-2",
        deadline: { ...input, name: "Admin Workshop" },
      },
    ]);
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderDeadlines({ role: "admin", memberId: "admin-1", proposalStore: store }),
      container,
    );
    await settle(container);

    container.querySelector<HTMLButtonElement>('[data-testid="deadline-my-proposals"]')!.click();
    await settle(container);
    const own = container.querySelector('[data-testid="deadline-proposal-review-panel"]')!;
    expect(own.textContent).toContain("Admin Workshop");
    expect(own.textContent).toContain("Submitted by you");
    expect(own.textContent).not.toContain("Example Workshop");
    expect(own.querySelector(".deadline-proposal-row__actions")).toBeNull();
    buttonNamed(container, "Close").click();
    await settle(container);

    container
      .querySelector<HTMLButtonElement>('[data-testid="deadline-review-proposals"]')!
      .click();
    await settle(container);
    expect(
      container.querySelector<HTMLDialogElement>('[data-testid="deadline-proposal-drawer"]')?.open,
    ).toBe(true);
    const review = container.querySelector('[data-testid="deadline-proposal-review-panel"]')!;
    expect(review.textContent).toContain("Example Workshop");
    expect(review.textContent).toContain("Submitted by Ada Member");
    expect(review.textContent).not.toContain("member-1");
    expect(review.textContent).toContain("adds it to every deadline board");

    buttonNamed(container, "Revise").click();
    await settle(container);
    const revisionForm = container.querySelector<HTMLFormElement>(".deadline-proposal__form")!;
    expect((revisionForm.elements.namedItem("entryType") as HTMLSelectElement).value).toBe(
      "workshop",
    );
    const deadlineDate = revisionForm.elements.namedItem("deadlineDate") as HTMLInputElement;
    expect(deadlineDate.value).toBe("2026-09-14");
    deadlineDate.value = "2026-09-21";
    revisionForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(container);
    expect(store.proposals[0]).toMatchObject({
      current_revision: 2,
      deadline: { deadlineDate: "2026-09-21" },
    });

    container
      .querySelector<HTMLButtonElement>('[data-testid="deadline-review-proposals"]')!
      .click();
    await settle(container);

    buttonNamed(container, "Approve and publish").click();
    await settle(container);
    expect(store.proposals[0].status).toBe("published");
    expect(container.querySelectorAll(".deadline-group")).not.toHaveLength(0);
    expect(container.querySelector(".deadline-board__group-list")?.textContent).not.toContain(
      "Example Workshop",
    );
  });

  it("renders the standalone board's native hierarchy without an embedded page", async () => {
    const container = await renderView();

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector(".deadline-board__header")?.textContent).toContain(
      "Past and upcoming conference & workshop deadlines.",
    );
    expect(container.querySelector(".deadline-board__hero")).not.toBeNull();
    expect(container.querySelectorAll(".deadline-board__stats > div")).toHaveLength(4);
    expect(container.querySelector(".deadline-board__stats")?.textContent).toContain("Due today");
    expect(
      container.querySelector<HTMLInputElement>('.deadline-board__search input[type="search"]')
        ?.placeholder,
    ).toBe("Search conferences & workshops…");
    expect(
      container.querySelectorAll<HTMLSelectElement>(".deadline-board__facet select"),
    ).toHaveLength(3);
    expect(
      [...container.querySelectorAll<HTMLSelectElement>(".deadline-board__facet select")].every(
        (select) =>
          [...select.options].every((option) => / \(\d+\)\s*$/u.test(option.textContent ?? "")),
      ),
    ).toBe(true);
    expect(container.textContent).toContain("Archival + non-archival");
    expect(container.querySelectorAll(".deadline-card").length).toBeGreaterThan(100);
    const boardChildren = [...container.querySelector(".deadline-board")!.children];
    expect(boardChildren.indexOf(container.querySelector(".deadline-board__modes")!)).toBeLessThan(
      boardChildren.indexOf(container.querySelector(".deadline-board__controls")!),
    );
    expect(
      boardChildren.indexOf(container.querySelector(".deadline-board__controls")!),
    ).toBeLessThan(boardChildren.indexOf(container.querySelector(".deadline-board__overview")!));
    expect(
      container.querySelector(".deadline-board__guide")?.textContent?.replace(/\s+/gu, " "),
    ).toContain(
      "Non-archival does not count as publishing; you can still submit the paper elsewhere.",
    );
    expect(container.textContent).not.toContain("Jinesis Lab · Submission Deadlines");
    expect(container.textContent).not.toContain("countdowns update live");
  });

  it("filters directly to one venue group", async () => {
    const container = await renderView();
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>(".deadline-board__groups button"),
    ].find((candidate) => candidate.textContent?.includes("ICLR 2027"))!;

    button.click();
    await settle(container);

    const groups = [...container.querySelectorAll(".deadline-card__group")].map(
      (node) => node.textContent?.trim() ?? "",
    );
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.every((label) => label.startsWith("ICLR 2027"))).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("uses the explicit workshop labels in cards and grouped headings", async () => {
    const container = await renderView();
    const labels = [...container.querySelectorAll(".deadline-board__groups button")].map((button) =>
      button.textContent?.trim().replace(/\s+\d+$/u, ""),
    );

    expect(labels).toContain("EMNLP 2026 Workshops");
    expect(labels).toContain("NeurIPS 2026 Workshops");
    expect(labels).toContain("ICLR 2027");
    expect(labels).toContain("EACL 2027");
    expect(labels).toContain("ARR October 2026");
    expect(labels).not.toContain("Workshops of ICLR 2027");
    expect(labels).not.toContain("Workshops of EACL 2027");

    buttonNamed(container, "Groups").click();
    await settle(container);
    const headings = [...container.querySelectorAll(".deadline-group__heading strong")].map(
      (heading) => heading.textContent?.trim(),
    );
    expect(headings).toContain("EMNLP 2026 Workshops");
    expect(headings).toContain("NeurIPS 2026 Workshops");
    expect(headings).toContain("ICLR 2027");
    expect(headings).toContain("EACL 2027");
  });

  it("keeps classification labels separate across cards and grouped rows", async () => {
    const container = await renderView();
    buttonNamed(container, "Cards").click();
    await settle(container);
    const cards = [...container.querySelectorAll<HTMLElement>(".deadline-card")];

    const workshop = cards.find(
      (card) => card.dataset.entryType === "workshop" && card.dataset.archivalStatus === "mixed",
    )!;
    expect(workshop.dataset.archivalStatus).toBeDefined();
    expect(workshop.querySelector(".deadline-card__urgency")?.textContent?.trim()).not.toBe("");
    expect(workshop.querySelector(".deadline-priority")).toBeNull();
    expect(workshop.querySelector(".deadline-archival")?.textContent?.trim()).toBe(
      "Archival + non-archival",
    );

    const primary = cards.find(
      (card) =>
        card.dataset.archivalStatus === "archival" &&
        card.dataset.venuePriority === "primary" &&
        ["main_conference", "demo_track"].includes(card.dataset.entryType ?? ""),
    )!;
    expect(primary.querySelector('[data-priority="primary"]')?.textContent?.trim()).toBe("Primary");
    expect(primary.querySelector('[data-archival="archival"]')?.textContent?.trim()).toBe(
      "Archival",
    );

    const secondary = cards.find(
      (card) =>
        card.dataset.archivalStatus === "archival" &&
        card.dataset.venuePriority === "secondary" &&
        ["main_conference", "demo_track"].includes(card.dataset.entryType ?? ""),
    )!;
    expect(secondary.querySelector('[data-priority="secondary"]')?.textContent?.trim()).toBe(
      "Secondary",
    );
    expect(secondary.querySelector('[data-archival="archival"]')?.textContent?.trim()).toBe(
      "Archival",
    );

    const arrCommitment = cards.find(
      (card) =>
        card.dataset.entryType === "arr_commitment" &&
        card.dataset.venuePriority === "secondary" &&
        card.dataset.archivalStatus === "archival",
    )!;
    expect(arrCommitment.querySelector('[data-priority="secondary"]')?.textContent?.trim()).toBe(
      "Secondary",
    );
    expect(arrCommitment.querySelector('[data-archival="archival"]')?.textContent?.trim()).toBe(
      "Archival",
    );

    buttonNamed(container, "Groups").click();
    await settle(container);
    const workshopGroup = [...container.querySelectorAll<HTMLElement>(".deadline-group")].find(
      (group) =>
        group
          .querySelector(".deadline-group__heading")
          ?.textContent?.includes("NeurIPS 2026 Workshops"),
    )!;
    const workshopNote = workshopGroup.querySelector<HTMLElement>(".deadline-group__row-note")!;
    expect(workshopNote.querySelector(".deadline-card__labels")).not.toBeNull();
    expect(workshopNote.querySelector(".deadline-card__type")?.textContent?.trim()).toBe(
      "Workshop",
    );
    const iclr = [...container.querySelectorAll<HTMLElement>(".deadline-group")].find((group) =>
      group.querySelector(".deadline-group__heading")?.textContent?.includes("ICLR 2027"),
    )!;
    iclr.querySelector<HTMLButtonElement>(".deadline-group__summary")!.click();
    await settle(container);
    const openIclr = [...container.querySelectorAll<HTMLElement>(".deadline-group")].find(
      (group) =>
        group.hasAttribute("data-open") &&
        group.querySelector(".deadline-group__heading")?.textContent?.includes("ICLR 2027"),
    )!;
    expect(openIclr.querySelector('[data-priority="primary"]')?.textContent?.trim()).toBe(
      "Primary",
    );
    expect(openIclr.querySelector('[data-archival="archival"]')?.textContent?.trim()).toBe(
      "Archival",
    );
    expect(
      openIclr.querySelector(".deadline-group__row-note .deadline-card__labels"),
    ).not.toBeNull();
  });

  it("shows Past newest first with exact times and keeps all filters available", async () => {
    const container = await renderView();
    expect(
      [...container.querySelectorAll(".deadline-board__period button")].map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Past", "Upcoming"]);
    buttonNamed(container, "Past").click();
    await settle(container);

    const cards = [...container.querySelectorAll<HTMLElement>(".deadline-card")];
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((card) => card.dataset.period === "past")).toBe(true);
    expect(cards[0].querySelector(".deadline-card__countdown")?.textContent?.trim()).toBe("passed");
    expect(container.querySelector(".deadline-board__eyebrow")?.textContent).toContain(
      "Most recent deadline",
    );
    expect(container.querySelector(".deadline-board__hero-meta")?.textContent).toMatch(
      /\d{2}:\d{2} AoE/u,
    );
    expect(container.querySelector(".deadline-board__stats")?.textContent).toContain(
      "Passed today",
    );

    buttonNamed(container, "Groups").click();
    await settle(container);
    const groups = [...container.querySelectorAll<HTMLElement>(".deadline-group")];
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((group) => group.dataset.period === "past")).toBe(true);
    expect(groups[0].querySelector(".deadline-group__summary-countdown")?.textContent?.trim()).toBe(
      "passed",
    );
    groups[0].querySelector<HTMLButtonElement>(".deadline-group__summary")!.click();
    await settle(container);
    const openGroup = [...container.querySelectorAll<HTMLElement>(".deadline-group")].find(
      (group) => group.hasAttribute("data-open"),
    )!;
    expect(openGroup.querySelector(".deadline-group__row-countdown")?.textContent?.trim()).toBe(
      "passed",
    );
    expect(openGroup.querySelector(".deadline-group__row-date")?.textContent).toMatch(
      /\d{2}:\d{2} AoE/u,
    );
    buttonNamed(container, "Cards").click();
    await settle(container);

    const entryType = container.querySelector<HTMLSelectElement>(
      '[data-testid="deadline-filter-entry-type"]',
    )!;
    entryType.value = "arr_commitment";
    entryType.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(container);
    const filteredCards = [...container.querySelectorAll<HTMLElement>(".deadline-card")];
    expect(filteredCards.length).toBeGreaterThan(0);
    expect(filteredCards.every((card) => card.dataset.entryType === "arr_commitment")).toBe(true);
    expect(buttonNamed(container, "Past").getAttribute("aria-pressed")).toBe("true");
  });

  it("filters directly to one workshop group", async () => {
    const container = await renderView();
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>(".deadline-board__groups button"),
    ].find((candidate) => candidate.textContent?.includes("NeurIPS 2026 Workshops"))!;

    button.click();
    await settle(container);

    const groups = [...container.querySelectorAll(".deadline-card__group")].map(
      (node) => node.textContent?.trim() ?? "",
    );
    expect(groups.length).toBeGreaterThan(50);
    expect(groups.every((label) => label.startsWith("NeurIPS 2026 Workshops"))).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("searches the visible board in place", async () => {
    const container = await renderView();
    const input = container.querySelector<HTMLInputElement>(".deadline-board__search input")!;
    input.value = "IMPACT-SPEECH";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle(container);

    const cards = [...container.querySelectorAll(".deadline-card")];
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector(".deadline-card__name")?.textContent).toContain("IMPACT-SPEECH");
    expect(buttonNamed(container, "All 1")).toBeDefined();
    const stats = [...container.querySelectorAll(".deadline-board__stats > div")];
    expect(stats[0]?.querySelector("dt")?.textContent).toBe("Matching deadlines");
    expect(stats[0]?.querySelector("dd")?.textContent).toBe("1");
    expect(stats[1]?.querySelector("dt")?.textContent).toBe("Due today");
    expect(stats[1]?.querySelector("dd")?.textContent).toBe("1");
  });

  it("updates groups, summary, and the active group for combined filters", async () => {
    const container = await renderView();
    const workshopGroup = [
      ...container.querySelectorAll<HTMLButtonElement>(".deadline-board__groups button"),
    ].find((button) => button.textContent?.includes("NeurIPS 2026 Workshops"))!;
    workshopGroup.click();
    await settle(container);

    const entryType = container.querySelector<HTMLSelectElement>(
      '[data-testid="deadline-filter-entry-type"]',
    )!;
    entryType.value = "arr_commitment";
    entryType.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(container);

    const cards = [...container.querySelectorAll<HTMLElement>(".deadline-card")];
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((card) => card.dataset.entryType === "arr_commitment")).toBe(true);
    expect(buttonNamed(container, `All ${cards.length}`).getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".deadline-board__stats dd")?.textContent).toBe(
      String(cards.length),
    );
    expect(container.querySelector(".deadline-board__foot")?.textContent).toContain(
      `Showing ${cards.length} of ${cards.length} matching upcoming deadlines`,
    );

    const priority = container.querySelector<HTMLSelectElement>(
      '[data-testid="deadline-filter-priority"]',
    )!;
    priority.value = "primary";
    priority.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(container);
    expect(
      [...container.querySelectorAll<HTMLElement>(".deadline-card")].every(
        (card) => card.dataset.venuePriority === "primary",
      ),
    ).toBe(true);
  });

  it("switches among cards, grouped disclosures, and a complete table", async () => {
    const container = await renderView("default");
    const count = Number(container.querySelector(".deadline-board__stats dd")?.textContent);
    expect(count).toBeGreaterThan(100);
    expect(
      [...container.querySelectorAll(".deadline-board__view button")].map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Groups", "Cards", "Table"]);
    expect(buttonNamed(container, "Groups").getAttribute("aria-pressed")).toBe("true");

    expect(container.querySelector(".deadline-board__grid")).toBeNull();
    const groups = [...container.querySelectorAll<HTMLElement>(".deadline-group")];
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.reduce((total, group) => total + Number(group.dataset.count), 0)).toBe(count);
    const neuripsGroup = groups.find((group) =>
      group.querySelector(".deadline-group__heading")?.textContent?.includes("NeurIPS 2026"),
    )!;
    neuripsGroup.querySelector<HTMLButtonElement>(".deadline-group__summary")!.click();
    await settle(container);
    const openGroup = [...container.querySelectorAll<HTMLElement>(".deadline-group")].find(
      (group) => group.hasAttribute("data-open"),
    )!;
    expect(openGroup.querySelector(".deadline-group__panel")?.hasAttribute("hidden")).toBe(false);
    expect(openGroup.querySelector(".deadline-group__row-date")?.textContent).toMatch(
      /\d{2}:\d{2} AoE/u,
    );
    expect(
      [...openGroup.querySelector(".deadline-group__row")!.children]
        .slice(0, 3)
        .map((element) => element.className),
    ).toEqual([
      "deadline-group__row-countdown",
      "deadline-group__row-date",
      "deadline-group__row-main",
    ]);
    expect(
      [...openGroup.querySelector(".deadline-group__row-note")!.children].map(
        (element) => element.className,
      ),
    ).toEqual(["deadline-group__row-detail", "deadline-card__labels"]);
    expect(openGroup.querySelector(".deadline-group__row-name a")).not.toBeNull();
    expect(openGroup.querySelector(".deadline-card__source--button")).not.toBeNull();
    expect(buttonNamed(container, "Groups").getAttribute("aria-pressed")).toBe("true");

    buttonNamed(container, "Cards").click();
    await settle(container);
    expect(container.querySelectorAll(".deadline-card")).toHaveLength(count);

    buttonNamed(container, "Table").click();
    await settle(container);

    expect(container.querySelector(".deadline-board__grid")).toBeNull();
    expect(container.querySelectorAll(".deadline-table tbody tr")).toHaveLength(count);
    expect(container.querySelector(".deadline-table__date")?.textContent).toMatch(
      /\d{2}:\d{2} AoE/u,
    );
    expect(container.querySelector(".deadline-table__venue")).not.toBeNull();
    expect(container.querySelector(".deadline-table tbody .deadline-card__type")).not.toBeNull();
    expect(buttonNamed(container, "Table").getAttribute("aria-pressed")).toBe("true");
  });

  it("links a workshop name to its homepage and keeps source actions separate", async () => {
    const container = await renderView();
    const workshop = [...container.querySelectorAll<HTMLElement>(".deadline-card")].find(
      (card) => card.dataset.entryType === "workshop",
    )!;

    expect(workshop.querySelector(".deadline-card__type")?.textContent).toBe("Workshop");
    expect(workshop.querySelector(".deadline-card__date")?.textContent).toMatch(/\d{2}:\d{2} AoE/u);
    const venue = buildDeadlineBoardEntries().find(
      (entry) => entry.venue.name === workshop.querySelector(".deadline-card__name")?.textContent,
    )!.venue;
    expect(workshop.querySelector(".deadline-card__group-name")?.textContent).toBe(
      venue.venue_group,
    );
    const title = workshop.querySelector<HTMLAnchorElement>(".deadline-card__name a")!;
    const actions = [
      ...workshop.querySelectorAll<HTMLAnchorElement>(".deadline-card__source--button"),
    ];
    const source = actions.find((link) =>
      /Call for papers|Official site/u.test(link.textContent || ""),
    )!;
    const review = actions.find((link) => link.textContent?.includes("OpenReview"))!;
    expect(title.href).toBe(venue.homepage_url);
    expect(source.href).toBe(venue.cfp_url);
    expect(title.href).not.toBe(source.href);
    expect(title.href).not.toBe(review.href);
    expect(review.textContent).toContain("OpenReview");
    for (const link of [title, source, review]) {
      expect(link.target).toBe("_blank");
      expect(link.rel.split(" ")).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
    }
  });

  it("keeps official conference titles linked across deadline surfaces", async () => {
    const container = await renderView();
    const conference = [...container.querySelectorAll<HTMLElement>(".deadline-card")].find(
      (card) => card.dataset.entryType === "main_conference",
    )!;

    const title = conference.querySelector<HTMLAnchorElement>(".deadline-card__name a")!;
    const source = conference.querySelector<HTMLAnchorElement>(".deadline-card__source")!;
    expect(title.href).toBe(source.href);
    expect(source.classList).toContain("deadline-card__source--button");
  });

  it("ticks the lead and card countdowns every second", async () => {
    const container = await renderView();
    const read = () =>
      container
        .querySelector('.deadline-card:not([data-urgency="passed"]) .deadline-card__countdown')
        ?.textContent?.trim();
    const before = read();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(read()).not.toBe(before);
  });

  it("stops its timer when removed", async () => {
    const container = await renderView();
    const element = container.querySelector("adminbot-deadlines-view")!;
    element.remove();
    const detached = element.querySelector(".deadline-card__countdown")?.textContent;

    await vi.advanceTimersByTimeAsync(5_000);

    expect(element.querySelector(".deadline-card__countdown")?.textContent).toBe(detached);
  });
});
