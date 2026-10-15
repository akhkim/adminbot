// One project's page: the Project tab's controls and the lane tabs' checklists.
//
// Carried over from the old card's tests when the card became this page: where the paper is aimed,
// its details and their autosave, the venue decision, completion, blockers, delete, the lab-wide
// and the X-thread drafting on the Social tab.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import { paperSteps } from "../data/paper-steps.ts";
import { drawPage, emptyCycle, makeState, overviewRow, paper } from "./projects.test-helpers.ts";
import { resetProjectsSessionState } from "./view.ts";

const api = vi.hoisted(() => ({
  draftXPost: vi.fn(),
  draftLinkedInPost: vi.fn(),
}));
// The generate buttons call the service; the page's job is to hand what comes back to the save.
vi.mock("../api/papers.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/papers.ts")>()),
  draftXPost: api.draftXPost,
  draftLinkedInPost: api.draftLinkedInPost,
}));
vi.mock("../auth/session.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/session.ts")>()),
  loadStoredMemberSession: () => ({ sessionToken: "synthetic-session" }),
}));

afterEach(() => {
  resetProjectsSessionState();
  localStorage.clear();
  api.draftXPost.mockReset();
  api.draftLinkedInPost.mockReset();
});

describe("the page itself", () => {
  it("names the paper, its authors and where it stands, with a tab per lane", () => {
    const { container } = drawPage();
    expect(container.querySelector(".project__head")?.textContent).toContain("Causal abstraction");
    expect(container.querySelector(".project__head")?.textContent).toContain("Ada Lovelace");
    expect(
      [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute("data-testid")),
    ).toEqual([
      "project-tab-project",
      "project-tab-writing",
      "project-tab-venue",
      "project-tab-archival",
      "project-tab-talk",
      "project-tab-social",
    ]);
  });

  it("carries the deadline the paper record has", () => {
    const { container } = drawPage({ papers: [paper({ deadline: "2026-09-24" })] });
    expect(container.querySelector('[data-testid="project-deadline"]')?.textContent).toBe(
      "2026-09-24",
    );
  });

  it("says when the paper is not one it can show", () => {
    const { container } = drawPage({ paperId: "missing" });
    expect(container.textContent).toContain("not on your list");
  });

  it("asks for the checklist once, and offers a retry when the read failed", async () => {
    const onLoadSlots = vi.fn();
    const first = drawPage({ onLoadSlots });
    first.rerender();
    await Promise.resolve();
    expect(onLoadSlots).toHaveBeenCalledTimes(1);
    expect(onLoadSlots).toHaveBeenCalledWith("p1");

    const failed = drawPage({ onLoadSlots, error: "Could not reach AdminBot." });
    expect(failed.container.querySelector('[role="alert"]')?.textContent).toContain("Could not");
    failed.container.querySelector<HTMLButtonElement>('[data-testid="project-retry"]')!.click();
    expect(onLoadSlots).toHaveBeenCalledTimes(2);
  });

  it("marks a finished paper as finished", () => {
    const { container } = drawPage({
      papers: [paper({ artifacts: { completed_at: "2026-07-14T18:03:11.000Z" } })],
    });
    expect(container.querySelector('[data-testid="my-work-done-badge-p1"]')).not.toBeNull();
  });

  it("states what is open on a paper the active list does not carry", () => {
    const { container } = drawPage({
      projects: [],
      overview: [overviewRow({ provided_count: 0, closed: true, missing_slots: [] })],
    });
    expect(container.textContent).toContain("Rejected — pick a new venue to reopen it");
  });

  it("draws the people on the paper, and saves them through the paper record", () => {
    const { container } = drawPage();
    expect(container.querySelector('[data-testid="paper-details-p1"]')).not.toBeNull();
  });

  it("draws the weekly log once the checklist has been read", () => {
    const without = drawPage();
    expect(without.container.querySelector('[data-testid^="paper-weekly"]')).toBeNull();
    const withCycle = drawPage({ slots: { p1: emptyCycle() } });
    expect(withCycle.container.textContent).toContain("Weekly updates");
  });

  it("fetches the paper's history when its panel is opened", () => {
    const { container, recentEdits } = drawPage();
    const panel = container.querySelector<HTMLDetailsElement>('[data-testid="recent-edits"]')!;
    panel.open = true;
    panel.dispatchEvent(new Event("toggle"));
    expect(recentEdits).toEqual([["paper", "p1"]]);
  });

  it("moves the paper on, and offers the PaperFlow map", () => {
    const { container, saved } = drawPage();
    expect(container.querySelector('[data-testid="my-work-map-p1"]')).not.toBeNull();
    container.querySelector<HTMLButtonElement>('[data-testid="my-work-advance-p1"]')!.click();
    const next = paperSteps[paperSteps.indexOf("overleaf_writing") + 1];
    expect(saved.at(-1)).toMatchObject({ id: "p1", currentStep: next });
  });
});

