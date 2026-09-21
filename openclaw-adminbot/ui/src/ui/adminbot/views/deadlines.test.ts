/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
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
  milestoneEndInstant,
  nextVenueStage,
  venueSchedule,
  workshopGroupLabel,
  priorDeadlineRevisions,
  renderDeadlines,
  venueConferenceSites,
  venueLocationLabel,
  venueLocationSites,
  workshopSourceLinks,
} from "./deadlines.ts";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  // Existing layout assertions use a fixed display zone, independent of the test machine.
  window.localStorage.setItem("adminbot.deadlines.display-timezone", "Etc/GMT+12");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-24T12:00:00Z"));
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
      sourceLabel: "CFP",
      openReviewUrl: "https://openreview.net/group?id=Example/Workshop",
    });
    expect(workshopSourceLinks({ ...workshop, cfp_url: "", openreview_url: "" })).toEqual({
      titleUrl: "https://workshop.example",
      sourceUrl: "https://workshop.example",
      sourceLabel: "Website",
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

  it("keeps a conference upcoming until its whole calendar is behind us", () => {
    const entries = buildDeadlineBoardEntries();
    // Months after ICLR 2027 closed both of its submissions and released decisions, and months
    // before it meets in Yokohama on 26 April.
    const now = Date.parse("2027-01-15T12:00:00Z");
    const upcoming = entriesForDeadlinePeriod(entries, now, "upcoming");
    const past = entriesForDeadlinePeriod(entries, now, "past");

    const iclr = upcoming.filter((entry) => entry.venue.venue_group === "ICLR 2027");
    expect(iclr).toHaveLength(2);
    expect(iclr.every((entry) => entry.instant < now)).toBe(true);
    expect(past.some((entry) => entry.venue.venue_group === "ICLR 2027")).toBe(false);
    expect(nextVenueStage(iclr[0]!.venue, now)?.label).toBe("Conference");

    // Ordered by the stage each row is waiting on, not by the deadline it already closed.
    const targets = upcoming.map((entry) => nextVenueStage(entry.venue, now)!.instant);
    expect(targets).toEqual(targets.toSorted((left, right) => left - right));

    // Nothing published behind the deadline means nothing left to wait for: the row drops into
    // Past the moment it closes, exactly as it always did.
    const bare = {
      deadline_aoe: "2026-09-14 23:59:59",
      deadline_label: "full paper",
      schedule: [],
    } as unknown as DeadlineVenue;
    expect(nextVenueStage(bare, now)).toBeUndefined();

    // A conference is still happening on its last day, so a span is read to its end.
    const meeting = {
      ...bare,
      schedule: [
        {
          milestone: "conference",
          label: "Conference",
          kind: "period",
          starts: "2027-04-26",
          ends: "2027-04-30",
        },
      ],
    } as unknown as DeadlineVenue;
    expect(nextVenueStage(meeting, Date.parse("2027-04-28T00:00:00Z"))?.label).toBe("Conference");
    expect(nextVenueStage(meeting, Date.parse("2027-05-02T00:00:00Z"))).toBeUndefined();
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
    expect(archivalLabelOf(venue)).toContain("Archival");
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
  it("keeps the proposal button at the bottom and opens its dialog", async () => {
    const container = await renderView("default");
    const trigger = buttonNamed(container, "Propose a new deadline");
    expect(container.querySelector(".deadline-board")?.lastElementChild).toBe(
      trigger.parentElement,
    );
    expect(container.querySelector(".deadline-board__foot")).toBeNull();
    trigger.click();
    await settle(container);
    expect(container.querySelector('[data-testid="deadline-proposal-form-panel"]')).not.toBeNull();
  });

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
    ).toContain("Time zone unknown");
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

  it("renders the board hierarchy without an embedded page", async () => {
    const container = await renderView();

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector(".deadline-board__header")?.textContent).toContain(
      "Latest source check",
    );
    expect(container.querySelector(".deadline-board__hero")).not.toBeNull();
    // The hero stands alone above the board: the four summary tiles ("Matching deadlines",
    // "Due today", "Due within 7/30 days") were removed, and the footer carries the count.
    expect(container.querySelector(".deadline-board__stats")).toBeNull();
    expect(
      container.querySelector<HTMLInputElement>('.deadline-board__search input[type="search"]')
        ?.placeholder,
    ).toBe("Search conferences & workshops…");
    expect(
      container.querySelectorAll<HTMLSelectElement>(".deadline-board__facet select"),
    ).toHaveLength(4);
    expect(
      [
        ...container.querySelectorAll<HTMLSelectElement>(
          ".deadline-board__facet select:not([data-testid=deadline-filter-stage])",
        ),
      ].every((select) =>
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
    expect(container.querySelector(".deadline-board__guide")).toBeNull();
    expect(container.querySelector(".deadline-archival__explanation")?.textContent).toContain(
      "Check",
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

    const groups = [...container.querySelectorAll(".deadline-card")].map(
      (card) =>
        card.querySelector(".deadline-card__group")?.getAttribute("title") ??
        card.querySelector(".deadline-card__name")?.textContent?.trim() ??
        "",
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
    expect(workshop.querySelector(".deadline-archival")?.textContent?.trim()).toContain(
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
    ).toContain("Archival");
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
    // Workshops rather than ARR commitments: Past holds only venues whose whole calendar is over,
    // and an ARR commitment made by this date is still waiting on its conference.
    entryType.value = "workshop";
    entryType.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(container);
    const filteredCards = [...container.querySelectorAll<HTMLElement>(".deadline-card")];
    expect(filteredCards.length).toBeGreaterThan(0);
    expect(filteredCards.every((card) => card.dataset.entryType === "workshop")).toBe(true);
    expect(buttonNamed(container, "Past").getAttribute("aria-pressed")).toBe("true");
  });

  it("filters directly to one workshop group", async () => {
    const container = await renderView();
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>(".deadline-board__groups button"),
    ].find((candidate) => candidate.textContent?.includes("Workshops of NeurIPS 2026"))!;

    button.click();
    await settle(container);

    const groups = [...container.querySelectorAll(".deadline-card")].map(
      (card) =>
        card.querySelector(".deadline-card__group")?.getAttribute("title") ??
        card.querySelector(".deadline-card__name")?.textContent?.trim() ??
        "",
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
    expect(groupRow?.querySelector(".deadline-group__date-stage > span")?.textContent).toBe(
      "ARR commitment",
    );
    expect(
      groupRow?.querySelector(".deadline-group__row-date-wrap .deadline-card__history"),
    ).not.toBeNull();
    expect(groupRow?.querySelector(".deadline-group__row-date .deadline-date")).not.toBeNull();
    expect(groupRow?.querySelector(".deadline-group__row-date .deadline-time")).not.toBeNull();
    expect(groupRow?.querySelector(".deadline-change__badge")).toBeNull();
    expect(buttonNamed(container, "All 1")).toBeDefined();
    expect(container.querySelector(".deadline-board__foot")).toBeNull();
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
    expect(container.querySelector(".deadline-board__foot")).toBeNull();

    // Entry type, archival status, and location are independent facets.
    expect(container.querySelector('[data-testid="deadline-filter-priority"]')).toBeNull();
    expect(
      container.querySelectorAll<HTMLSelectElement>(".deadline-board__facet select"),
    ).toHaveLength(4);
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
    expect(
      iclr.querySelector(".deadline-group__count")?.textContent?.replace(/\s+/g, " ").trim(),
    ).toBe("2 deadlines · 4 more dates");

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
    const count = Number(
      container.querySelector('[data-testid="deadline-group-all"] span')?.textContent,
    );
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
    expect(openGroup.querySelectorAll(".deadline-group__shared-policy")).toHaveLength(1);
    expect(openGroup.querySelector(".deadline-group__shared-policy")?.textContent).toMatch(
      /Organizers must notify authors by[\s\S]*Source not verified/u,
    );
    expect(openGroup.textContent).not.toContain("Shared notification cutoff unverified.");
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
    ).toEqual(["deadline-card__labels"]);
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

  it("shows the earliest upcoming prerequisite and keeps the whole timeline available", async () => {
    const container = await renderView();
    const iclr = [...container.querySelectorAll<HTMLElement>(".deadline-card")].find(
      (card) =>
        card.querySelector(".deadline-card__name")?.textContent?.trim() === "ICLR 2027" &&
        card.querySelector(".deadline-card__stage")?.textContent?.trim() === "Abstract",
    )!;

    // The earlier prerequisite drives the card; the full schedule remains expandable.
    expect(iclr.querySelector(".deadline-card__date")?.textContent).toContain("Sep 18, 2026");
    expect(iclr.querySelector(".deadline-card__countdown")?.textContent?.trim()).toMatch(/^\d+d /u);

    // Six entries, so the list is behind a disclosure rather than doubling the card's height.
    const schedule = iclr.querySelector<HTMLElement>('[data-testid="deadline-schedule"]')!;
    const toggle = schedule.querySelector<HTMLButtonElement>(".deadline-schedule-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    await settle(container);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(
      [...schedule.querySelectorAll(".deadline-card__milestone")].map((row) => [
        row.querySelector(".deadline-card__milestone-label")?.textContent?.trim(),
        row
          .querySelector(".deadline-card__milestone-date")
          ?.textContent?.replace(/\s+/g, " ")
          .trim(),
      ]),
    ).toEqual([
      ["Abstract", "Sep 18, 2026 · 23:59 AoE"],
      ["Full paper", "Sep 25, 2026 · 23:59 AoE"],
      ["Reviews released", "Nov 5, 2026"],
      ["Author-reviewer discussion", "Nov 5 – Nov 18, 2026"],
      ["Final decisions", "Dec 16, 2026"],
      ["Conference", "Apr 26 – Apr 30, 2027"],
    ]);
    expect(schedule.querySelector(".deadline-card__countdown")).toBeNull();
  });

  it("does not present a shared organizer cutoff as a workshop schedule stage", async () => {
    const container = await renderView();
    for (const card of container.querySelectorAll<HTMLElement>('[data-entry-type="workshop"]')) {
      card.querySelector<HTMLButtonElement>(".deadline-schedule-toggle")?.click();
    }
    await settle(container);
    expect(container.querySelector('[data-milestone="notification_by"]')).toBeNull();
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
    const source = actions.find((link) => /CFP|Website/u.test(link.textContent || ""))!;
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

  it("passes the abstract row and advances the conference to full paper at the cutoff", async () => {
    const abstract = DEADLINE_VENUES.find((venue) => venue.id === "iclr2027_abstract")!;
    const cutoff = Date.parse(abstract.deadline_aoe.replace(" ", "T") + "-12:00");
    vi.setSystemTime(cutoff - 1_000);
    const container = await renderView("default");
    const group = () =>
      [...container.querySelectorAll<HTMLElement>(".deadline-group")].find(
        (entry) =>
          entry.querySelector(".deadline-group__heading strong")?.textContent?.trim() ===
          "ICLR 2027",
      )!;
    group().querySelector<HTMLButtonElement>(".deadline-group__summary")!.click();
    await settle(container);
    const rows = () => [...group().querySelectorAll(".deadline-group__row-countdown")];
    expect(rows()[0].textContent?.trim()).toBe("0d 00:00:01");
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(container);
    expect(rows()[0].textContent?.trim()).toBe("passed");
    expect(rows()[1].textContent?.trim()).toMatch(/^7d /u);
    expect(group().querySelector(".deadline-group__next-stage")?.textContent?.trim()).toBe(
      "Full paper",
    );
    for (const [view, selector, countdown] of [
      ["Cards", ".deadline-card", ".deadline-card__countdown"],
      ["Table", ".deadline-table tbody tr", ".deadline-table__countdown"],
    ]) {
      buttonNamed(container, view).click();
      await settle(container);
      const row = [...container.querySelectorAll(selector)].find(
        (node) =>
          node.textContent?.includes("ICLR 2027") &&
          node
            .querySelector(".deadline-card__date, .deadline-table__date-row")
            ?.textContent?.trim()
            .startsWith("Sep 25, 2026"),
      )!;
      expect(row.querySelector(countdown)?.textContent?.trim()).toMatch(/^7d /u);
      expect(row.getAttribute("data-urgency")).not.toBe("passed");
    }
  });

  it("names the next stage and its date after all ICLR submissions close", async () => {
    vi.setSystemTime(new Date("2026-09-27T12:00:00Z"));
    const container = await renderView("default");
    const chip = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/gu, " ").trim() === "ICLR 2027 2",
    )!;
    chip.click();
    await settle(container);
    expect(container.querySelector(".deadline-board__hero-meta")?.textContent).toContain(
      "Reviews released",
    );
    expect(container.querySelector(".deadline-board__hero-date")?.textContent?.trim()).toBe(
      "Nov 5, 2026",
    );
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
  expect(load).toHaveBeenCalledTimes(1);
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

describe("add to my timeline", () => {
  async function renderSignedIn(
    options: Partial<Parameters<typeof renderDeadlines>[0]> = {},
  ): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderDeadlines({
        role: "member",
        memberId: "member-1",
        proposalStore: new TestProposalStore(),
        ...options,
      }),
      container,
    );
    await settle(container);
    buttonNamed(container, "Cards").click();
    await settle(container);
    return container;
  }

  function addButtons(container: HTMLElement): HTMLButtonElement[] {
    return [
      ...container.querySelectorAll<HTMLButtonElement>('[data-testid="deadline-add-to-timeline"]'),
    ];
  }

  function venueFor(button: HTMLButtonElement): DeadlineVenue {
    const label = button.getAttribute("aria-label");
    return DEADLINE_VENUES.find(
      (venue) => label === `Add to my timeline: ${venue.name} ${venue.deadline_label}`,
    )!;
  }

  it("adds the deadline to the member's own milestones, keeping the ones they had", async () => {
    const existing = [{ date: "2027-06-12", label: "Graduation" }];
    const onSaveTimeline = vi.fn(async () => true);
    const container = await renderSignedIn({ timelineMilestones: existing, onSaveTimeline });
    const button = addButtons(container)[0];
    expect(button).toBeDefined();
    const label = button.getAttribute("aria-label")!;
    button.click();
    await settle(container);

    expect(onSaveTimeline).toHaveBeenCalledTimes(1);
    const [milestones] = onSaveTimeline.mock.calls[0] as unknown as [Array<Record<string, string>>];
    expect(milestones).toHaveLength(2);
    expect(milestones[0]).toEqual(existing[0]);
    const added = milestones[1];
    const venue = DEADLINE_VENUES.find((row) => row.deadline_id === added.deadline_id)!;
    expect(label).toContain(venue.name);
    expect(added).toMatchObject({
      label: venue.name,
      date: venue.deadline_aoe.slice(0, 10),
      time: venue.deadline_aoe.slice(11, 16),
      timezone: "Etc/GMT+12",
    });
  });

  it("says a deadline is already on the timeline instead of offering it again", async () => {
    const first = await renderSignedIn({
      timelineMilestones: [],
      onSaveTimeline: async () => true,
    });
    const venue = venueFor(addButtons(first)[0]);
    document.body.innerHTML = "";

    const container = await renderSignedIn({
      timelineMilestones: [
        {
          deadline_id: venue.deadline_id,
          date: venue.deadline_aoe.slice(0, 10),
          label: venue.name,
        },
      ],
      onSaveTimeline: async () => true,
    });
    expect(addButtons(container).map(venueFor)).not.toContain(venue);
    expect(container.querySelector('[data-testid="deadline-on-timeline"]')?.textContent).toContain(
      "On your timeline",
    );
  });

  // A save writes the whole list. Offering the button before the member's list has loaded would let
  // one click replace every milestone they already had.
  it("offers nothing until the member's own milestones have loaded", async () => {
    const container = await renderSignedIn({
      timelineMilestones: null,
      onSaveTimeline: async () => true,
    });
    expect(addButtons(container)).toHaveLength(0);
  });

  it("offers nothing to a signed-out visitor", async () => {
    const container = await renderSignedIn({
      role: "anonymous",
      memberId: null,
      timelineMilestones: [],
      onSaveTimeline: async () => true,
    });
    expect(addButtons(container)).toHaveLength(0);
  });

  it("keeps the button off past deadlines", async () => {
    const container = await renderSignedIn({
      timelineMilestones: [],
      onSaveTimeline: async () => true,
    });
    expect(addButtons(container).length).toBeGreaterThan(0);
    buttonNamed(container, "Past").click();
    await settle(container);
    expect(addButtons(container)).toHaveLength(0);
  });

  it.each(["Cards", "Groups", "Table"])(
    "keeps %s actions available through a pending save and retry",
    async (view) => {
      let finish!: (saved: boolean) => void;
      const onSaveTimeline = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      );
      const container = await renderSignedIn({ timelineMilestones: [], onSaveTimeline });
      buttonNamed(container, view).click();
      await settle(container);
      const button = addButtons(container)[0];
      expect(button).toBeDefined();
      const label = button.getAttribute("aria-label");
      button.click();
      await settle(container);
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(addButtons(container).every((action) => action.disabled)).toBe(true);
      expect(container.querySelector('a[aria-label^="Website"]')).not.toBeNull();
      button.click();
      expect(onSaveTimeline).toHaveBeenCalledTimes(1);
      finish(false);
      await settle(container);
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-label")).toBe(label);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't add it");
      button.click();
      await settle(container);
      expect(onSaveTimeline).toHaveBeenCalledTimes(2);
      finish(true);
      await settle(container);
      expect(container.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it("adds the displayed upcoming stage rather than the passed submission to the timeline", async () => {
    const store = new TestProposalStore();
    const workshop = {
      ...DEADLINE_VENUES.find((v) => v.entry_type === "workshop")!,
      deadline_aoe: "2026-08-20 23:59:00",
      deadline_at: "2026-08-21T11:59:00Z",
      schedule: [
        {
          milestone: "notification",
          label: "Decisions",
          kind: "date" as const,
          date: "2026-08-29",
        },
      ],
    };
    vi.spyOn(store, "listPublished").mockResolvedValue([workshop]);
    const save = vi.fn(async () => true);
    const container = await renderSignedIn({
      proposalStore: store,
      timelineMilestones: [],
      onSaveTimeline: save,
    });
    expect(container.textContent).toContain(workshop.name);
    expect(container.textContent).toContain("Decisions");
    expect(addButtons(container)).toHaveLength(1);
    addButtons(container)[0].click();
    await settle(container);
    expect(save).toHaveBeenCalledWith([
      expect.objectContaining({ date: "2026-08-29", label: `${workshop.name} — Decisions` }),
    ]);
  });

  it("says so when the save fails", async () => {
    const container = await renderSignedIn({
      timelineMilestones: [],
      onSaveTimeline: async () => false,
    });
    addButtons(container)[0].click();
    await settle(container);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't add it");
  });
});

describe("venue location", () => {
  it("splits a multi-site conference into every site it publishes", () => {
    // NeurIPS 2026 is genuinely three meetings. Naming only Sydney would tell an Atlanta or
    // Paris attendee the wrong continent, so all three survive the parse.
    expect(
      venueLocationSites({
        conference_location: "Sydney, Australia; Atlanta, USA; Paris, France",
      } as DeadlineVenue),
    ).toEqual(["Sydney, Australia", "Atlanta, USA", "Paris, France"]);
    expect(
      venueLocationLabel({
        conference_location: "Sydney, Australia; Atlanta, USA; Paris, France",
      } as DeadlineVenue),
    ).toBe("Sydney, Australia · Atlanta, USA · Paris, France");
  });

  it("prefers the workshop's own site over the conference's list of them", () => {
    // The whole point of the field: a NeurIPS 2026 workshop meets in one of the three cities,
    // and the row should name that one rather than making the reader guess between them.
    const venue = {
      conference_location: "Sydney, Australia; Atlanta, USA; Paris, France",
      workshop_location: "Sydney, Australia",
    } as DeadlineVenue;
    expect(venueLocationSites(venue)).toEqual(["Sydney, Australia"]);
    expect(venueLocationLabel(venue)).toBe("Sydney, Australia");
    // The conference's own answer is still reachable, because the group heading needs it.
    expect(venueConferenceSites(venue)).toEqual([
      "Sydney, Australia",
      "Atlanta, USA",
      "Paris, France",
    ]);
  });

  it("falls back to every site when the workshop never said which one", () => {
    // Twenty of the hundred and twenty-five publish no city. Listing all three is the honest
    // answer there, and is what the board showed before it could tell them apart.
    const venue = {
      conference_location: "Sydney, Australia; Atlanta, USA; Paris, France",
      workshop_location: "",
    } as DeadlineVenue;
    expect(venueLocationSites(venue)).toEqual([
      "Sydney, Australia",
      "Atlanta, USA",
      "Paris, France",
    ]);
  });

  it("keeps a single-site location whole, commas and all", () => {
    expect(
      venueLocationSites({ conference_location: "Budapest, Hungary" } as DeadlineVenue),
    ).toEqual(["Budapest, Hungary"]);
  });

  it("reports no sites for a venue with no published location", () => {
    // An ARR cycle has no venue to travel to, and the generator writes "" for it.
    expect(venueLocationSites({ conference_location: "" } as DeadlineVenue)).toEqual([]);
    expect(venueLocationSites({} as DeadlineVenue)).toEqual([]);
    expect(venueLocationLabel({ conference_location: "  ;  " } as DeadlineVenue)).toBe("");
  });

  it("carries conference_location through the generated dataset", () => {
    // Guards the collector's key projection: the field is on the canonical deadlines.json, and
    // dropping it from the slim UI dataset would empty the board's locations silently.
    const located = DEADLINE_VENUES.filter((venue) => venueLocationSites(venue).length);
    expect(located.length).toBeGreaterThan(0);
    expect(located.some((venue) => venueLocationSites(venue).includes("Budapest, Hungary"))).toBe(
      true,
    );
    const neurips = DEADLINE_VENUES.find((venue) => venue.venue_group.includes("NeurIPS 2026"));
    expect(venueLocationSites(neurips!)).toEqual([
      "Sydney, Australia",
      "Atlanta, USA",
      "Paris, France",
    ]);
  });

  it("shows the location on a workshop card, listing every site", async () => {
    const container = await renderView();
    const cards = [...container.querySelectorAll<HTMLElement>(".deadline-card")];
    const neurips = cards.find(
      (card) =>
        card.dataset.entryType === "workshop" &&
        card.querySelector(".deadline-card__group-name")?.textContent?.includes("NeurIPS 2026"),
    )!;
    const location = neurips.querySelector<HTMLElement>(".deadline-location")!;
    expect(location.querySelector(".deadline-location__sites")?.textContent?.trim()).toBe(
      "Sydney, Australia · Atlanta, USA · Paris, France",
    );
    expect(location.dataset.siteCount).toBe("3");
    expect(location.getAttribute("title")).toContain("Multi-site");

    const budapest = cards.find((card) =>
      card.querySelector(".deadline-card__group-name")?.textContent?.includes("EMNLP 2026"),
    )!;
    const single = budapest.querySelector<HTMLElement>(".deadline-location")!;
    expect(single.querySelector(".deadline-location__sites")?.textContent?.trim()).toBe(
      "Budapest, Hungary",
    );
    expect(single.dataset.siteCount).toBe("1");
    expect(single.getAttribute("title")).toBe("Budapest, Hungary");
  });

  it("gives the table a Location column, with an em dash where none is published", async () => {
    const container = await renderView();
    buttonNamed(container, "Table").click();
    await settle(container);
    const headings = [...container.querySelectorAll(".deadline-table th")].map((cell) =>
      cell.textContent?.trim(),
    );
    expect(headings).toContain("Location");

    const cells = [...container.querySelectorAll<HTMLElement>(".deadline-table__location")];
    expect(cells.length).toBeGreaterThan(0);
    // The column heading already names the field, so the cell carries no pin icon.
    expect(
      container.querySelector(".deadline-table__location .deadline-location__icon"),
    ).toBeNull();
    expect(cells.some((cell) => cell.textContent?.trim() === "Budapest, Hungary")).toBe(true);
    expect(
      cells.some(
        (cell) => cell.textContent?.trim() === "Sydney, Australia · Atlanta, USA · Paris, France",
      ),
    ).toBe(true);
    // ARR cycles publish no location and must still occupy the column.
    expect(cells.some((cell) => cell.textContent?.trim() === "—")).toBe(true);
  });

  it("puts the location on the group heading and on every workshop row beneath it", async () => {
    const container = await renderView();
    buttonNamed(container, "Groups").click();
    await settle(container);
    const group = [...container.querySelectorAll<HTMLElement>(".deadline-group")].find(
      (section) =>
        section.dataset.standalone !== "true" &&
        section
          .querySelector(".deadline-group__heading strong")
          ?.textContent?.includes("NeurIPS 2026"),
    )!;
    expect(
      group
        .querySelector(".deadline-group__heading .deadline-location__sites")
        ?.textContent?.trim(),
    ).toBe("Sydney, Australia · Atlanta, USA · Paris, France");
    // Every workshop row carries one too, and names its own city rather than repeating the
    // heading. The heading keeps the full list because it stands for every row beneath it, and
    // because that is what a collapsed group shows.
    const rows = [...group.querySelectorAll<HTMLElement>(".deadline-group__row")];
    expect(rows.length).toBeGreaterThan(1);
    const sites = rows.map((row) =>
      row.querySelector(".deadline-location__sites")?.textContent?.trim(),
    );
    expect(sites.every(Boolean), "a workshop row with no location").toBe(true);
    // At least one row resolved to a single city -- otherwise this would pass against the old
    // behaviour of printing the conference's whole list on every line.
    expect(sites.some((site) => site === "Sydney, Australia")).toBe(true);
  });

  it("puts the location on a standalone group row, which has no heading above it", async () => {
    // Searching down to one workshop leaves its bundle with a single row, which the board
    // renders as a standalone card — no heading, so the row itself has to carry the location.
    const container = await renderView();
    const input = container.querySelector<HTMLInputElement>(".deadline-board__search input")!;
    input.value = "IMPACT-SPEECH";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle(container);
    buttonNamed(container, "Groups").click();
    await settle(container);

    const standalone = [...container.querySelectorAll<HTMLElement>(".deadline-group")].filter(
      (section) => section.dataset.standalone === "true",
    );
    expect(standalone).toHaveLength(1);
    expect(standalone[0].querySelector(".deadline-group__heading")).toBeNull();
    expect(
      standalone[0]
        .querySelector(".deadline-group__row .deadline-location__sites")
        ?.textContent?.trim(),
    ).toBe("Budapest, Hungary");
  });
});

function locationFixtures(): DeadlineVenue[] {
  return [
    ["paris", "Paris, France", "Paris, France; Atlanta, USA"],
    ["atlanta", "Atlanta, USA", "Paris, France; Atlanta, USA"],
    ["inherited", "", "Paris, France; Atlanta, USA"],
    ["unknown", "", ""],
  ].map(([id, workshop_location, conference_location]) => ({
    ...DEADLINE_VENUES[0],
    id,
    deadline_id: id,
    venue_id: id,
    venue_aliases: [],
    name: `Location ${id}`,
    venue_group: "Example Workshops",
    venue_type: "workshop",
    entry_type: "workshop",
    deadline_aoe: "2035-09-25 23:59:00",
    notification_aoe: "",
    schedule: [],
    workshop_location,
    conference_location,
  }));
}

it("filters on workshop sites, inherited possibilities, and unknown locations", () => {
  const entries = buildDeadlineBoardEntries(locationFixtures());
  const matching = (location: string, query = "") =>
    filterDeadlineBoardEntries(entries, "", query, {
      entryType: "all",
      archivalStatus: "all",
      location,
    }).map((entry) => entry.venue.id);
  expect(matching("Paris, France")).toEqual(["inherited", "paris"]);
  expect(matching("Atlanta, USA")).toEqual(["atlanta", "inherited"]);
  expect(matching("unknown")).toEqual(["unknown"]);
  expect(matching("Paris, France", "paris")).toEqual(["paris"]);
  expect(matching("")).toHaveLength(4);
});

it("keeps location selection across views and allows returning to all locations", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const store = new TestProposalStore();
  vi.spyOn(store, "listPublished").mockResolvedValue(locationFixtures());
  render(renderDeadlines({ proposalStore: store }), container);
  await settle(container);
  const select = container.querySelector<HTMLSelectElement>(
    '[data-testid="deadline-filter-location"]',
  )!;
  select.value = "Paris, France";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await settle(container);
  for (const view of ["Cards", "Table", "Groups"]) {
    buttonNamed(container, view).click();
    await settle(container);
    expect(container.textContent).toContain("Location paris");
    expect(container.textContent).toContain("Location inherited");
    expect(container.textContent).not.toContain("Location atlanta");
    expect(
      [...container.querySelectorAll("a")].some(
        (link) => link.textContent?.trim() === "Location unknown",
      ),
    ).toBe(false);
    expect(select.value).toBe("Paris, France");
  }
  select.value = "unknown";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await settle(container);
  buttonNamed(container, "Cards").click();
  await settle(container);
  expect(container.querySelectorAll(".deadline-card")).toHaveLength(1);
  select.value = "";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await settle(container);
  expect(container.querySelectorAll(".deadline-card")).toHaveLength(4);
});

it("shows the source date and a plain conservative countdown in cards", async () => {
  const store = new TestProposalStore();
  store.listPublished = async () => [
    {
      ...DEADLINE_VENUES[0],
      id: "date-only",
      deadline_id: "date-only",
      name: "Example date-only workshop",
      deadline_aoe: "2026-08-28 22:00:00",
      deadline_at: "",
      deadline_date: "2026-08-30",
      deadline_time_precision: "date_only",
      deadline_timezone: "",
      deadline_planning_at: "2026-08-29T10:00:00Z",
      revisions: [],
      schedule: [],
    },
  ];
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderDeadlines({ proposalStore: store, role: "member", memberId: "member-1" }),
    container,
  );
  await settle(container);
  buttonNamed(container, "Cards").click();
  await settle(container);
  const card = container.querySelector(".deadline-card")!;
  expect(card.textContent).toContain("Aug 30, 2026");
  expect(card.textContent).toContain("time unknown");
  expect(card.querySelector(".deadline-card__countdown")?.textContent?.trim()).toBe("4d 22:00:00");
  expect(card.textContent).not.toContain("Plan within");
  expect(card.textContent).toContain("4 days left");
  expect(card.textContent).not.toContain("Time unknown");
  expect(card.querySelector(".deadline-card__date")?.textContent).not.toContain("22:00 AoE");
  container.querySelector<HTMLButtonElement>('button[aria-label^="Suggest correction:"]')!.click();
  await settle(container);
  expect(container.querySelector<HTMLInputElement>('input[name="deadlineDate"]')?.value).toBe(
    "2026-08-30",
  );
  expect(container.querySelector<HTMLInputElement>('input[name="deadlineTime"]')?.value).toBe("");
  expect(container.querySelector<HTMLSelectElement>('select[name="timezone"]')?.value).toBe("");
});

it("labels a learned closing time as updated instead of extended", () => {
  const venue = {
    ...DEADLINE_VENUES[0],
    deadline_aoe: "2035-02-01 23:59:00",
    deadline_time_precision: "exact",
    revisions: [
      {
        observed_at: "2035-01-01T00:00:00Z",
        deadline_aoe: "2035-02-01 00:00:00",
        deadline_date: "2035-02-01",
        deadline_timezone: "AoE",
        deadline_time_precision: "date_only",
      },
    ],
  };
  expect(deadlineChangeSummary(venue)?.kind).toBe("updated");
  expect(deadlineChangeLabel(venue)).toContain("time unknown");
  expect(deadlineChangeLabel(venue)).not.toContain("00:00 AoE");
});

it("persists display zones across login state and updates cards, groups, table and history without changing countdowns", async () => {
  window.localStorage.clear();
  const store = new TestProposalStore();
  store.listPublished = async () => [
    {
      ...DEADLINE_VENUES[0],
      id: "zone-example",
      deadline_id: "zone-example",
      name: "Timezone example",
      deadline_aoe: "2026-09-25 23:59:00",
      deadline_at: "2026-09-26T11:59:00Z",
      deadline_timezone: "AoE",
      deadline_time_precision: "exact",
      schedule: [],
      notification_aoe: "",
      revisions: [
        {
          observed_at: "2026-08-01T00:00:00Z",
          deadline_aoe: "2026-09-24 23:59:00",
          deadline_at: "2026-09-25T11:59:00Z",
          deadline_timezone: "AoE",
        },
      ],
    },
  ];
  const container = document.createElement("div");
  document.body.append(container);
  render(renderDeadlines({ proposalStore: store }), container);
  await settle(container);
  buttonNamed(container, "Cards").click();
  await settle(container);
  const countdown = container.querySelector(".deadline-card__countdown")!.textContent;
  const select = async (zone: string) => {
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Display timezone"]',
    )!;
    input.value = zone;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(container);
  };
  await select("Europe/Zurich");
  expect(container.querySelector(".deadline-card__date")!.textContent).toContain("13:59 UTC+2");
  expect(container.querySelector(".deadline-details__history")!.textContent).toContain(
    "Sep 25, 2026",
  );
  expect(container.querySelector(".deadline-details__facts")!.textContent).toContain("Source date");
  expect(container.querySelector(".deadline-card__countdown")!.textContent).toBe(countdown);
  await select("Original");
  expect(container.querySelector(".deadline-card__date")!.textContent).toContain("23:59 AoE");
  await select("America/Toronto");
  buttonNamed(container, "Groups").click();
  await settle(container);
  expect(container.querySelector(".deadline-group__row-date")!.textContent).toContain(
    "07:59 UTC-4",
  );
  buttonNamed(container, "Table").click();
  await settle(container);
  expect(container.querySelector(".deadline-table__date")!.textContent).toContain("07:59 UTC-4");
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Display timezone"]')!;
  await select("invalid zone");
  expect(input.value).toBe("Toronto (ET)");
  render(
    renderDeadlines({ proposalStore: store, role: "member", memberId: "example-member" }),
    container,
  );
  await settle(container);
  expect(input.value).toBe("Toronto (ET)");
  container.remove();
  const reopened = await renderView();
  expect(
    reopened.querySelector<HTMLInputElement>('input[aria-label="Display timezone"]')!.value,
  ).toBe("Toronto (ET)");
});

it("keeps workshop stage, date, countdown and expansion consistent across views", async () => {
  const venue = {
    ...DEADLINE_VENUES.find((v) => v.venue_type === "workshop")!,
    abstract_requirement: "not_required",
    abstract_deadline_id: "",
    notification_policy: undefined,
    notification_previous_aoe: "",
    id: "stage-fixture",
    name: "Stage workshop",
    venue_group: "Stage workshops",
    deadline_at: "2026-08-20T12:00:00Z",
    deadline_aoe: "2026-08-20 00:00:00",
    deadline_time_precision: "exact",
    deadline_label: "Submission",
    notification_aoe: "",
    schedule: [{ milestone: "notification", label: "Decisions", kind: "date", date: "2026-08-25" }],
  } as DeadlineVenue;
  const store = new TestProposalStore();
  store.listPublished = async () => [venue];
  const container = document.createElement("div");
  document.body.append(container);
  render(renderDeadlines({ proposalStore: store }), container);
  await settle(container);
  buttonNamed(container, "Cards").click();
  await settle(container);
  expect(container.querySelector(".deadline-card__stage")?.textContent).toBe("Decisions");
  expect(container.querySelector(".deadline-card__date")?.textContent).toContain("Aug 25, 2026");
  expect(container.querySelector(".deadline-card__countdown")?.textContent?.trim()).toBe(
    "1d 23:59:59",
  );
  const toggle = container.querySelector<HTMLButtonElement>(
    ".deadline-card .deadline-schedule-toggle",
  )!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.textContent).toContain("Decisions");
  expect(container.querySelector(".deadline-card__group")?.textContent).not.toContain("Decisions");
  toggle.click();
  await settle(container);
  expect(
    container.querySelector('.deadline-card__milestone[data-next="true"]')?.textContent,
  ).toContain("Decisions");
  buttonNamed(container, "Table").click();
  await settle(container);
  expect(container.querySelector(".deadline-table__countdown")?.textContent?.trim()).toBe(
    "1d 23:59:59",
  );
  expect(container.querySelector(".deadline-table__stage")?.textContent).toContain("Decisions");
  expect(container.querySelectorAll(".deadline-table__schedule-row")).toHaveLength(2);
  buttonNamed(container, "Groups").click();
  await settle(container);
  expect(container.querySelector(".deadline-group__row-date")?.textContent).toContain(
    "Aug 25, 2026",
  );
  expect(
    container.querySelector('.deadline-workshop-schedule [data-stage-state="next"]')?.textContent,
  ).toContain("Decisions");
  vi.setSystemTime(new Date("2026-09-01T12:00:00Z"));
  await vi.advanceTimersByTimeAsync(1000);
  buttonNamed(container, "Past").click();
  await settle(container);
  buttonNamed(container, "Cards").click();
  await settle(container);
  expect(container.querySelector(".deadline-card__stage")?.textContent).toBe("Submission");
  expect(container.querySelector(".deadline-card__date")?.textContent).toContain("Aug 20, 2026");
  expect(container.querySelector(".deadline-card__countdown")?.textContent?.trim()).toBe("passed");
});

it("filters by a selected stage and uses its date across views and timeline", async () => {
  const venue = {
    ...DEADLINE_VENUES.find((v) => v.venue_type === "workshop")!,
    id: "selected-stage",
    deadline_id: "selected-stage",
    venue_id: "selected-stage",
    name: "Selected-stage workshop",
    venue_group: "Stage workshops",
    milestone: "full_paper",
    deadline_label: "Submission",
    deadline_at: "2026-08-25T12:00:00Z",
    deadline_aoe: "2026-08-25 00:00:00",
    notification_aoe: "",
    notification_policy: undefined,
    abstract_deadline_id: "",
    schedule: [
      { milestone: "notification", label: "Decisions", kind: "date", date: "2026-08-28" },
      {
        milestone: "camera_ready",
        label: "Camera-ready",
        kind: "deadline",
        date: "2026-09-01 23:59:00",
      },
    ],
  } as DeadlineVenue;
  const missing = {
    ...venue,
    id: "missing-stage",
    deadline_id: "missing-stage",
    name: "No decision date",
    schedule: [],
  };
  const store = new TestProposalStore();
  store.listPublished = async () => [venue, missing];
  const saved = vi.fn(async (_rows: unknown[]) => true);
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderDeadlines({
      proposalStore: store,
      memberId: "member-1",
      role: "member",
      timelineMilestones: [],
      onSaveTimeline: saved,
    }),
    container,
  );
  await settle(container);
  const select = container.querySelector<HTMLSelectElement>(
    '[data-testid="deadline-filter-stage"]',
  )!;
  expect(select.options[0]?.textContent).toBe("All stages (2)");
  expect(select.querySelector('option[value="notification"]')?.textContent).toBe("Decisions (1)");
  select.value = "notification";
  select.dispatchEvent(new Event("change"));
  await settle(container);
  expect(container.querySelector(".deadline-group__row-countdown")?.textContent?.trim()).toBe(
    "4d 23:59:59",
  );
  expect(container.querySelector(".deadline-board__hero")?.textContent).toContain("Decisions");
  buttonNamed(container, "Cards").click();
  await settle(container);
  expect(container.querySelectorAll(".deadline-card")).toHaveLength(1);
  expect(container.querySelector(".deadline-card__stage")?.textContent).toBe("Decisions");
  expect(container.querySelector(".deadline-card__date")?.textContent).toContain("Aug 28, 2026");
  container
    .querySelector<HTMLButtonElement>('.deadline-card [data-testid="deadline-add-to-timeline"]')!
    .click();
  await settle(container);
  expect(saved).toHaveBeenCalledWith([
    expect.objectContaining({ date: "2026-08-28", label: "Selected-stage workshop — Decisions" }),
  ]);
  expect(saved.mock.calls[0]![0][0]).not.toHaveProperty("time");
  buttonNamed(container, "Table").click();
  await settle(container);
  expect(container.querySelector(".deadline-table__countdown")?.textContent?.trim()).toBe(
    "4d 23:59:59",
  );
  expect(container.querySelector(".deadline-table__stage")?.textContent).toContain("Decisions");
  vi.setSystemTime(new Date("2026-08-30T12:00:00Z"));
  await vi.advanceTimersByTimeAsync(1000);
  buttonNamed(container, "Past").click();
  await settle(container);
  expect(container.querySelector(".deadline-table__stage")?.textContent).toContain("Decisions");
  expect(container.querySelector(".deadline-table__countdown")?.textContent?.trim()).toBe("passed");
  expect(venue.deadline_label).toBe("Submission");
});

it("does not repeat a selected shared conference stage across its submission rows", () => {
  const venue = {
    ...DEADLINE_VENUES[0],
    venue_id: "shared-conference",
    track: "main",
    submission_type: "",
    deadline_aoe: "2026-09-01 23:59:00",
    deadline_at: "2026-09-02T11:59:00Z",
    abstract_deadline_id: undefined,
    schedule: [
      { milestone: "notification", label: "Decisions", kind: "date" as const, date: "2026-10-01" },
    ],
  };
  const venues = [
    { ...venue, id: "abstract-row", deadline_id: "abstract-row", milestone: "abstract" },
    { ...venue, id: "paper-row", deadline_id: "paper-row", milestone: "submission" },
  ];
  const rows = entriesForDeadlinePeriod(
    buildDeadlineBoardEntries(venues),
    Date.parse("2026-08-24T12:00:00Z"),
    "upcoming",
    "notification",
    "UTC",
    venues,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].stage?.label).toBe("Decisions");
  expect(conferenceTimeline(rows, venues)).toHaveLength(1);
});

it("uses the earliest upcoming stage by default for main conferences as well as workshops", () => {
  const venue = {
    ...DEADLINE_VENUES[0],
    id: "next-stage",
    venue_type: "conference",
    deadline_aoe: "2026-08-01 23:59:00",
    deadline_at: "2026-08-02T11:59:00Z",
    notification_aoe: "",
    schedule: [
      { milestone: "camera_ready", label: "Camera-ready", kind: "date", date: "2026-10-01" },
      { milestone: "notification", label: "Decisions", kind: "date", date: "2026-09-01" },
    ],
  } as DeadlineVenue;
  const rows = entriesForDeadlinePeriod(buildDeadlineBoardEntries([venue]), Date.now(), "upcoming");
  expect(rows[0]?.stage?.label).toBe("Decisions");
});

it("proposes a single stage for an existing past venue without entering venue details again", async () => {
  const store = new TestProposalStore();
  const past = {
    ...DEADLINE_VENUES[0],
    id: "past",
    deadline_id: "past",
    name: "Past Example Conference",
    deadline_aoe: "2025-01-01 23:59:00",
    deadline_at: "2025-01-02T11:59:00Z",
    schedule: [],
    notification_aoe: "",
    homepage_url: "https://example.org",
  };
  store.listPublished = async () => [past];
  const submit = vi.spyOn(store, "submit");
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderDeadlines({ proposalStore: store, role: "member", memberId: "member-1" }),
    container,
  );
  await settle(container);
  buttonNamed(container, "Propose a new deadline").click();
  await settle(container);
  const picker = container.querySelector(
    "adminbot-deadline-parent-conference-select",
  ) as HTMLElement & { options: string[] };
  picker.dispatchEvent(
    new CustomEvent("selection-change", {
      detail: picker.options.find((x) => x.includes("Past Example Conference")),
      bubbles: true,
    }),
  );
  await settle(container);
  const kind = container.querySelector<HTMLSelectElement>('select[name="stageKind"]')!;
  kind.value = "camera_ready";
  kind.dispatchEvent(new Event("change"));
  await settle(container);
  const form = container.querySelector<HTMLFormElement>(".deadline-proposal__form")!;
  (form.elements.namedItem("deadlineDate") as HTMLInputElement).value = "2026-10-01";
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle(container);
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      deadlineDate: "2026-10-01",
      deadlineTime: "",
      stage: {
        milestone: "camera_ready",
        label: "Camera-ready",
        operation: "add",
        venueId: "past",
      },
    }),
    expect.any(String),
    undefined,
  );
});
it.each(["Cards", "Table"])(
  "opens a stage correction in %s and allows changing its target",
  async (view) => {
    const store = new TestProposalStore();
    store.listPublished = async () => [
      {
        ...DEADLINE_VENUES[0],
        id: "stage-venue",
        deadline_id: "stage-venue",
        name: "Stage Example",
        venue_type: "workshop",
        deadline_aoe: "2026-09-01 23:59:00",
        deadline_at: "2026-09-02T11:59:00Z",
        notification_aoe: "",
        abstract_deadline_id: undefined,
        schedule: [
          { milestone: "camera_ready", label: "Camera-ready", kind: "date", date: "2026-10-01" },
        ],
      },
    ];
    const submit = vi.spyOn(store, "submit");
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderDeadlines({ proposalStore: store, role: "member", memberId: "member-1" }),
      container,
    );
    await settle(container);
    buttonNamed(container, view).click();
    await settle(container);
    container
      .querySelector<HTMLButtonElement>('[aria-label="Schedule for Stage Example"]')!
      .click();
    await settle(container);
    const panel = container.querySelector<HTMLElement>(
      '[aria-label="Deadline details for Stage Example: Camera-ready"]',
    )!;
    expect(panel).not.toBeNull();
    buttonNamed(panel, "Suggest deadline correction").click();
    await settle(container);
    const form = container.querySelector<HTMLFormElement>(".deadline-proposal__form")!;
    expect((form.elements.namedItem("deadlineDate") as HTMLInputElement).value).toBe("2026-10-01");
    expect(form.elements.namedItem("stageKind")).toBeNull();
    expect(
      (
        form.elements.namedItem("correctionStage") as HTMLSelectElement
      ).selectedOptions[0].textContent?.trim(),
    ).toBe("Camera-ready");
    const stageSelect = form.elements.namedItem("correctionStage") as HTMLSelectElement;
    stageSelect.value = "primary";
    stageSelect.dispatchEvent(new Event("change"));
    await settle(container);
    expect((form.elements.namedItem("deadlineDate") as HTMLInputElement).value).toBe("2026-09-01");
    stageSelect.value = "0";
    stageSelect.dispatchEvent(new Event("change"));
    await settle(container);
    expect((form.elements.namedItem("deadlineDate") as HTMLInputElement).value).toBe("2026-10-01");
    (form.elements.namedItem("deadlineDate") as HTMLInputElement).value = "2026-10-03";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(container);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        deadlineDate: "2026-10-03",
        stage: expect.objectContaining({
          milestone: "camera_ready",
          operation: "correct",
          venueId: "stage-venue",
          previous: expect.any(String),
        }),
      }),
      expect.any(String),
      "stage-venue",
    );
  },
);

