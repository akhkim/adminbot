// The lists that hang off a paper card: drafts and their sign-offs, who is going, who is square.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type {
  PaperAttendee,
  PaperReimbursement,
  PaperSocialConsent,
  PaperSocialDraft,
} from "../api/papers.ts";
import { readXFigure, renderPaperCycle, type PaperCycleProps } from "./paper-cycle.ts";

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
    // A lone post is not numbered: the typed "1/1" is dropped on save.
    expect(saved).toEqual([
      [
        "x",
        "Updated invitation",
        {
          stage: "poster",
          posts: [
            {
              text: "Updated invitation",
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
        undefined,
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
    expect(alerts).toEqual([
      "notes.docx is not a PDF. Drop the paper PDF, or paste the abstract instead.",
    ]);
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

describe("the way to the Events tab", () => {
  // The trip form itself moved to the Events tab, which lists every conference by site. The card
  // keeps the reader's answer, read back, and a button to go and give or change it.
  it("is absent on a paper whose conference is not settled", () => {
    const { container } = draw({ conferenceOpen: false, onOpenTravel: () => {} });
    expect(container.querySelector('[data-testid="paper-travel-p1"]')).toBeNull();
  });

  it("is absent on a surface that wired no way there, like somebody else's card", () => {
    const { container } = draw({ conferenceOpen: true });
    expect(container.querySelector('[data-testid="paper-travel-p1"]')).toBeNull();
    // And the old form is gone everywhere.
    expect(container.querySelector('[data-testid="paper-trip-intent-p1"]')).toBeNull();
  });

  it("asks for an RSVP when there is none, and opens Events", () => {
    const opened: number[] = [];
    const { container } = draw({
      conferenceOpen: true,
      myTrip: null,
      onOpenTravel: () => opened.push(1),
    });
    expect(container.textContent).toContain("Say so on the Events tab");
    container.querySelector<HTMLButtonElement>('[data-testid="paper-travel-open-p1"]')?.click();
    expect(opened).toEqual([1]);
  });

  it("reads back an answer already given", () => {
    const { container } = draw({
      conferenceOpen: true,
      onOpenTravel: () => {},
      myTrip: {
        conference_key: "emnlp:2026",
        member_id: "ada",
        intent: "going",
        funding: "fee_only",
        needs_lodging: true,
        needs_visa_letter: false,
      },
    });
    expect(container.textContent).toContain("staying in the lab Airbnb");
    expect(container.querySelector('[data-testid="paper-travel-open-p1"]')?.textContent).toContain(
      "Change on Events",
    );
  });
});

it("starts paper sections collapsed and preserves a reader's expansion on rerender", () => {
  const { container, props } = draw({ conferenceOpen: true });
  const sections = [
    ...container.querySelectorAll<HTMLDetailsElement>("details.paper-cycle__group"),
  ];
  expect(sections.length).toBeGreaterThan(1);
  expect(sections.every((section) => !section.open)).toBe(true);
  expect(sections.every((section) => section.querySelector("summary")?.textContent?.trim())).toBe(
    true,
  );
  sections[0]!.open = true;
  render(renderPaperCycle(props), container);
  expect(sections[0]!.open).toBe(true);
});

// What Khai hit on the PruneGround EMNLP 2026 Oral posts: required boxes that fought each other,
// no talk wording, nowhere to paste an abstract, and no way to get the text out once drafted.
describe("drafting by hand, without fighting the form", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const posterPanel = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-testid="paper-draft-p1-x-poster"]')!;
  const threadDraft = (
    posts: Array<{ text: string; images?: Array<{ data_uri: string; alt_text: string }> }>,
  ) => draft({ x_thread: { stage: "poster", posts } });
  const figure = { data_uri: "data:image/png;base64,iVBORw0KGgo=", alt_text: "Results table" };

  it("files typed X text as a thread on the panel's own stage", () => {
    const saved: unknown[] = [];
    const { container } = draw({
      onGenerateXDraft: () => {},
      onSaveDraft: (...args) => saved.push(args),
    });
    const box = posterPanel(container).querySelector<HTMLTextAreaElement>(
      '[data-testid="paper-draft-body-p1-x"]',
    )!;
    expect(box.placeholder).toContain("blank line between posts");
    box.value = "Come to our Oral!\n\nSlides and code: example.org";
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(saved).toEqual([
      [
        "x",
        "1/2 Come to our Oral!\n\n2/2 Slides and code: example.org",
        {
          stage: "poster",
          posts: [{ text: "1/2 Come to our Oral!" }, { text: "2/2 Slides and code: example.org" }],
        },
      ],
    ]);
  });

  it("calls the invitation a poster or talk, and asks for the talk slot", () => {
    const { container } = draw({ onGenerateXDraft: () => {} });
    const panel = posterPanel(container);
    expect(panel.textContent).toContain("Poster or talk — come chat");
    expect(panel.textContent).toContain("poster number or talk slot");
  });

  it("prefills the conference from the card on X and LinkedIn", () => {
    const { container } = draw({ onGenerateXDraft: () => {}, defaultVenue: "EMNLP 2026 (Oral)" });
    expect(
      posterPanel(container).querySelector<HTMLInputElement>('[data-el="x-venue"]')?.value,
    ).toBe("EMNLP 2026 (Oral)");
    expect(
      container
        .querySelector('[data-testid="paper-draft-p1-linkedin"]')
        ?.querySelector<HTMLInputElement>('[data-el="venue"]')?.value,
    ).toBe("EMNLP 2026 (Oral)");
  });

  it("hands a pasted abstract to both generators", () => {
    const x: unknown[][] = [];
    const li: unknown[][] = [];
    const { container } = draw({
      onGenerateXDraft: (...args) => x.push(args),
      onGenerateLinkedInDraft: (...args) => li.push(args),
    });
    for (const id of ["x", "linkedin"]) {
      const panel = container.querySelector(`[data-testid="paper-draft-p1-${id}"]`)!;
      panel.querySelector<HTMLTextAreaElement>('[data-el="abstract"]')!.value = "  We prune.  ";
      panel
        .querySelector<HTMLButtonElement>(`[data-testid="paper-draft-generate-p1-${id}"]`)!
        .click();
    }
    expect(x[0]?.[5]).toBe("We prune.");
    expect(li[0]).toEqual(["", "", undefined, "We prune."]);
  });

  it("names the post and figure missing a description, and lets the figure go instead", async () => {
    const alerts: string[] = [];
    vi.stubGlobal("alert", (message: string) => alerts.push(message));
    const saved: unknown[] = [];
    const { container } = draw({
      onGenerateXDraft: () => {},
      onSaveDraft: (...args) => saved.push(args),
      drafts: [threadDraft([{ text: "1/2 First" }, { text: "2/2 Second", images: [figure] }])],
    });
    const panel = posterPanel(container);
    // Nothing is `required`: the browser's own validation is what blocked saving before.
    expect(panel.querySelector("[required]")).toBeNull();
    panel.querySelector<HTMLInputElement>('[data-alt="1-0"]')!.value = "";
    const submit = () =>
      panel
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    submit();
    await settle();
    expect(alerts).toEqual(['Post 2, figure 1 needs a description, or tick "Remove this figure".']);
    expect(saved).toEqual([]);
    panel.querySelector<HTMLInputElement>('[data-remove="1-0"]')!.checked = true;
    submit();
    await settle();
    expect((saved[0] as unknown[])[2]).toEqual({
      stage: "poster",
      posts: [{ text: "1/2 First" }, { text: "2/2 Second" }],
    });
    vi.unstubAllGlobals();
  });

  it("drops a cleared post, appends added ones, and renumbers", async () => {
    const saved: unknown[] = [];
    const { container } = draw({
      onGenerateXDraft: () => {},
      onSaveDraft: (...args) => saved.push(args),
      drafts: [
        threadDraft([{ text: "1/3 Keep" }, { text: "2/3 Drop" }, { text: "3/3 Also keep" }]),
      ],
    });
    const panel = posterPanel(container);
    panel.querySelector<HTMLTextAreaElement>('[data-post="1"]')!.value = "";
    panel.querySelector<HTMLTextAreaElement>("[data-post-new]")!.value = "Added one\n\nAdded two";
    panel
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect((saved[0] as unknown[])[2]).toEqual({
      stage: "poster",
      posts: [
        { text: "1/4 Keep" },
        { text: "2/4 Also keep" },
        { text: "3/4 Added one" },
        { text: "4/4 Added two" },
      ],
    });
  });

  it("splits an over-long post on save instead of refusing the thread", async () => {
    const saved: unknown[] = [];
    const { container } = draw({
      onGenerateXDraft: () => {},
      onSaveDraft: (...args) => saved.push(args),
      drafts: [threadDraft([{ text: "Short" }])],
    });
    const panel = posterPanel(container);
    const box = panel.querySelector<HTMLTextAreaElement>('[data-post="0"]')!;
    box.value = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} here.`).join(" ");
    box.dispatchEvent(new Event("input", { bubbles: true }));
    expect(panel.querySelector('[data-count="0"]')?.textContent).toContain("will be split on save");
    panel
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    const posts = ((saved[0] as unknown[])[2] as { posts: Array<{ text: string }> }).posts;
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.every((post) => post.text.length <= 280)).toBe(true);
    expect(posts[0]?.text.startsWith(`1/${posts.length} `)).toBe(true);
  });

  it("copies the thread as it is on screen, and each post on its own", async () => {
    const copied: string[] = [];
    vi.stubGlobal("navigator", {
      clipboard: { writeText: async (text: string) => void copied.push(text) },
    });
    const { container } = draw({
      onGenerateXDraft: () => {},
      drafts: [threadDraft([{ text: "1/2 First" }, { text: "2/2 Second" }])],
    });
    const panel = posterPanel(container);
    panel.querySelector<HTMLTextAreaElement>('[data-post="1"]')!.value = "2/2 Edited";
    panel.querySelector<HTMLButtonElement>('[data-testid="paper-draft-copy-thread-p1"]')!.click();
    panel.querySelector<HTMLButtonElement>('[data-testid="paper-draft-copy-post-p1-0"]')!.click();
    await settle();
    expect(copied).toEqual(["1/2 First\n\n2/2 Edited", "1/2 First"]);
    vi.unstubAllGlobals();
  });

  it("says how to copy by hand when the browser blocks the clipboard", async () => {
    const alerts: string[] = [];
    vi.stubGlobal("alert", (message: string) => alerts.push(message));
    vi.stubGlobal("navigator", {
      clipboard: { writeText: async () => Promise.reject(new Error("denied")) },
    });
    const { container } = draw({ drafts: [draft({ platform: "linkedin", body: "Our paper" })] });
    container
      .querySelector<HTMLButtonElement>('[data-testid="paper-draft-copy-p1-linkedin"]')!
      .click();
    await settle();
    expect(alerts).toEqual(["The browser blocked copying. Select the text and copy it by hand."]);
    vi.unstubAllGlobals();
  });

  it("refuses a figure that is not an image, saying what to choose", async () => {
    await expect(
      readXFigure(new File(["x"], "fig.pdf", { type: "application/pdf" })),
    ).rejects.toThrow('"fig.pdf" is not an image. Choose a PNG or JPEG figure.');
  });

  it("keeps a small PNG exactly as it is", async () => {
    const file = new File([Uint8Array.from([137, 80, 78, 71])], "fig.png", { type: "image/png" });
    await expect(readXFigure(file)).resolves.toMatch(/^data:image\/png;base64,/u);
  });
});