describe("the decision banner", () => {
  const decided = paper({
    venue_decision: "accept",
    accepted_venue: "EMNLP 2026",
    current_step: "submission",
  });

  it("asks the author on their own paper", () => {
    const { container } = drawPage({ papers: [decided] });
    expect(container.querySelector('[data-testid="decision-banner-p1"]')).not.toBeNull();
  });

  // A decision prompt on somebody else's paper invites an admin to answer a question that was
  // asked of the author.
  it("asks nobody else, such as an admin who opened it from Active Papers", () => {
    const theirs = { ...decided, submitted_by_member_id: "someone-else", authors: ["Grace"] };
    const { container } = drawPage({ papers: [theirs] });
    expect(container.querySelector('[data-testid="project-p1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="decision-banner-p1"]')).toBeNull();
  });
});

describe("target venue", () => {
  const year = new Date().getUTCFullYear();

  // jsdom does not re-run the select's reset steps when lit stamps `selected` onto an option, so
  // `select.value` reads as whatever the last option is. The attribute is what the browser acts on.
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
    const { container } = drawPage();
    const { year: yearSelect, venue } = selects(container);
    expect([...(yearSelect?.options ?? [])].map((option) => option.value)).toEqual([
      String(year - 1),
      String(year),
      String(year + 1),
      String(year + 2),
    ]);
    const groups = [...(venue?.querySelectorAll("optgroup") ?? [])].map((group) => group.label);
    expect(groups).toEqual(["Archival", "Non-archival", "Workshops (check the CFP)"]);
    expect([...(venue?.options ?? [])].map((option) => option.value)).toContain("EMNLP-main");
    expect([...(venue?.options ?? [])].map((option) => option.value)).toContain("ICLR-workshop");
  });

  it("opens on what the paper already names", () => {
    const { container } = drawPage({
      papers: [paper({ artifacts: { conference: "ACL 2027 (demo)" } })],
    });
    const { year: yearSelect, venue } = selects(container);
    expect(chosen(yearSelect)).toBe("2027");
    expect(chosen(venue)).toBe("ACL-demo");
  });

  it("writes the two selects back as one venue string", () => {
    const { container, saved } = drawPage({
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
    const { container, saved } = drawPage({
      papers: [paper({ artifacts: { conference: "EMNLP 2026 (system demonstrations)" } })],
    });
    const { year: yearSelect, venue } = selects(container);
    expect(chosen(venue)).toBe("EMNLP 2026 (system demonstrations)");
    venue!.value = "EMNLP 2026 (system demonstrations)";
    yearSelect!.value = String(year + 1);
    yearSelect!.dispatchEvent(new Event("change"));
    expect(saved.at(-1)?.conference).toBe("EMNLP 2026 (system demonstrations)");
  });

  describe("declaring a target registers it", () => {
    function retarget(record: AdminBotPaperRecord) {
      const { container, saved } = drawPage({ papers: [record] });
      const venue = container.querySelector<HTMLSelectElement>('[data-testid="target-venue-p1"]')!;
      venue.value = "ICLR";
      venue.dispatchEvent(new Event("change", { bubbles: true }));
      return saved.at(-1);
    }
    const targetsOf = (input: { venueTargets?: string } | undefined) =>
      JSON.parse(input?.venueTargets || "[]") as Array<{ venue_id: string; confidence: number }>;

    it("registers the paper for the venue it was just pointed at", () => {
      const written = retarget(paper());
      expect(written?.conference).toContain("ICLR");
      expect(targetsOf(written)).toEqual([
        expect.objectContaining({ venue_id: "ICLR", confidence: 50 }),
      ]);
    });

    it("replaces its own venue instead of stacking a second entry for it", () => {
      const written = retarget(
        paper({
          artifacts: {
            conference: "ICLR 2026",
            venue_targets: JSON.stringify([
              { venue_id: "ICLR", label: "ICLR 2026", confidence: 30 },
            ]),
          },
        }),
      );
      expect(targetsOf(written)).toHaveLength(1);
    });

    it("leaves a venue the paper is also aimed at alone", () => {
      const written = retarget(
        paper({
          artifacts: {
            venue_targets: JSON.stringify([
              { venue_id: "arr_2026_october", label: "ARR October", confidence: 80 },
            ]),
          },
        }),
      );
      const ids = targetsOf(written).map((target) => target.venue_id);
      expect(ids).toContain("arr_2026_october");
      expect(ids).toContain("ICLR");
    });
  });
});