it("keeps undated workshops in their usual upcoming groups without countdowns", async () => {
  const unknown: DeadlineVenue = {
    ...DEADLINE_VENUES[0],
    id: "undated",
    deadline_id: "undated",
    name: "Undated Workshop",
    venue_type: "workshop",
    entry_type: "workshop",
    venue_group: "Example 2035 Workshops",
    deadline_aoe: "",
    deadline_at: "",
    deadline_planning_at: "",
    deadline_date: "",
    deadline_time_precision: "",
    notification_aoe: "",
    schedule: [],
  };
  const entries = buildDeadlineBoardEntries([unknown]);
  expect(entries).toHaveLength(1);
  expect(entriesForDeadlinePeriod(entries, Date.now(), "upcoming")).toHaveLength(1);
  expect(entriesForDeadlinePeriod(entries, Date.now(), "past")).toHaveLength(0);
  expect(headlineDeadlineEntry(entries)).toBeUndefined();
  expect(groupDeadlineBoardEntries(entries)[0].entries[0].venue.id).toBe("undated");
  const container = document.createElement("div");
  document.body.append(container);
  const store = new TestProposalStore();
  vi.spyOn(store, "listPublished").mockResolvedValue([unknown]);
  render(renderDeadlines({ proposalStore: store }), container);
  await settle(container);
  buttonNamed(container, "Cards").click();
  await settle(container);
  const card = container.querySelector(".deadline-card")!;
  expect(card.textContent).toContain("Deadline unknown");
  expect(card.getAttribute("data-urgency")).toBe("unknown");
  expect(card.querySelector(".deadline-card__countdown")).toBeNull();
  expect(card.querySelector(".deadline-card__urgency")).toBeNull();
  expect(card.textContent).not.toMatch(/NaN|Infinity|passed/);
});

