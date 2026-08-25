// The lists that hang off a paper card: drafts and their sign-offs, who is going, who is square.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type {
  PaperAttendee,
  PaperReimbursement,
  PaperSocialConsent,
  PaperSocialDraft,
} from "../auth/session.ts";
import { renderPaperCycle, type PaperCycleProps } from "./paper-cycle.ts";

type Calls = {
  drafts: Array<[string, string]>;
  circulated: string[];
  consents: Array<[string, string, string | undefined]>;
  attendees: Array<[string, string | undefined, string]>;
  reimbursements: Array<[string, string]>;
  generated: Array<[string, string]>;
};

function draw(overrides: Partial<PaperCycleProps> = {}) {
  const calls: Calls = {
    drafts: [],
    circulated: [],
    consents: [],
    attendees: [],
    reimbursements: [],
    generated: [],
  };
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderPaperCycle({
      paperId: "p1",
      drafts: [],
      consents: [],
      attendees: [],
      reimbursements: [],
      conferenceOpen: false,
      missingAcceptanceDetails: [],
      cycleClosed: false,
      memberId: "ada",
      memberName: (id) => id,
      onSaveDraft: (platform, body) => calls.drafts.push([platform, body]),
      onCirculateDraft: (id) => calls.circulated.push(id),
      onGenerateLinkedInDraft: (venue, note) => calls.generated.push([venue, note]),
      onConsent: (id, decision, comment) => calls.consents.push([id, decision, comment]),
      onSetAttendee: (name, memberId, attending) =>
        calls.attendees.push([name, memberId, attending]),
      onSetReimbursement: (memberId, status) => calls.reimbursements.push([memberId, status]),
      ...overrides,
    }),
    container,
  );
  return { container, calls };
}

function draft(fields: Partial<PaperSocialDraft> = {}): PaperSocialDraft {
  return {
    id: "d1",
    paper_id: "p1",
    platform: "x",
    body: "A thread about the paper",
    generated_at: "2026-08-20T00:00:00.000Z",
    status: "draft",
    ...fields,
  };
}

function consent(fields: Partial<PaperSocialConsent> = {}): PaperSocialConsent {
  return {
    draft_id: "d1",
    member_id: "zhijing",
    decision: "pending",
    asked_at: "2026-08-20T00:00:00.000Z",
    ...fields,
  };
}

const attendee = (fields: Partial<PaperAttendee> = {}): PaperAttendee => ({
  paper_id: "p1",
  attendee_key: "member:ada",
  member_id: "ada",
  name: "Ada Lovelace",
  attending: "yes",
  ...fields,
});

const reimbursement = (fields: Partial<PaperReimbursement> = {}): PaperReimbursement => ({
  paper_id: "p1",
  member_id: "ada",
  status: "pending",
  ...fields,
});

describe("social drafts", () => {
  it("offers a box per platform even before anything is written", () => {
    const { container } = draw();
    expect(container.querySelector('[data-testid="paper-draft-p1-x"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="paper-draft-p1-linkedin"]')).not.toBeNull();
  });

  it("saves a draft body on change", () => {
    const { container, calls } = draw();
    const box = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="paper-draft-body-p1-x"]',
    );
    if (!box) throw new Error("no draft box");
    box.value = "New thread";
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(calls.drafts).toEqual([["x", "New thread"]]);
  });

  it("offers circulation only once there is something to circulate", () => {
    expect(draw().container.querySelector('[data-testid="paper-draft-circulate-p1-x"]')).toBeNull();
    const { container, calls } = draw({ drafts: [draft()] });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="paper-draft-circulate-p1-x"]',
    );
    button?.click();
    expect(calls.circulated).toEqual(["d1"]);
  });

  it("shows who is still holding the post up", () => {
    const { container } = draw({
      drafts: [draft({ status: "circulated" })],
      consents: [consent(), consent({ member_id: "bob", decision: "ok" })],
    });
    expect(container.querySelector('[data-testid="paper-draft-p1-x"]')?.textContent).toContain(
      "1 still to answer",
    );
  });

  it("gives the buttons only to the member whose consent it is", () => {
    // Somebody else's sign-off is not yours to give, and a button that 403s is worse than none.
    const mine = draw({
      drafts: [draft({ status: "circulated" })],
      consents: [consent({ member_id: "ada" })],
    });
    expect(mine.container.querySelector('[data-testid="consent-ok-d1"]')).not.toBeNull();

    const theirs = draw({
      drafts: [draft({ status: "circulated" })],
      consents: [consent({ member_id: "zhijing" })],
    });
    expect(theirs.container.querySelector('[data-testid="consent-ok-d1"]')).toBeNull();
  });

  it("records an approval", () => {
    const { container, calls } = draw({
      drafts: [draft({ status: "circulated" })],
      consents: [consent({ member_id: "ada" })],
    });
    container.querySelector<HTMLButtonElement>('[data-testid="consent-ok-d1"]')?.click();
    expect(calls.consents).toEqual([["d1", "ok", undefined]]);
  });

  it("says so when there is nobody on the roster to ask", () => {
    const { container } = draw({ drafts: [draft({ status: "circulated" })], consents: [] });
    expect(container.textContent).toContain("No coauthors on the roster to ask");
  });
});