describe("the venue decision, on the Venue tab", () => {
  it("sends the decision selected", () => {
    const { container, saved } = drawPage({ tab: "venue", slots: { p1: emptyCycle() } });
    const decision = container.querySelector<HTMLSelectElement>(
      '[data-testid="paper-decision-p1"]',
    )!;
    decision.value = "accept";
    decision.dispatchEvent(new Event("change", { bubbles: true }));
    expect(saved.at(-1)).toMatchObject({ id: "p1", venueDecision: "accept" });
  });

  it("sends every acceptance detail, including explicit clears and the track", () => {
    const accepted = paper({
      venue_decision: "accept",
      accepted_venue: "ICLR 2027",
      accepted_year: 2027,
      is_archival: true,
      presentation_type: "spotlight",
    });
    const { container, saved } = drawPage({ papers: [accepted], tab: "venue" });
    const change = (testid: string, value: string) => {
      const field = container.querySelector<HTMLInputElement | HTMLSelectElement>(
        `[data-testid="${testid}"]`,
      )!;
      field.value = value;
      field.dispatchEvent(new Event("change", { bubbles: true }));
    };
    change("paper-accepted-venue-p1", "");
    change("paper-accepted-year-p1", "");
    change("paper-archival-p1", "");
    change("paper-presentation-p1", "");
    expect(saved.slice(-4)).toEqual([
      expect.objectContaining({ acceptedVenue: "" }),
      expect.objectContaining({ acceptedYear: "" }),
      expect.objectContaining({ isArchival: "" }),
      expect.objectContaining({ presentationType: "" }),
    ]);
    expect(container.querySelector('[data-testid="paper-track-p1"]')).not.toBeNull();
  });
});