it("uses the same ticking clock in the next deadline summary and its card", async () => {
  const container = await renderView();
  const summary = container.querySelector(".deadline-board__hero-countdown")!;
  const name = container.querySelector(".deadline-board__hero-name")?.textContent?.trim();
  const card = [...container.querySelectorAll(".deadline-card")].find(
    (item) => item.querySelector(".deadline-card__name")?.textContent?.trim() === name,
  )!;
  const firstClock = card.querySelector(".deadline-card__countdown")!;
  expect(summary.textContent?.trim()).toBe(firstClock.textContent?.trim());
  const before = summary.textContent?.trim();
  await vi.advanceTimersByTimeAsync(1000);
  await settle(container);
  expect(summary.textContent?.trim()).not.toBe(before);
  expect(summary.textContent?.trim()).toBe(firstClock.textContent?.trim());
});

it("keeps source links after member-only correction actions", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderDeadlines({
      role: "member",
      memberId: "member-1",
      proposalStore: new TestProposalStore(),
    }),
    container,
  );
  await settle(container);
  buttonNamed(container, "Cards").click();
  await settle(container);
  const footer = container.querySelector(".deadline-card .deadline-details__footer")!;
  expect(footer.firstElementChild?.textContent?.trim()).toBe("Suggest deadline correction");
  expect(footer.lastElementChild?.classList.contains("deadline-card__actions")).toBe(true);
  const policy = container.querySelector<HTMLButtonElement>(".deadline-card .deadline-archival")!;
  expect(
    container.querySelector(`[id="${policy.getAttribute("popovertarget")}"]`)?.getAttribute("role"),
  ).toBe("note");
});