describe("the linkedin panel's absorbed generator", () => {
  it("asks for venue and context on linkedin only, ahead of the draft box", () => {
    const { container } = draw();
    const li = container.querySelector('[data-testid="paper-draft-p1-linkedin"]');
    const x = container.querySelector('[data-testid="paper-draft-p1-x"]');
    expect(li?.querySelector('[data-el="venue"]')).not.toBeNull();
    expect(li?.querySelector('[data-el="note"]')).not.toBeNull();
    expect(x?.querySelector('[data-el="venue"]')).toBeNull();
    // The generate button exists even with no stored draft: it is how the first one is made.
    expect(li?.querySelector('[data-testid="paper-draft-generate-p1-linkedin"]')).not.toBeNull();
    expect(x?.querySelector('[data-testid="paper-draft-generate-p1-x"]')).toBeNull();
  });

  it("hands the typed venue and context to the generator", () => {
    const { container, calls } = draw();
    const li = container.querySelector('[data-testid="paper-draft-p1-linkedin"]');
    if (!li) throw new Error("no linkedin panel");
    const venue = li.querySelector<HTMLInputElement>('[data-el="venue"]');
    const note = li.querySelector<HTMLInputElement>('[data-el="note"]');
    if (!venue || !note) throw new Error("no context inputs");
    venue.value = "ICML 2026, poster Wed Jul 8 Hall A #3015";
    note.value = "Best paper award";
    li.querySelector<HTMLButtonElement>('[data-testid="paper-draft-generate-p1-linkedin"]')?.click();
    expect(calls.generated).toEqual([
      ["ICML 2026, poster Wed Jul 8 Hall A #3015", "Best paper award"],
    ]);
  });

  it("keeps circulation beside generation once a linkedin draft exists", () => {
    const { container, calls } = draw({ drafts: [draft({ platform: "linkedin" })] });
    const actions = container.querySelector(".paper-cycle__draft-actions");
    expect(actions?.querySelector('[data-testid="paper-draft-circulate-p1-linkedin"]')).not.toBeNull();
    actions
      ?.querySelector<HTMLButtonElement>('[data-testid="paper-draft-circulate-p1-linkedin"]')
      ?.click();
    expect(calls.circulated).toEqual(["d1"]);
  });
});

describe("the conference half", () => {
  it("stays shut, and says what it is waiting for, until the acceptance details are in", () => {
    const { container } = draw({
      missingAcceptanceDetails: ["year", "presentation type"],
      conferenceOpen: false,
    });
    expect(container.textContent).toContain("year, presentation type");
    expect(container.textContent).not.toContain("Who is going");
  });

  it("opens once they are", () => {
    const { container } = draw({ conferenceOpen: true });
    expect(container.textContent).toContain("Who is going");
  });

  it("adds an attendee as not-said-yet, because nothing infers travel", () => {
    const { container, calls } = draw({ conferenceOpen: true });
    const form = container.querySelector("form");
    const field = container.querySelector<HTMLInputElement>(
      '[data-testid="paper-attendee-add-p1"]',
    );
    if (!form || !field) throw new Error("no add form");
    field.value = "External Collaborator";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(calls.attendees).toEqual([["External Collaborator", undefined, "unknown"]]);
  });

  it("only asks about reimbursements for people who actually went", () => {
    // A reimbursement row for somebody who stayed home is a question with no answer, and it would
    // hold the paper open forever.
    const stayed = draw({
      conferenceOpen: true,
      attendees: [attendee({ attending: "no" })],
    });
    expect(stayed.container.querySelector('[data-testid="paper-reimbursement-p1-ada"]')).toBeNull();

    const went = draw({
      conferenceOpen: true,
      attendees: [attendee()],
      reimbursements: [reimbursement()],
    });
    expect(
      went.container.querySelector('[data-testid="paper-reimbursement-p1-ada"]'),
    ).not.toBeNull();
  });

  it("records a reimbursement status", () => {
    const { container, calls } = draw({
      conferenceOpen: true,
      attendees: [attendee()],
      reimbursements: [reimbursement()],
    });
    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="paper-reimbursement-p1-ada"]',
    );
    if (!select) throw new Error("no select");
    select.value = "reimbursed";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(calls.reimbursements).toEqual([["ada", "reimbursed"]]);
  });
});

describe("the closing line", () => {
  it("appears only when the whole cycle is closed, expenses included", () => {
    expect(draw().container.textContent).not.toContain("expenses included");
    expect(draw({ cycleClosed: true }).container.textContent).toContain("expenses included");
  });
});