describe("finishing a paper", () => {
  it("stamps the paper when the author says they presented it", () => {
    const { container, saved } = drawPage({ papers: [paper({ venue_decision: "accept" })] });
    const button = container.querySelector<HTMLButtonElement>('[data-testid="paper-complete-p1"]');
    expect(button?.disabled).toBe(false);
    button?.click();
    expect(saved.at(-1)?.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it("refuses, with a reason, until a venue has accepted", () => {
    const { container } = drawPage();
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="paper-complete-p1"]')?.disabled,
    ).toBe(true);
    expect(container.querySelector(".paper-completion__why")?.textContent).toMatch(/accepted/i);
  });

  it("reopens by clearing the stamp, not by deleting the key", () => {
    const { container, saved } = drawPage({
      papers: [paper({ venue_decision: "accept", artifacts: { completed_at: "2026-07-14" } })],
    });
    container.querySelector<HTMLButtonElement>('[data-testid="paper-reopen-p1"]')?.click();
    expect(saved.at(-1)?.completedAt).toBe("");
  });
});

describe("deleting a paper", () => {
  it("offers nothing when the page passed no handler", () => {
    const { container } = drawPage();
    expect(container.querySelector('[data-testid="delete-paper-p1"]')).toBeNull();
  });

  it("asks before deleting, and does nothing when the confirm is declined", () => {
    vi.stubGlobal("confirm", () => false);
    try {
      const { container, deleted } = drawPage({ onDeletePaper: true });
      const button = container.querySelector<HTMLButtonElement>('[data-testid="delete-paper-p1"]');
      // The string, not the key path: a missing key renders as "myWork.delete.action".
      expect(button?.textContent?.trim()).toBe("Delete this paper");
      button?.click();
      expect(deleted).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deletes the paper once the confirm is accepted", () => {
    vi.stubGlobal("confirm", () => true);
    try {
      const { container, deleted } = drawPage({ onDeletePaper: true });
      container.querySelector<HTMLButtonElement>('[data-testid="delete-paper-p1"]')?.click();
      expect(deleted).toEqual(["p1"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("editing a project's own details", () => {
  it("starts details closed and preserves the reader's toggle through a rerender", () => {
    const { container, rerender } = drawPage();
    const details = container.querySelector<HTMLDetailsElement>(
      '[data-testid="my-work-details-p1"]',
    )!;
    const toggle = details.querySelector("summary")!;
    expect(details.open).toBe(false);
    toggle.click();
    expect(details.open).toBe(true);
    rerender();
    expect(details.open).toBe(true);
    toggle.click();
    expect(details.open).toBe(false);
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
  const save = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('[data-testid="my-work-details-save-p1"]')!.click();
  const error = (container: HTMLElement) =>
    container.querySelector('[data-testid="my-work-details-error-p1"]')?.textContent ?? "";

  it("saves a new title and short name", () => {
    const { container, saved, rerender } = drawPage();
    typeInto(container, "my-work-details-title-p1", "A better title", rerender);
    typeInto(container, "my-work-details-alias-p1", "Renamed", rerender);
    save(container);
    expect(saved.at(-1)).toMatchObject({ id: "p1", title: "A better title", alias: "renamed" });
  });

  it("refuses a short name Slack could not take, and says why", () => {
    const { container, saved, rerender } = drawPage();
    typeInto(container, "my-work-details-alias-p1", "Bob's Project", rerender);
    save(container);
    rerender();
    expect(saved).toHaveLength(0);
    expect(error(container)).toContain("cannot be a Slack channel name");
  });

  it("refuses an empty title", () => {
    const { container, saved, rerender } = drawPage();
    typeInto(container, "my-work-details-title-p1", "   ", rerender);
    save(container);
    rerender();
    expect(saved).toHaveLength(0);
    expect(error(container)).toContain("title");
  });

  it("keeps the save button inert until something changes", () => {
    const { container, rerender } = drawPage();
    const button = () =>
      container.querySelector<HTMLButtonElement>('[data-testid="my-work-details-save-p1"]');
    expect(button()?.disabled).toBe(true);
    typeInto(container, "my-work-details-title-p1", "Changed", rerender);
    expect(button()?.disabled).toBe(false);
  });

  describe("autosave", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    const leaveForm = (container: HTMLElement) => {
      container
        .querySelector<HTMLFormElement>(".my-work-details__form")!
        .dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    };

    it("commits a beat after typing stops, with nothing pressed", () => {
      const { container, saved, rerender } = drawPage();
      typeInto(container, "my-work-details-title-p1", "A better title", rerender);
      vi.advanceTimersByTime(500);
      expect(saved).toHaveLength(0);
      vi.advanceTimersByTime(500);
      expect(saved.at(-1)).toMatchObject({ id: "p1", title: "A better title" });
    });

    it("does not save an old member's pending edit after the session changes", () => {
      const { container, saved, rerender } = drawPage();
      typeInto(container, "my-work-details-title-p1", "Private draft", rerender);
      resetProjectsSessionState();
      vi.advanceTimersByTime(1000);
      expect(saved).toHaveLength(0);
    });

    it("restarts the timer on every keystroke rather than saving mid-word", () => {
      const { container, saved, rerender } = drawPage();
      for (const value of ["A", "Ab", "Abc"]) {
        typeInto(container, "my-work-details-title-p1", value, rerender);
        vi.advanceTimersByTime(600);
      }
      expect(saved).toHaveLength(0);
      vi.advanceTimersByTime(900);
      expect(saved).toHaveLength(1);
      expect(saved.at(-1)).toMatchObject({ title: "Abc" });
    });

    it("keeps the focused editor when a saved paper updates the cached list", () => {
      const state = makeState();
      const { container, rerender } = drawPage({ state });
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="my-work-details-title-p1"]',
      )!;
      input.focus();
      input.value = "A better title";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      rerender();
      state.adminBotData = { ...state.adminBotData, papers: [paper({ title: "A better title" })] };
      rerender();
      expect(input.isConnected).toBe(true);
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe("A better title");
    });

    it("holds a draft it cannot write instead of firing a doomed request", () => {
      const { container, saved, rerender } = drawPage();
      typeInto(container, "my-work-details-alias-p1", "Bob's Project", rerender);
      vi.advanceTimersByTime(5000);
      expect(saved).toHaveLength(0);
      expect(container.querySelector('[data-testid="my-work-details-error-p1"]')).toBeNull();
    });

    it("explains an unwritable draft when focus leaves, rather than dropping it", () => {
      const { container, saved, rerender } = drawPage();
      typeInto(container, "my-work-details-alias-p1", "Bob's Project", rerender);
      leaveForm(container);
      rerender();
      expect(saved).toHaveLength(0);
      expect(error(container)).toContain("cannot be a Slack channel name");
    });

    it("commits immediately when focus leaves mid-debounce", () => {
      const { container, saved, rerender } = drawPage();
      typeInto(container, "my-work-details-title-p1", "Left early", rerender);
      leaveForm(container);
      expect(saved.at(-1)).toMatchObject({ title: "Left early" });
    });

    it("writes once when the debounce and the blur both come due", () => {
      const { container, saved, rerender } = drawPage();
      typeInto(container, "my-work-details-title-p1", "Once only", rerender);
      vi.advanceTimersByTime(900);
      expect(saved).toHaveLength(1);
      leaveForm(container);
      expect(saved).toHaveLength(1);
    });

    it("re-sends on an explicit press even when the values have not changed since", () => {
      const { container, saved, rerender } = drawPage();
      typeInto(container, "my-work-details-title-p1", "Retry me", rerender);
      vi.advanceTimersByTime(900);
      expect(saved).toHaveLength(1);
      rerender();
      save(container);
      expect(saved).toHaveLength(2);
      expect(saved.at(-1)).toMatchObject({ title: "Retry me" });
    });

    it("leaves a form nobody touched alone", () => {
      const { container, saved } = drawPage();
      leaveForm(container);
      vi.advanceTimersByTime(5000);
      expect(saved).toHaveLength(0);
    });

    it("still says changes save themselves", () => {
      const { container } = drawPage();
      expect(container.querySelector(".my-work-details__autosave-hint")?.textContent?.trim()).toBe(
        "Changes save automatically.",
      );
    });
  });
});

describe("reporting a blocker", () => {
  it("files a stage and a title onto the paper, and lists it with its own controls", async () => {
    const view = drawPage();
    view.container.querySelector<HTMLButtonElement>('[data-testid="my-work-report-p1"]')!.click();
    view.rerender();
    const form = view.container.querySelector<HTMLFormElement>(".blocker-form")!;
    (form.elements.namedItem("stage") as HTMLSelectElement).value = "submission";
    (form.elements.namedItem("title") as HTMLInputElement).value = "OpenReview rejects the PDF";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    const log = JSON.parse(view.saved.at(-1)?.blockerLog ?? "[]");
    expect(log.at(-1)).toMatchObject({ stage: "submission", title: "OpenReview rejects the PDF" });
  });

  it("explains an empty or whitespace-only title without discarding the draft", () => {
    const view = drawPage();
    view.container.querySelector<HTMLButtonElement>('[data-testid="my-work-report-p1"]')!.click();
    view.rerender();
    const title = view.container.querySelector<HTMLInputElement>(
      '[data-testid="blocker-title-p1"]',
    )!;
    expect(title.required).toBe(true);
    expect(title.checkValidity()).toBe(false);
    title.value = "   ";
    title.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(title.validationMessage).toBe("Enter a short description of what is blocked.");
    expect(view.saved).toHaveLength(0);
    expect(view.state.myWorkBlockerDraft?.paperId).toBe("p1");
    title.value = "Review for arXiv";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    expect(title.checkValidity()).toBe(true);
  });

  it.each([false, true])("waits for the save result (%s), keeping failed drafts", async (ok) => {
    let finish!: (value: boolean) => void;
    const onSaveBlocker = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const view = drawPage({ onSaveBlocker });
    view.container.querySelector<HTMLButtonElement>('[data-testid="my-work-report-p1"]')!.click();
    view.rerender();
    const form = view.container.querySelector<HTMLFormElement>(".blocker-form")!;
    (form.elements.namedItem("title") as HTMLInputElement).value = "Review for arXiv";
    (form.elements.namedItem("note") as HTMLTextAreaElement).value = "Synthetic details";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    view.rerender();
    expect(view.state.myWorkBlockerDraft?.saving).toBe(true);
    expect(
      view.container.querySelector<HTMLButtonElement>('.blocker-form button[type="submit"]')
        ?.disabled,
    ).toBe(true);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onSaveBlocker).toHaveBeenCalledTimes(1);
    finish(ok);
    await Promise.resolve();
    view.rerender();
    if (ok) {
      expect(view.state.myWorkBlockerDraft).toBeNull();
      return;
    }
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Your draft is kept",
    );
    expect(
      view.container.querySelector<HTMLInputElement>('[data-testid="blocker-title-p1"]')?.value,
    ).toBe("Review for arXiv");
    expect(view.container.querySelector<HTMLTextAreaElement>(".blocker-form textarea")?.value).toBe(
      "Synthetic details",
    );
  });

  it("resolves a filed blocker", () => {
    const blocked = paper({
      artifacts: {
        blocker_log: JSON.stringify([
          { stage: "submission", title: "Stuck", note: "", by: "Ada", at: "2026-10-01" },
        ]),
      },
    });
    const { container, saved } = drawPage({ papers: [blocked] });
    container
      .querySelector<HTMLButtonElement>('[data-testid="blocker-resolve-p1-2026-10-01"]')!
      .click();
    expect(saved.at(-1)?.id).toBe("p1");
  });
});

// The nudge chases the whole lab, so it lives on Active Papers (views/paper-nudge.ts), not on any
// one paper's page -- an administrator's included.
describe("the lab-wide author nudge", () => {
  it("is not on a project page, whoever is reading", () => {
    for (const viewerIsAdmin of [false, true]) {
      const { container } = drawPage({ viewerIsAdmin });
      expect(container.querySelector('[data-testid="paper-nudge"]')).toBeNull();
      expect(container.querySelector('[data-testid="my-work-review-nudges"]')).toBeNull();
    }
  });
});

describe("the lane tabs", () => {
  const cycle = emptyCycle({
    slots: [
      { paper_id: "p1", slot: "overleaf", status: "missing" },
      { paper_id: "p1", slot: "feedback_arr", status: "missing" },
    ] as never,
  });

  it("draws one branch of the checklist per tab", () => {
    const writing = drawPage({ tab: "writing", slots: { p1: cycle } });
    expect(
      writing.container.querySelector('[data-testid="paper-slots-branch-p1-core"]'),
    ).not.toBeNull();
    expect(
      writing.container.querySelector('[data-testid="paper-slots-branch-p1-talk"]'),
    ).toBeNull();
    // The people belong to the Project tab, not to every lane.
    expect(writing.container.querySelector('[data-testid="paper-details-p1"]')).toBeNull();

    const talk = drawPage({ tab: "talk", slots: { p1: cycle } });
    expect(
      talk.container.querySelector('[data-testid="paper-slots-branch-p1-talk"]'),
    ).not.toBeNull();
    expect(talk.container.querySelector('[data-testid="paper-slots-branch-p1-core"]')).toBeNull();
  });

  it("offers the feedback request form with the writing, and nowhere else", () => {
    const writing = drawPage({ tab: "writing", slots: { p1: cycle } });
    expect(writing.container.querySelector('[data-testid="paper-feedback"]')).not.toBeNull();
    const archival = drawPage({ tab: "archival", slots: { p1: cycle } });
    expect(archival.container.querySelector('[data-testid="paper-feedback"]')).toBeNull();
  });

  // A field whose upstream evidence is not in yet is still a field: authors file things in the
  // order they happen, and the service takes any slot at any stage.
  it("lets any field be filled at any stage, as the service does", async () => {
    const { container, slotWrites } = drawPage({ tab: "writing", slots: { p1: cycle } });
    const deck = container.querySelector(
      '[data-testid="paper-slots-branch-p1-core"] adminbot-paper-slot-deck',
    ) as unknown as { updateComplete: Promise<unknown> };
    await deck.updateComplete;
    const field = container.querySelector<HTMLInputElement>(
      '[data-testid="paper-slot-p1-pdf_ready"]',
    )!;
    expect(field.disabled).toBe(false);
    field.click();
    field.dispatchEvent(new Event("change"));
    expect(slotWrites.at(-1)).toMatchObject({ paperId: "p1", slot: "pdf_ready" });
  });

  it("says it is still reading a checklist it does not have", () => {
    const { container } = drawPage({ tab: "writing" });
    expect(container.textContent).toContain("Loading this paper's checklist");
  });
});

describe("drafting announcements on the Social tab", () => {
  it("generates an X thread and saves it with its stage and posts", async () => {
    api.draftXPost.mockResolvedValue({
      ok: true,
      value: { posts: [{ text: "1/2 Synthetic news" }, { text: "2/2 Read it" }], issues: [] },
    });
    const { container, drafts } = drawPage({ tab: "social", slots: { p1: emptyCycle() } });
    container
      .querySelector<HTMLButtonElement>('[data-testid="paper-draft-generate-p1-x"]')!
      .click();
    await vi.waitFor(() => expect(drafts).toHaveLength(1));
    expect(api.draftXPost).toHaveBeenCalledWith(
      expect.objectContaining({ paperId: "p1", announcement: expect.anything() }),
      "synthetic-session",
      "https://admin.safe.eu",
    );
    expect(drafts[0]).toEqual({
      paperId: "p1",
      platform: "x",
      body: "1/2 Synthetic news\n\n2/2 Read it",
      xThread: {
        stage: "arxiv",
        posts: [{ text: "1/2 Synthetic news" }, { text: "2/2 Read it" }],
      },
    });
  });

  it("generates a LinkedIn draft and saves it as the LinkedIn draft", async () => {
    api.draftLinkedInPost.mockResolvedValue({ ok: true, value: { text: "Synthetic post" } });
    const { container, drafts } = drawPage({ tab: "social", slots: { p1: emptyCycle() } });
    container
      .querySelector<HTMLButtonElement>('[data-testid="paper-draft-generate-p1-linkedin"]')!
      .click();
    await vi.waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0]).toEqual({ paperId: "p1", platform: "linkedin", body: "Synthetic post" });
  });
});