it("uses the supported cutoff for a response period instead of assuming end-of-day AoE", () => {
  expect(
    milestoneEndInstant({
      milestone: "author_response",
      label: "Initial response",
      kind: "period",
      starts: "2035-09-14",
      ends: "2035-09-19",
      planning_at: "2035-09-18T10:00:00Z",
    }),
  ).toBe(Date.parse("2035-09-18T10:00:00Z"));
});

it("shows unresolved schedule details without claiming the schedule is complete", async () => {
  const store = new TestProposalStore();
  store.listPublished = async () => [
    {
      ...DEADLINE_VENUES[0],
      id: "schedule-example",
      deadline_id: "schedule-example",
      name: "Example conference",
      deadline_at: "2026-09-26T11:59:00Z",
      deadline_aoe: "2026-09-25 23:59:00",
      schedule: [],
      schedule_status: "needs_review",
      schedule_issues: ["Third-phase dates are not published."],
    },
  ];
  const container = document.createElement("div");
  document.body.append(container);
  render(renderDeadlines({ proposalStore: store }), container);
  await settle(container);
  buttonNamed(container, "Cards").click();
  await settle(container);
  const note = container.querySelector('[data-testid="deadline-schedule-status"]');
  expect(note?.textContent).toContain("Schedule has unresolved details.");
  expect(note?.textContent).toContain("Third-phase dates are not published.");
});
