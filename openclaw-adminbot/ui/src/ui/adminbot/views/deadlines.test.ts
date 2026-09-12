/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DeadlineProposal,
  DeadlineProposalInput,
  DeadlineProposalStore,
} from "../data/deadline-proposals.ts";
import { DEADLINE_VENUES, type DeadlineVenue } from "../data/deadlines.ts";
import {
  archivalLabelOf,
  buildDeadlineBoardEntries,
  conferenceTimeline,
  deadlineChangeLabel,
  deadlineChangeSummary,
  entriesForDeadlinePeriod,
  filterDeadlineBoardEntries,
  groupDeadlineBoardEntries,
  headlineDeadlineEntry,
  mergeArrSubmissionDuplicates,
  milestoneDateLabel,
  venueSchedule,
  workshopGroupLabel,
  priorDeadlineRevisions,
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
  render(renderDeadlines({ proposalStore: new TestProposalStore() }), container);
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
    return DEADLINE_VENUES;
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

  async submitPublic(
    input: DeadlineProposalInput,
    key: string,
    _contact?: { name?: string; email?: string },
  ) {
    await this.submit(input, key);
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

  it("applies type and archival-status filters independently", () => {
    const entries = buildDeadlineBoardEntries();
    const filtered = filterDeadlineBoardEntries(entries, "", "", {
      entryType: "workshop",
      archivalStatus: "mixed",
    });

    expect(filtered.length).toBeGreaterThan(0);
    expect(
      filtered.every(
        (entry) => entry.venue.entry_type === "workshop" && entry.venue.archival_status === "mixed",
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
    expect(
      priorDeadlineRevisions({
        deadline_aoe: "2026-09-25 23:59:00",
        revisions,
      } as DeadlineVenue),
    ).toEqual([revisions[0]]);
  });

  it("ignores seconds-only source corrections in visible history", () => {
    const venue = {
      deadline_aoe: "2026-09-15 23:59:00",
      revisions: [
        { observed_at: "2026-08-01T00:00:00Z", deadline_aoe: "2026-09-15 23:59:32" },
        { observed_at: "2026-09-01T00:00:00Z", deadline_aoe: "2026-09-15 23:59:00" },
      ],
    } as DeadlineVenue;
    expect(priorDeadlineRevisions(venue)).toEqual([]);
    expect(deadlineChangeSummary(venue)).toBeNull();
  });

  it("shows the previous and current date for extensions and corrections", () => {
    const extended = {
      deadline_aoe: "2026-09-05 23:59:00",
      revisions: [
        { observed_at: "2026-08-24T00:00:00Z", deadline_aoe: "2026-08-29 23:59:59" },
        { observed_at: "2026-09-01T00:00:00Z", deadline_aoe: "2026-09-05 23:59:00" },
      ],
    } as DeadlineVenue;
    expect(deadlineChangeLabel(extended)).toBe(
      "Extended: Aug 29, 2026 · 23:59 AoE → Sep 5, 2026 · 23:59 AoE",
    );
    expect(
      deadlineChangeLabel({
        ...extended,
        deadline_aoe: "2026-09-12 23:59:00",
        revisions: [
          extended.revisions[0]!,
          extended.revisions[1]!,
          {
            observed_at: "2026-09-02T00:00:00Z",
            deadline_aoe: "2026-09-12 23:59:00",
          },
        ],
      }),
    ).toBe(
      "Extended: Aug 29, 2026 · 23:59 AoE → Sep 5, 2026 · 23:59 AoE → Sep 12, 2026 · 23:59 AoE",
    );
    expect(
      deadlineChangeSummary({
        ...extended,
        deadline_aoe: "2026-09-12 23:59:00",
        revisions: [
          extended.revisions[0]!,
          extended.revisions[1]!,
          {
            observed_at: "2026-09-02T00:00:00Z",
            deadline_aoe: "2026-09-12 23:59:00",
          },
        ],
      }),
    ).toMatchObject({ kind: "extended", label: "Extended", changeCount: 2 });
    expect(
      deadlineChangeLabel({
        ...extended,
        deadline_aoe: "2026-08-28 00:00:00",
        revisions: [
          extended.revisions[0]!,
          {
            observed_at: "2026-09-01T00:00:00Z",
            deadline_aoe: "2026-08-28 00:00:00",
          },
        ],
      }),
    ).toBe("Corrected: Aug 29, 2026 · 23:59 AoE → Aug 28, 2026 · 00:00 AoE");
  });

  it("labels publication policy without reference to venue priority", () => {
    const venue = {
      archival_status: "archival",
      entry_type: "main_conference",
      venue_priority: "primary",
    } as DeadlineVenue;
    expect(archivalLabelOf(venue)).toBe("Archival");
    expect(archivalLabelOf({ ...venue, archival_status: "unknown" })).toBe(
      "Archival status not established",
    );
    expect(archivalLabelOf({ ...venue, archival_status: "non_archival" })).toBe("Non-archival");
    expect(archivalLabelOf({ ...venue, archival_status: "mixed" })).toBe("Archival + non-archival");
  });

  it("groups both axes, and never loses or duplicates a deadline", () => {
    const entries = buildDeadlineBoardEntries();
    const groups = groupDeadlineBoardEntries(entries);

    // Nothing may be dropped or double-counted by the split into groups and standalone cards.
    expect(groups.flatMap((group) => group.entries)).toHaveLength(entries.length);
    expect(
      groups
        .flatMap((group) => group.entries)
        .map((entry) => entry.venue.id)
        .toSorted(),
    ).toEqual(entries.map((entry) => entry.venue.id).toSorted());

    // A group never mixes the two axes: a workshop bundle holds only workshops, a conference
    // holds none.
    for (const group of groups) {
      const workshops = group.entries.filter((entry) => entry.venue.entry_type === "workshop");
      expect(workshops.length).toBe(group.kind === "workshops" ? group.entries.length : 0);
      // A timeline is a conference affordance; a workshop bundle never pays for building one.
      if (group.kind === "workshops") {
        expect(group.timeline).toEqual([]);
      } else {
        expect(group.timeline.length).toBeGreaterThanOrEqual(group.entries.length);
      }
    }

    // A conference's deadlines now share one heading rather than scattering into loose cards.
    const iclr = groups.filter((group) => group.entries[0]?.venue.venue_group === "ICLR 2027");
    expect(iclr).toHaveLength(1);
    expect(iclr[0]?.kind).toBe("conference");
    expect(iclr[0]?.standalone).toBe(false);
    expect(iclr[0]?.entries.map((entry) => entry.venue.deadline_label).toSorted()).toEqual([
      "abstract deadline",
      "full paper",
    ]);

    const neurips = entries.filter((entry) => entry.venue.venue_group === "NeurIPS 2026 Workshops");
    const neuripsGroup = groups.find((group) => group.label === "Workshops of NeurIPS 2026");
    expect(neurips.length).toBeGreaterThan(100);
    expect(neuripsGroup?.standalone).toBe(false);
    expect(neuripsGroup?.entries.length).toBe(neurips.length);
    expect(neuripsGroup?.sections.nonArchival.length).toBe(neurips.length);

    const emnlpGroup = groups.find((group) => group.label === "Workshops of EMNLP 2026");
    expect(emnlpGroup?.sections.mixed.length).toBeGreaterThan(0);
  });

  it("orders a conference timeline by date and deduplicates the shared stages", () => {
    const groups = groupDeadlineBoardEntries(buildDeadlineBoardEntries());
    const iclr = groups.find((group) => group.label === "ICLR 2027")!;

    // The two submissions first, then the calendar behind them -- and the four downstream dates
    // ICLR repeats on both of its rows appear once each, not twice.
    expect(
      iclr.timeline.map((item) =>
        item.kind === "entry"
          ? [item.entry.venue.deadline_label, item.entry.venue.deadline_aoe.slice(0, 10)]
          : [item.label, item.day],
      ),
    ).toEqual([
      ["abstract deadline", "2026-09-18"],
      ["full paper", "2026-09-25"],
      ["Reviews released", "2026-11-05"],
      ["Author-reviewer discussion", "2026-11-05"],
      ["Final decisions", "2026-12-16"],
      ["Conference", "2027-04-26"],
    ]);
  });

  it("names the submission behind a stage two tracks date differently", () => {
    const groups = groupDeadlineBoardEntries(buildDeadlineBoardEntries());
    const aacl = groups.find((group) => group.label === "AACL-IJCNLP 2026")!;
    const cameraReady = aacl.timeline.filter(
      (item) => item.kind === "milestone" && item.milestone.milestone === "camera_ready",
    );

    // The demo track and the ARR commitment want camera-ready copy a day apart, and each source
    // calls its own row "Camera-ready due". Undisambiguated the panel would print the same words
    // against two dates.
    expect(cameraReady.map((item) => (item.kind === "milestone" ? item.label : ""))).toEqual([
      "Camera-ready due (commitment)",
      "Camera-ready due (demo submission)",
    ]);

    // A stage every submission shares still collapses to one row.
    expect(
      aacl.timeline.filter(
        (item) => item.kind === "milestone" && item.milestone.milestone === "conference",
      ),
    ).toHaveLength(1);
  });

  it("renames a workshop group after its parent, and leaves other labels alone", () => {
    expect(workshopGroupLabel("EMNLP 2026 Workshops")).toBe("Workshops of EMNLP 2026");
    expect(workshopGroupLabel("NeurIPS 2026 Workshops")).toBe("Workshops of NeurIPS 2026");
    // Not a workshop group: spelled exactly as the data has it.
    expect(workshopGroupLabel("ICLR 2027")).toBe("ICLR 2027");
    expect(workshopGroupLabel("ARR October 2026")).toBe("ARR October 2026");
  });

  it("leads the countdown with an archival non-workshop deadline", () => {
    const entries = buildDeadlineBoardEntries();
    const upcoming = entriesForDeadlinePeriod(
      entries,
      Date.parse("2026-08-24T12:00:00Z"),
      "upcoming",
    );

    // The nearest deadline overall is a workshop; the headline must skip past it.
    expect(upcoming[0]?.venue.entry_type).toBe("workshop");
    const headline = headlineDeadlineEntry(upcoming);
    expect(headline?.venue.entry_type).not.toBe("workshop");
    expect(headline?.venue.archival_status).toBe("archival");

    // With nothing but workshops left, an imperfect headline still beats an empty one.
    const workshopsOnly = upcoming.filter((entry) => entry.venue.entry_type === "workshop");
    expect(headlineDeadlineEntry(workshopsOnly)).toBe(workshopsOnly[0]);
    expect(headlineDeadlineEntry([])).toBeUndefined();
  });

  it("merges a conference into the ARR cycle it submits through", () => {
    const entries = buildDeadlineBoardEntries();
    const atOct12 = entries.filter(
      (entry) =>
        entry.venue.entry_type === "arr_direct_submission" &&
        entry.venue.deadline_aoe.startsWith("2026-10-12"),
    );

    // NAACL 2027 and the ARR October cycle shared an instant; one card survives.
    expect(atOct12).toHaveLength(1);
    expect(atOct12[0]?.venue.venue_group).toBe("NAACL 2027");
    // The absorbed cycle stays searchable on the survivor.
    expect(atOct12[0]?.venue.name).toContain("ARR October 2026");

    // A cycle with no conference against it is untouched.
    const may = entries.filter((entry) => entry.venue.venue_group === "ARR May 2026");
    expect(may).toHaveLength(1);
    expect(may[0]?.venue.name).not.toContain("via");
  });

  it("leaves an unpaired ARR cycle alone", () => {
    const solo = [
      {
        venue: {
          entry_type: "arr_direct_submission",
          venue_group: "ARR May 2026",
          name: "ARR — May 2026",
          archival_status: "unknown",
        },
        instant: 1,
      },
    ] as unknown as Parameters<typeof mergeArrSubmissionDuplicates>[0];
    expect(mergeArrSubmissionDuplicates(solo)).toHaveLength(1);
  });
});

describe("venue schedule", () => {
  const iclr = {
    id: "iclr2027_paper",
    notification_aoe: "",
    schedule: [
      {
        milestone: "conference",
        label: "Conference",
        kind: "period",
        starts: "2027-04-26",
        ends: "2027-04-30",
      },
      { milestone: "notification", label: "Final decisions", kind: "date", date: "2026-12-16" },
      {
        milestone: "rebuttal",
        label: "Author-reviewer discussion",
        kind: "period",
        starts: "2026-11-05",
        ends: "2026-11-18",
      },
      { milestone: "reviews", label: "Reviews released", kind: "date", date: "2026-11-05" },
    ],
  } as unknown as DeadlineVenue;

  it("orders a schedule by stage, not by date", () => {
    // ICLR releases reviews and opens author discussion on the same day; sorting on the date
    // alone would leave those two in whatever order the source happened to list them.
    expect(venueSchedule(iclr).map((entry) => entry.milestone)).toEqual([
      "reviews",
      "rebuttal",
      "notification",
      "conference",
    ]);
  });

  it("folds a bare notification date into the same list", () => {
    // The ~30 rows that know only when they notify (nearly every workshop) render one list
    // rather than a special case beside it.
    const workshop = {
      notification_aoe: "2026-08-15 23:59:59",
      schedule: [],
    } as unknown as DeadlineVenue;
    expect(venueSchedule(workshop)).toEqual([
      {
        milestone: "notification",
        label: "Accept/reject",
        kind: "deadline",
        date: "2026-08-15 23:59:59",
      },
    ]);
  });

  it("lets the venue's own decision entry win over the bare notification date", () => {
    // "Meta-reviews released" is what ARR calls it, and two decision rows would be worse than
    // either one alone.
    const withBoth = { ...iclr, notification_aoe: "2026-12-01 23:59:59" } as DeadlineVenue;
    const decisions = venueSchedule(withBoth).filter((entry) => entry.milestone === "notification");
    expect(decisions).toEqual([
      { milestone: "notification", label: "Final decisions", kind: "date", date: "2026-12-16" },
    ]);
  });

  it("reads each date the way its kind says to", () => {
    const [reviews, rebuttal] = venueSchedule(iclr);
    // A day the venue acts on is a plain date: stamping AoE on it would claim a precision the
    // venue never published, and only a cutoff an author has to hit is AoE.
    expect(milestoneDateLabel(reviews!)).toBe("Nov 5, 2026");
    expect(milestoneDateLabel(rebuttal!)).toBe("Nov 5 – Nov 18, 2026");
    expect(
      milestoneDateLabel({
        milestone: "camera_ready",
        label: "Camera-ready due",
        kind: "deadline",
        date: "2026-08-30 23:59:59",
      }),
    ).toBe("Aug 30, 2026 AoE");
    // A span across a year keeps both years.
    expect(
      milestoneDateLabel({
        milestone: "conference",
        label: "Conference",
        kind: "period",
        starts: "2026-12-30",
        ends: "2027-01-02",
      }),
    ).toBe("Dec 30, 2026 – Jan 2, 2027");
  });

  it("carries the real dates for the venues the lab targets", () => {
    // Guards the generated dataset, not the renderer: these come off the venues' own pages, and
    // a regeneration that dropped the field would otherwise only show up as an empty card.
    const paper = DEADLINE_VENUES.find((entry) => entry.id === "iclr2027_paper");
    expect(paper?.deadline_aoe).toBe("2026-09-25 23:59:00");
    expect(
      venueSchedule(paper!).map((entry) => [entry.milestone, milestoneDateLabel(entry)]),
    ).toEqual([
      ["reviews", "Nov 5, 2026"],
      ["rebuttal", "Nov 5 – Nov 18, 2026"],
      ["notification", "Dec 16, 2026"],
      ["conference", "Apr 26 – Apr 30, 2027"],
    ]);
  });
});

describe("renderDeadlines", () => {
  it("lets a visitor submit without exposing proposal history", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const store = new TestProposalStore();
    const submitPublic = vi.spyOn(store, "submitPublic");
    const list = vi.spyOn(store, "list");
    render(renderDeadlines({ role: "anonymous", proposalStore: store }), container);
    await settle(container);
    const propose = buttonNamed(container, "Propose a new deadline");
    expect(propose.disabled).toBe(false);
    expect(container.querySelector('[data-testid="deadline-my-proposals"]')).toBeNull();
    expect(container.querySelector('[data-testid="deadline-review-proposals"]')).toBeNull();
    propose.click();
    await settle(container);
    const form = container.querySelector<HTMLFormElement>(".deadline-proposal__form")!;
    for (const [name, value] of Object.entries(proposalInput())) {
      (form.elements.namedItem(name) as HTMLInputElement).value = value;
    }
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(container);
    expect(submitPublic).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Example Workshop" }),
      expect.any(String),
      { name: "", email: "" },
    );
    expect(list).not.toHaveBeenCalled();
    expect(container.textContent).toContain("It is not public until approved.");
    expect(container.querySelector('[data-testid="deadline-proposal-form-panel"]')).toBeNull();
  });

  it("forwards optional visitor contact details and does not render a spam field", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const store = new TestProposalStore();
    const submit = vi.spyOn(store, "submitPublic");
    render(renderDeadlines({ role: "anonymous", proposalStore: store }), container);
    await settle(container);
    buttonNamed(container, "Propose a new deadline").click();
    await settle(container);
    const form = container.querySelector<HTMLFormElement>(".deadline-proposal__form")!;
    expect(form.elements.namedItem("website")).toBeNull();
    for (const [name, value] of Object.entries(proposalInput())) {
      (form.elements.namedItem(name) as HTMLInputElement).value = value;
    }
    const name = form.elements.namedItem("submitterName") as HTMLInputElement;
    const email = form.elements.namedItem("submitterEmail") as HTMLInputElement;
    expect(name.required).toBe(false);
    expect(email.required).toBe(false);
    expect(email.type).toBe("email");
    name.value = "Taylor Visitor";
    email.value = "taylor@example.org";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(container);
    expect(submit).toHaveBeenCalledWith(expect.any(Object), expect.any(String), {
      name: "Taylor Visitor",
      email: "taylor@example.org",
    });
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
    expect(form.elements.namedItem("submitterName")).toBeNull();
    expect(form.elements.namedItem("submitterEmail")).toBeNull();
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

  it("labels named and unnamed visitor submissions in the review queue", async () => {
    const store = new TestProposalStore();
    const proposal = await store.submit(proposalInput(), "visitor-label");
    store.proposals = [
      { ...proposal, submitter_member_id: "visitor:deadline:named", submitter_name: "Taylor Reed" },
      {
        ...proposal,
        id: "unnamed",
        submitter_member_id: "visitor:deadline:unnamed",
        submitter_name: "External visitor",
      },
    ];
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderDeadlines({ role: "admin", memberId: "admin-1", proposalStore: store }),
      container,
    );
    await settle(container);
    container
      .querySelector<HTMLButtonElement>('[data-testid="deadline-review-proposals"]')!
      .click();
    await settle(container);
    const review = container.querySelector('[data-testid="deadline-proposal-review-panel"]')!;
    const badges = review.querySelectorAll('[data-testid="deadline-proposal-source"]');
    expect(badges).toHaveLength(2);
    for (const badge of badges) {
      expect(badge.textContent?.trim()).toBe("Visitor");
      expect(badge.closest(".deadline-proposal-row__meta")).not.toBeNull();
    }
    expect(review.textContent).toContain("Submitted by Taylor Reed");
    expect(review.textContent).not.toContain("visitor:deadline:");
  });

  it("lets administrators publish the payload shown in the review queue", async () => {
    const input = proposalInput();
    const memberProposal: DeadlineProposal = {
      id: "proposal-1",
      deadline_id: "community-1",
      status: "pending",
      submitter_member_id: "member-1",
      submitter_name: "Ada Member",
      submitter_email: "ada@example.org",
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
    expect(own.textContent).not.toContain("ada@example.org");
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
    expect(
      [...review.querySelectorAll('[data-testid="deadline-proposal-source"]')].every(
        (badge) => badge.textContent?.trim() === "Lab member",
      ),
    ).toBe(true);
    expect(review.textContent).toContain("Submitted by Ada Member");
    expect(review.textContent).toContain("ada@example.org");
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
    ).toHaveLength(2);
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

    // Workshop bundles lead with the word that distinguishes them; everything else keeps the
    // label the data spells.
    expect(labels).toContain("Workshops of EMNLP 2026");
    expect(labels).toContain("Workshops of NeurIPS 2026");
    expect(labels).toContain("ICLR 2027");
    expect(labels).toContain("EACL 2027");
    expect(labels).not.toContain("EMNLP 2026 Workshops");
    expect(labels).not.toContain("Workshops of ICLR 2027");
    expect(labels).not.toContain("Workshops of EACL 2027");

    buttonNamed(container, "Groups").click();
    await settle(container);
    const headings = [...container.querySelectorAll(".deadline-group__heading strong")].map(
      (heading) => heading.textContent?.trim(),
    );
    expect(headings).toContain("Workshops of EMNLP 2026");
    expect(headings).toContain("Workshops of NeurIPS 2026");
    // A conference now heads its own collapsible group, spelled the way the data spells it.
    expect(headings).toContain("ICLR 2027");
    expect(headings).toContain("EACL 2027");
    expect(headings).not.toContain("Workshops of ICLR 2027");
  });

  it("shows publication policy on cards, and no venue-priority badge anywhere", async () => {
    const container = await renderView();
    buttonNamed(container, "Cards").click();
    await settle(container);
    const cards = [...container.querySelectorAll<HTMLElement>(".deadline-card")];

    const workshop = cards.find(
      (card) => card.dataset.entryType === "workshop" && card.dataset.archivalStatus === "mixed",
    )!;
    expect(workshop.querySelector(".deadline-card__urgency")?.textContent?.trim()).not.toBe("");
    expect(workshop.querySelector(".deadline-archival")?.textContent?.trim()).toBe(
      "Archival + non-archival",
    );

    // The archival label survives on a conference; the priority badge is gone from every card,
    // including the venues that used to carry Primary and Secondary.
    const archivalConference = cards.find(
      (card) =>
        card.dataset.archivalStatus === "archival" &&
        ["main_conference", "demo_track"].includes(card.dataset.entryType ?? ""),
    )!;
    expect(
      archivalConference.querySelector('[data-archival="archival"]')?.textContent?.trim(),
    ).toBe("Archival");
    expect(container.querySelectorAll(".deadline-priority")).toHaveLength(0);
    expect(container.querySelectorAll("[data-priority]")).toHaveLength(0);
    expect(container.textContent).not.toContain("Primary");
    expect(container.textContent).not.toContain("Secondary");

    buttonNamed(container, "Groups").click();
    await settle(container);
    const workshopGroup = [...container.querySelectorAll<HTMLElement>(".deadline-group")].find(
      (group) =>
        group
          .querySelector(".deadline-group__heading")
          ?.textContent?.includes("Workshops of NeurIPS 2026"),
    )!;
    const workshopNote = workshopGroup.querySelector<HTMLElement>(".deadline-group__row-note")!;
    expect(workshopNote.querySelector(".deadline-card__labels")).not.toBeNull();
    expect(workshopNote.querySelector(".deadline-card__type")?.textContent?.trim()).toBe(
      "Workshop",
    );
    expect(container.querySelectorAll(".deadline-priority")).toHaveLength(0);
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
    ].find((candidate) => candidate.textContent?.includes("Workshops of NeurIPS 2026"))!;

    button.click();
    await settle(container);

    const groups = [...container.querySelectorAll(".deadline-card__group")].map(
      (node) => node.textContent?.trim() ?? "",
    );
    expect(groups.length).toBeGreaterThan(50);
    expect(groups.every((label) => label.startsWith("Workshops of NeurIPS 2026"))).toBe(true);
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
    expect(cards[0].querySelector(".deadline-card__change")).toBeNull();
    expect(
      cards[0].querySelector(".deadline-card__date-row > .deadline-card__history"),
    ).not.toBeNull();
    expect(cards[0].querySelector(".deadline-card__date .deadline-date")).not.toBeNull();
    expect(cards[0].querySelector(".deadline-card__date .deadline-time")).not.toBeNull();
    const historyTrigger = cards[0].querySelector<HTMLButtonElement>(
      ".deadline-card__history-trigger",
    );
    expect(historyTrigger?.tagName).toBe("BUTTON");
    expect(historyTrigger?.textContent?.trim()).toBe("");
    expect(historyTrigger?.querySelector("svg")).not.toBeNull();
    expect(historyTrigger?.classList.contains("btn--icon")).toBe(true);
    expect(historyTrigger?.getAttribute("aria-haspopup")).toBe("dialog");
    const historyCount = cards[0].querySelectorAll(".deadline-card__history-panel li").length;
    expect(historyCount).toBeGreaterThan(0);
    expect(historyTrigger?.getAttribute("data-tooltip")).toBe("Deadline details");
    expect(historyTrigger?.getAttribute("popovertarget")).toMatch(/^deadline-history-/u);
    expect(historyTrigger?.closest(".deadline-card__history")?.getAttribute("data-change")).toBe(
      "extended",
    );
    const hero = container.querySelector(".deadline-board__hero");
    expect(hero?.getAttribute("data-change")).toBe("extended");
    expect(hero?.querySelector(".deadline-card__change")).toBeNull();
    expect(
      hero?.querySelector(".deadline-board__hero-date + .deadline-card__history"),
    ).not.toBeNull();
    expect(hero?.querySelector(".deadline-board__hero-date .deadline-date")?.textContent).toContain(
      "Sep 1, 2026",
    );
    expect(hero?.querySelector(".deadline-board__hero-date .deadline-time")?.textContent).toContain(
      "11:59 AoE",
    );
    buttonNamed(container, "Table").click();
    await settle(container);
    expect(container.querySelector(".deadline-table__change")).toBeNull();
    expect(
      container.querySelector(".deadline-table__date-row > .deadline-card__history"),
    ).not.toBeNull();
    expect(container.querySelector(".deadline-table__date .deadline-date")).not.toBeNull();
    expect(container.querySelector(".deadline-table__date .deadline-time")).not.toBeNull();
    buttonNamed(container, "Groups").click();
    await settle(container);
    const groupRow = container.querySelector(".deadline-group__row");
    expect(groupRow?.getAttribute("data-change")).toBe("extended");
    expect(groupRow?.querySelector(".deadline-group__row-detail")?.textContent).toBe(
      "ARR commitment",
    );
    expect(
      groupRow?.querySelector(".deadline-group__row-date-wrap > .deadline-card__history"),
    ).not.toBeNull();
    expect(groupRow?.querySelector(".deadline-group__row-date .deadline-date")).not.toBeNull();
    expect(groupRow?.querySelector(".deadline-group__row-date .deadline-time")).not.toBeNull();
    expect(groupRow?.querySelector(".deadline-change__badge")).toBeNull();
    expect(buttonNamed(container, "All 1")).toBeDefined();
    const stats = [...container.querySelectorAll(".deadline-board__stats > div")];
    expect(stats[0]?.querySelector("dt")?.textContent).toBe("Matching deadlines");
    expect(stats[0]?.querySelector("dd")?.textContent).toBe("1");
    expect(stats[1]?.querySelector("dt")?.textContent).toBe("Due today");
    expect(stats[1]?.querySelector("dd")?.textContent).toBe("0");
  });

  it("updates groups, summary, and the active group for combined filters", async () => {
    const container = await renderView();
    const workshopGroup = [
      ...container.querySelectorAll<HTMLButtonElement>(".deadline-board__groups button"),
    ].find((button) => button.textContent?.includes("Workshops of NeurIPS 2026"))!;
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

    // The priority facet is gone; the two that remain are the whole filter bar.
    expect(container.querySelector('[data-testid="deadline-filter-priority"]')).toBeNull();
    expect(
      container.querySelectorAll<HTMLSelectElement>(".deadline-board__facet select"),
    ).toHaveLength(2);
  });

  it("drops a conference open onto its camera-ready and conference dates", async () => {
    const container = await renderView("default");
    const iclr = [...container.querySelectorAll<HTMLElement>(".deadline-group")].find(
      (group) =>
        group.querySelector(".deadline-group__heading strong")?.textContent?.trim() === "ICLR 2027",
    )!;
    expect(iclr.dataset.groupKind).toBe("conference");

    // Collapsing a conference must not hide which deadline the countdown belongs to -- that was
    // the whole reason conferences stayed flat before.
    expect(iclr.querySelector(".deadline-group__next-stage")?.textContent?.trim()).toBe(
      "Abstract deadline",
    );
    expect(iclr.querySelector(".deadline-group__count")?.textContent?.trim()).toBe(
      "2 deadlines · 4 more dates",
    );

    iclr.querySelector<HTMLButtonElement>(".deadline-group__summary")!.click();
    await settle(container);
    const open = [...container.querySelectorAll<HTMLElement>(".deadline-group")].find(
      (group) =>
        group.querySelector(".deadline-group__heading strong")?.textContent?.trim() === "ICLR 2027",
    )!;
    const timeline = open.querySelector<HTMLElement>(
      '[data-testid="deadline-conference-timeline"]',
    )!;
    expect(
      [...timeline.querySelectorAll(".deadline-group__row-name")].map((row) =>
        row.textContent?.trim(),
      ),
    ).toEqual([
      "Abstract deadline",
      "Full paper",
      "Reviews released",
      "Author-reviewer discussion",
      "Final decisions",
      "Conference",
    ]);

    // A stage the venue acts on carries its date but no countdown: nothing is due on it.
    const conference = [...timeline.querySelectorAll<HTMLElement>(".deadline-group__row")].at(-1)!;
    expect(conference.classList).toContain("deadline-group__row--milestone");
    expect(conference.dataset.milestone).toBe("conference");
    expect(conference.querySelector(".deadline-group__row-date")?.textContent).toMatch(/Apr 26/u);
    expect(conference.querySelector(".deadline-group__row-countdown")?.textContent?.trim()).toBe(
      "",
    );
    expect(conference.querySelector(".deadline-card__actions")).toBeNull();
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
      "deadline-group__row-date-wrap",
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

  it("keeps the countdown on the submission and the whole timeline beside it", async () => {
    const container = await renderView();
    const iclr = [...container.querySelectorAll<HTMLElement>(".deadline-card")].find(
      (card) =>
        card.querySelector(".deadline-card__name")?.textContent?.trim() === "ICLR 2027" &&
        card.querySelector(".deadline-card__stage")?.textContent?.trim() === "Full paper",
    )!;

    // The highlighted date and the countdown are still the submission, and nothing else on the
    // card counts down: a rebuttal window six months out must not compete with what is due next.
    expect(iclr.querySelector(".deadline-card__date")?.textContent).toContain("Sep 25, 2026");
    expect(iclr.querySelector(".deadline-card__countdown")?.textContent?.trim()).toMatch(/^\d+d /u);

    // Five entries, so the list is behind a disclosure rather than doubling the card's height.
    const schedule = iclr.querySelector<HTMLElement>('[data-testid="deadline-schedule"]')!;
    expect(schedule.tagName).toBe("DETAILS");
    expect(schedule.querySelector("summary")?.textContent).toContain("Full timeline (5)");
    expect(
      [...schedule.querySelectorAll(".deadline-card__milestone")].map((row) => [
        row.querySelector(".deadline-card__milestone-label")?.textContent?.trim(),
        row.querySelector(".deadline-card__milestone-date")?.textContent?.trim(),
      ]),
    ).toEqual([
      // The submission leads its own timeline, so the list reads as a whole sequence rather than
      // starting mid-story. It is the same date the card counts down to above, not a second one.
      ["Full paper", "Sep 25, 2026 AoE"],
      ["Reviews released", "Nov 5, 2026"],
      ["Author-reviewer discussion", "Nov 5 – Nov 18, 2026"],
      ["Final decisions", "Dec 16, 2026"],
      ["Conference", "Apr 26 – Apr 30, 2027"],
    ]);
    expect(schedule.querySelector(".deadline-card__countdown")).toBeNull();
  });

  it("leaves a lone notification date inline, where the old note was", async () => {
    const container = await renderView();
    const workshop = [...container.querySelectorAll<HTMLElement>(".deadline-card")].find(
      (card) =>
        card.dataset.entryType === "workshop" &&
        card.querySelector('[data-testid="deadline-schedule"]'),
    )!;
    const schedule = workshop.querySelector<HTMLElement>('[data-testid="deadline-schedule"]')!;
    // One or two lines cost nothing open, and that is what nearly every workshop has.
    expect(schedule.tagName).toBe("UL");
    expect(schedule.textContent).toContain("Accept/reject");
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
      workshopGroupLabel(venue.venue_group),
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

it("submits an existing deadline correction with its stable target ID", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const store = new TestProposalStore();
  const submit = vi.spyOn(store, "submit");
  render(
    renderDeadlines({ role: "member", memberId: "member-1", proposalStore: store }),
    container,
  );
  await settle(container);
  const correction = container.querySelector<HTMLButtonElement>(
    'button[aria-label^="Suggest correction:"]',
  );
  expect(correction).not.toBeNull();
  correction!.click();
  await settle(container);
  const form = container.querySelector<HTMLFormElement>(".deadline-proposal__form")!;
  const name = (form.elements.namedItem("name") as HTMLInputElement).value;
  const date = (form.elements.namedItem("deadlineDate") as HTMLInputElement).value;
  const target = DEADLINE_VENUES.find(
    (row) => row.name === name && row.deadline_aoe.startsWith(date),
  );
  expect(target).toBeDefined();
  expect(container.textContent).toContain(
    `Correct ${target!.name}: ${target!.deadline_label.charAt(0).toUpperCase()}${target!.deadline_label.slice(1)}`,
  );
  (form.elements.namedItem("deadlineDate") as HTMLInputElement).value = "2026-10-01";
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle(container);
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ deadlineDate: "2026-10-01" }),
    expect.any(String),
    target!.id,
  );
  expect(store.proposals[0].status).toBe("pending");
});

it("never displays bundled deadlines when the first live request fails and supports retry", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const store = new TestProposalStore();
  const load = vi.spyOn(store, "listPublished").mockRejectedValue(new Error("offline"));
  render(renderDeadlines({ proposalStore: store }), container);
  await settle(container);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not load live deadlines",
  );
  expect(container.textContent).not.toContain("ICLR 2027");
  expect(container.querySelector(".deadline-card")).toBeNull();
  load.mockResolvedValue(DEADLINE_VENUES);
  buttonNamed(container, "Retry").click();
  await settle(container);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("ICLR 2027");
});

it("labels retained server data when a later refresh fails", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const store = new TestProposalStore();
  const live = [
    {
      ...DEADLINE_VENUES[0],
      id: "live-only",
      name: "Server-only workshop",
      deadline_aoe: "2035-09-25 23:59:00",
    },
  ];
  const load = vi.spyOn(store, "listPublished").mockResolvedValue(live);
  render(renderDeadlines({ proposalStore: store }), container);
  await settle(container);
  load.mockRejectedValue(new Error("offline"));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  await settle(container);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "last successful server response",
  );
  expect(container.textContent).toContain("Server-only workshop");
  expect(container.textContent).not.toContain("ICLR 2027");
  vi.restoreAllMocks();
});

it("starts with a loading state and no bundled records", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const store = new TestProposalStore();
  vi.spyOn(store, "listPublished").mockImplementation(() => new Promise(() => {}));
  render(renderDeadlines({ proposalStore: store }), container);
  await settle(container);
  expect(container.textContent).toContain("Loading live deadlines");
  expect(container.textContent).not.toContain("ICLR 2027");
});
