// The lists that hang off a paper card: drafts and their sign-offs, who is going, who is square.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
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
  const props: PaperCycleProps = {
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
    onSetAttendee: (name, memberId, attending) => calls.attendees.push([name, memberId, attending]),
    onSetReimbursement: (memberId, status) => calls.reimbursements.push([memberId, status]),
    ...overrides,
  };
  render(renderPaperCycle(props), container);
  return { container, calls, props };
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
  it("keeps four stage panels and edits a saved figure with its thread", async () => {
    const saved: unknown[] = [];
    const { container, props } = draw({
      onGenerateXDraft: () => {},
      onSaveDraft: (...args) => {
        saved.push(args);
      },
      drafts: [
        draft({
          x_thread: {
            stage: "poster",
            posts: [
              {
                text: "1/1 Come chat",
                images: [
                  { data_uri: "data:image/png;base64,iVBORw0KGgo=", alt_text: "Synthetic results" },
                ],
              },
            ],
          },
        }),
      ],
    });
    for (const stage of ["acceptance", "attendance", "poster"]) {
      expect(container.querySelector(`[data-testid="paper-draft-p1-x-${stage}"]`)).not.toBeNull();
    }
    const panel = container.querySelector('[data-testid="paper-draft-p1-x-poster"]');
    expect(panel?.querySelector("img")?.getAttribute("alt")).toBe("Synthetic results");
    const text = panel?.querySelector<HTMLTextAreaElement>('[data-post="0"]');
    if (!text) {
      throw new Error("Missing thread editor");
    }
    text.value = "1/1 Updated invitation";
    text.dispatchEvent(new Event("input", { bubbles: true }));
    expect(panel?.querySelector('[data-preview="0"]')?.textContent).toBe(text.value);
    expect(panel?.querySelector('[data-count="0"]')?.textContent).toBe("22 / 280");
    expect(panel?.textContent).toContain("Coauthor review is optional");
    panel
      ?.querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saved).toEqual([
      [
        "x",
        "1/1 Updated invitation",
        {
          stage: "poster",
          posts: [
            {
              text: "1/1 Updated invitation",
              images: [
                { data_uri: "data:image/png;base64,iVBORw0KGgo=", alt_text: "Synthetic results" },
              ],
            },
          ],
        },
      ],
    ]);
    expect(() =>
      render(
        renderPaperCycle({
          ...props,
          drafts: props.drafts.map((item) => ({
            ...item,
            x_thread: { stage: "poster" as const, posts: [{ text: "1/1 Saved invitation" }] },
          })),
        }),
        container,
      ),
    ).not.toThrow();
    expect(container.querySelector('[data-preview="0"]')?.textContent).toBe("1/1 Saved invitation");
  });
  it("exposes PDF generation in X without unused LinkedIn context inputs", () => {
    const calls: unknown[] = [];
    const { container } = draw({
      onGenerateXDraft: (...args) => {
        calls.push(args);
      },
    });
    const panel = container.querySelector('[data-testid="paper-draft-p1-x"]');
    expect(panel?.querySelector('[data-el="pdf"]')).not.toBeNull();
    expect(panel?.querySelector('[data-el="venue"]')).toBeNull();
    panel?.querySelector<HTMLButtonElement>('[data-testid="paper-draft-generate-p1-x"]')?.click();
    expect(calls).toEqual([
      [
        "",
        "",
        undefined,
        { stage: "arxiv", venue: undefined, attendees: undefined, session: undefined },
        { authors: [], organizations: [] },
      ],
    ]);
  });
  it("selects one announcement and generates that stage", () => {
    const calls: unknown[] = [];
    const { container } = draw({
      onGenerateXDraft: (...args) => {
        calls.push(args);
      },
    });
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Announcement to make"]',
    )!;
    select.value = "poster";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const panels = Array.from(container.querySelectorAll<HTMLElement>("[data-announcement-panel]"));
    expect(
      panels.filter((panel) => !panel.hidden).map((panel) => panel.dataset.announcementPanel),
    ).toEqual(["poster"]);
    const panel = container.querySelector('[data-announcement-panel="poster"]')!;
    panel.querySelector<HTMLInputElement>('[data-el="x-venue"]')!.value = "SyntheticConf";
    panel.querySelector<HTMLInputElement>('[data-el="x-session"]')!.value =
      "9 Oct, Hall A, poster 2";
    panel
      .querySelector<HTMLButtonElement>('[data-testid="paper-draft-generate-p1-x-poster"]')!
      .click();
    expect((calls[0] as unknown[])[3]).toEqual({
      stage: "poster",
      venue: "SyntheticConf",
      attendees: undefined,
      session: "9 Oct, Hall A, poster 2",
    });
  });
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
    li.querySelector<HTMLButtonElement>(
      '[data-testid="paper-draft-generate-p1-linkedin"]',
    )?.click();
    expect(calls.generated).toEqual([
      ["ICML 2026, poster Wed Jul 8 Hall A #3015", "Best paper award"],
    ]);
  });

  it("sends a chosen PDF with the generate request, in place of the Drive copy", async () => {
    const pdfs: Array<string | undefined> = [];
    const { container } = draw({
      onGenerateLinkedInDraft: (_venue, _note, pdfBase64) => pdfs.push(pdfBase64),
    });
    const zone = container.querySelector<HTMLElement>('[data-testid="paper-draft-pdf-p1"]');
    const input = zone?.querySelector<HTMLInputElement>('[data-el="pdf"]');
    if (!zone || !input) throw new Error("no pdf drop zone");
    // jsdom cannot build a FileList, so the picked file is pinned onto the input directly.
    const file = new File(["%PDF-1.7 fake"], "paper.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
    expect(zone.querySelector('[data-el="pdf-name"]')?.textContent).toBe("paper.pdf");

    container
      .querySelector<HTMLButtonElement>('[data-testid="paper-draft-generate-p1-linkedin"]')
      ?.click();
    await vi.waitFor(() => expect(pdfs).toHaveLength(1));
    expect(pdfs[0]).toBe(btoa("%PDF-1.7 fake"));
  });

  it("refuses a file that is not a PDF and sends nothing extra", () => {
    const alerts: string[] = [];
    vi.stubGlobal("alert", (message: string) => alerts.push(message));
    const pdfs: Array<string | undefined> = [];
    const { container } = draw({
      onGenerateLinkedInDraft: (_venue, _note, pdfBase64) => pdfs.push(pdfBase64),
    });
    const input = container.querySelector<HTMLInputElement>('[data-el="pdf"]');
    if (!input) throw new Error("no pdf input");
    const file = new File(["hello"], "notes.docx", { type: "application/msword" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
    expect(alerts).toEqual(["notes.docx is not a PDF."]);
    vi.unstubAllGlobals();
  });

  it("keeps circulation beside generation once a linkedin draft exists", () => {
    const { container, calls } = draw({ drafts: [draft({ platform: "linkedin" })] });
    const actions = container.querySelector(".paper-cycle__draft-actions");
    expect(
      actions?.querySelector('[data-testid="paper-draft-circulate-p1-linkedin"]'),
    ).not.toBeNull();
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

describe("what you need for this trip", () => {
  /** The card with the trip block wired: conference open, and the handlers present. */
  function withTrip(overrides: Partial<PaperCycleProps> = {}) {
    const edits: Array<Partial<import("./paper-cycle.ts").PaperTripDraft>> = [];
    const saves: number[] = [];
    const withdrawals: number[] = [];
    const drawn = draw({
      conferenceOpen: true,
      myTrip: null,
      onEditTrip: (patch) => edits.push(patch),
      onSaveTrip: () => saves.push(1),
      onWithdrawTrip: () => withdrawals.push(1),
      ...overrides,
    });
    return { ...drawn, edits, saves, withdrawals };
  }

  it("is absent on a paper whose conference is not settled", () => {
    const { container } = draw({ conferenceOpen: false });
    expect(container.querySelector('[data-testid="paper-trip-intent-p1"]')).toBeNull();
  });

  it("is absent on a surface that wired no trip handlers, like somebody else's card", () => {
    const { container } = draw({ conferenceOpen: true });
    expect(container.querySelector('[data-testid="paper-trip-intent-p1"]')).toBeNull();
  });

  it("opens on undecided and asks nothing further until they say they are going", () => {
    const { container } = withTrip();
    const intent = container.querySelector<HTMLSelectElement>(
      '[data-testid="paper-trip-intent-p1"]',
    );
    expect(intent?.value).toBe("undecided");
    expect(container.querySelector('[data-testid="paper-trip-funding-p1"]')).toBeNull();
  });

  it("asks the money, bed and visa questions once they are going", () => {
    const { container } = withTrip({
      tripDraft: {
        intent: "going",
        funding: "none",
        needs_lodging: false,
        needs_visa_letter: false,
        arrival_on: "",
        departure_on: "",
        notes: "",
      },
    });
    const funding = container.querySelector('[data-testid="paper-trip-funding-p1"]');
    expect(funding?.textContent).toContain("No financial aid needed");
    expect(funding?.textContent).toContain("Conference fee only");
    expect(funding?.textContent).toContain("Flight only");
    expect(funding?.textContent).toContain("Full travel");
    expect(container.querySelector('[data-testid="paper-trip-lodging-p1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="paper-trip-visa-p1"]')).not.toBeNull();
    // Dates only once a bed is wanted: a headcount alone books the wrong thing.
    expect(container.querySelector('[data-testid="paper-trip-arrival-p1"]')).toBeNull();
  });

  it("asks for nights once a bed is wanted", () => {
    const { container } = withTrip({
      tripDraft: {
        intent: "going",
        funding: "full_travel",
        needs_lodging: true,
        needs_visa_letter: false,
        arrival_on: "",
        departure_on: "",
        notes: "",
      },
    });
    expect(container.querySelector('[data-testid="paper-trip-arrival-p1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="paper-trip-departure-p1"]')).not.toBeNull();
  });

  it("offers withdrawal only once something is recorded", () => {
    const empty = withTrip();
    expect(empty.container.querySelector('[data-testid="paper-trip-withdraw-p1"]')).toBeNull();
    const filled = withTrip({
      myTrip: {
        conference_key: "emnlp:2026",
        member_id: "ada",
        intent: "going",
        funding: "fee_only",
        needs_lodging: false,
        needs_visa_letter: false,
      },
    });
    filled.container
      .querySelector<HTMLButtonElement>('[data-testid="paper-trip-withdraw-p1"]')
      ?.click();
    expect(filled.withdrawals).toEqual([1]);
  });

  it("reports an edit and a save", () => {
    const { container, edits, saves } = withTrip();
    const intent = container.querySelector<HTMLSelectElement>(
      '[data-testid="paper-trip-intent-p1"]',
    );
    if (intent) {
      intent.value = "going";
      intent.dispatchEvent(new Event("change", { bubbles: true }));
    }
    expect(edits).toEqual([{ intent: "going" }]);
    container.querySelector<HTMLButtonElement>('[data-testid="paper-trip-save-p1"]')?.click();
    expect(saves).toEqual([1]);
  });
});

it("starts paper sections collapsed and preserves a reader's expansion on rerender", () => {
  const { container, props } = draw({ conferenceOpen: true });
  const sections = [...container.querySelectorAll<HTMLDetailsElement>("details.paper-cycle__group")];
  expect(sections.length).toBeGreaterThan(1);
  expect(sections.every((section) => !section.open)).toBe(true);
  expect(sections.every((section) => section.querySelector("summary")?.textContent?.trim())).toBe(true);
  sections[0]!.open = true;
  render(renderPaperCycle(props), container);
  expect(sections[0]!.open).toBe(true);
});
