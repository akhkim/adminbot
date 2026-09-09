/* @vitest-environment jsdom */
// Conference Overview: that the card says what the venue is, that the form asks only what the
// member can answer, and that the three audiences see three different amounts.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { ConferenceSummary, ConferenceTrip } from "../auth/session.ts";
import {
  renderConferences,
  type ConferencesProps,
  type ConferenceTripDraft,
} from "./conferences.ts";

function conference(overrides: Partial<ConferenceSummary> = {}): ConferenceSummary {
  return {
    key: "emnlp-2026",
    label: "EMNLP 2026",
    family: "EMNLP",
    year: 2026,
    location: "Budapest, Hungary",
    description: "Empirical Methods in Natural Language Processing.",
    next_deadline_aoe: "2026-10-01 23:59:59",
    next_deadline_label: "NLP4PI — Direct submission",
    workshop_count: 24,
    ...overrides,
  };
}

function trip(overrides: Partial<ConferenceTrip> = {}): ConferenceTrip {
  return {
    conference_key: "emnlp-2026",
    member_id: "ada",
    intent: "going",
    funding: "full_travel",
    needs_lodging: true,
    needs_visa_letter: false,
    updated_at: "2026-09-09T00:00:00.000Z",
    ...overrides,
  };
}

function draw(overrides: Partial<ConferencesProps> = {}) {
  document.body.replaceChildren();
  const edits: Array<[string, Partial<ConferenceTripDraft>]> = [];
  const saves: string[] = [];
  const props: ConferencesProps = {
    conferences: [conference()],
    mine: {},
    drafts: {},
    papers: [{ id: "p1", title: "Causal abstraction" }],
    signedIn: true,
    savingKey: null,
    error: null,
    notice: null,
    onEdit: (key, patch) => edits.push([key, patch]),
    onSave: (key) => saves.push(key),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  render(renderConferences(props), container);
  return { container, edits, saves };
}

describe("the conference card", () => {
  it("says what the venue is and where it is", () => {
    const { container } = draw();
    const card = container.querySelector('[data-testid="conference-emnlp-2026"]');
    expect(card?.textContent).toContain("EMNLP 2026");
    expect(card?.textContent).toContain("Budapest, Hungary");
    expect(card?.textContent).toContain("Empirical Methods");
    expect(card?.textContent).toContain("24 workshops");
  });

  it("says when the next call closes, without the AoE clock time", () => {
    const { container } = draw();
    const card = container.querySelector('[data-testid="conference-emnlp-2026"]');
    expect(card?.textContent).toContain("2026-10-01");
    expect(card?.textContent).not.toContain("23:59:59");
  });

  it("says so when there is no open call left", () => {
    const { container } = draw({
      conferences: [conference({ next_deadline_aoe: undefined, next_deadline_label: undefined })],
    });
    expect(container.textContent).toContain("No open workshop calls left");
  });
});

describe("the sign-up form", () => {
  it("asks a signed-out visitor for nothing", () => {
    const { container } = draw({ signedIn: false });
    expect(container.querySelector('[data-testid="conference-signup-emnlp-2026"]')).toBeNull();
    expect(container.textContent).toContain("Sign in to say whether you are going");
  });

  it("opens on undecided rather than on going", () => {
    // A form that opens on "yes" collects agreement rather than an answer, and this one books
    // flights.
    const { container } = draw();
    const intent = container.querySelector<HTMLSelectElement>(
      '[data-testid="conference-intent-emnlp-2026"]',
    );
    expect(intent?.value).toBe("undecided");
    // Nothing past the first question until they say they are going.
    expect(container.querySelector('[data-testid="conference-funding-emnlp-2026"]')).toBeNull();
  });

  it("asks the money, paper, bed and visa questions once they say they are going", () => {
    const { container } = draw({
      drafts: {
        "emnlp-2026": {
          intent: "going",
          funding: "none",
          needs_lodging: false,
          needs_visa_letter: false,
          arrival_on: "",
          departure_on: "",
          paper_id: "",
          notes: "",
        },
      },
    });
    for (const field of ["funding", "paper", "lodging", "visa", "notes"]) {
      expect(
        container.querySelector(`[data-testid="conference-${field}-emnlp-2026"]`),
        field,
      ).not.toBeNull();
    }
    // "No financial aid needed" is offered explicitly: somebody funded elsewhere and somebody who
    // has not answered must not look the same.
    const funding = container.querySelector('[data-testid="conference-funding-emnlp-2026"]');
    expect(funding?.textContent).toContain("No financial aid needed");
    expect(funding?.textContent).toContain("Conference fee only");
    expect(funding?.textContent).toContain("Flight only");
    expect(funding?.textContent).toContain("Full travel");
  });

  it("asks for nights only once a bed is wanted, because a headcount alone books the wrong thing", () => {
    const base: ConferenceTripDraft = {
      intent: "going",
      funding: "none",
      needs_lodging: false,
      needs_visa_letter: false,
      arrival_on: "",
      departure_on: "",
      paper_id: "",
      notes: "",
    };
    const without = draw({ drafts: { "emnlp-2026": base } });
    expect(
      without.container.querySelector('[data-testid="conference-arrival-emnlp-2026"]'),
    ).toBeNull();
    const withBed = draw({ drafts: { "emnlp-2026": { ...base, needs_lodging: true } } });
    expect(
      withBed.container.querySelector('[data-testid="conference-arrival-emnlp-2026"]'),
    ).not.toBeNull();
    expect(
      withBed.container.querySelector('[data-testid="conference-departure-emnlp-2026"]'),
    ).not.toBeNull();
  });

  it("offers the viewer's own papers plus not presenting", () => {
    const { container } = draw({
      drafts: {
        "emnlp-2026": {
          intent: "going",
          funding: "none",
          needs_lodging: false,
          needs_visa_letter: false,
          arrival_on: "",
          departure_on: "",
          paper_id: "",
          notes: "",
        },
      },
    });
    const paper = container.querySelector('[data-testid="conference-paper-emnlp-2026"]');
    expect(paper?.textContent).toContain("Not presenting");
    expect(paper?.textContent).toContain("Causal abstraction");
  });

  it("fills itself in from what the member said last time", () => {
    const { container } = draw({ mine: { "emnlp-2026": trip() } });
    const intent = container.querySelector<HTMLSelectElement>(
      '[data-testid="conference-intent-emnlp-2026"]',
    );
    const funding = container.querySelector<HTMLSelectElement>(
      '[data-testid="conference-funding-emnlp-2026"]',
    );
    expect(intent?.value).toBe("going");
    expect(funding?.value).toBe("full_travel");
    expect(container.textContent).toContain("Your answer is recorded");
  });

  it("reports an edit and a save", () => {
    const { container, edits, saves } = draw();
    const intent = container.querySelector<HTMLSelectElement>(
      '[data-testid="conference-intent-emnlp-2026"]',
    );
    if (intent) {
      intent.value = "going";
      intent.dispatchEvent(new Event("change", { bubbles: true }));
    }
    expect(edits).toEqual([["emnlp-2026", { intent: "going" }]]);
    container
      .querySelector<HTMLButtonElement>('[data-testid="conference-save-emnlp-2026"]')
      ?.click();
    expect(saves).toEqual(["emnlp-2026"]);
  });
});

describe("the admin roster", () => {
  const roster: NonNullable<ConferenceSummary["roster"]> = {
    going: 2,
    not_going: 1,
    undecided: 3,
    funding: { none: 1, fee_only: 0, flight_only: 0, full_travel: 1 },
    visa_letters: 1,
    lodging: {
      guests: 2,
      first_night: "2026-11-02",
      last_night: "2026-11-09",
      members: [
        { member_id: "ada", name: "Ada", arrival_on: "2026-11-04", departure_on: "2026-11-09" },
        { member_id: "bob", name: "Bob", arrival_on: "2026-11-02", departure_on: "2026-11-07" },
      ],
    },
    trips: [
      {
        ...trip(),
        member_name: "Ada Lovelace",
        paper_title: "Causal abstraction",
        arrival_on: "2026-11-04",
        departure_on: "2026-11-09",
      },
    ],
  };

  it("is absent for a member, who sees only their own answer", () => {
    const { container } = draw();
    expect(container.querySelector('[data-testid="conference-roster-emnlp-2026"]')).toBeNull();
  });

  it("gives an admin the booking number and the nights", () => {
    const { container } = draw({ conferences: [conference({ roster })] });
    const line = container.querySelector('[data-testid="conference-lodging-need-emnlp-2026"]');
    expect(line?.textContent).toContain("2");
    expect(line?.textContent).toContain("2026-11-02");
    expect(line?.textContent).toContain("2026-11-09");
  });

  it("says plainly when nobody has asked for a bed", () => {
    const { container } = draw({
      conferences: [conference({ roster: { ...roster, lodging: { guests: 0, members: [] } } })],
    });
    expect(
      container.querySelector('[data-testid="conference-lodging-need-emnlp-2026"]')?.textContent,
    ).toContain("Nobody has asked for a bed");
  });

  it("names who is going, what they need and what they are presenting", () => {
    const { container } = draw({ conferences: [conference({ roster })] });
    const row = container.querySelector('[data-testid="conference-trip-emnlp-2026-ada"]');
    expect(row?.textContent).toContain("Ada Lovelace");
    expect(row?.textContent).toContain("Full travel");
    expect(row?.textContent).toContain("Causal abstraction");
    expect(container.textContent).toContain("1 need a visa letter");
  });
});
