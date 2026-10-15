// My Projects & Papers' card list: adding a project, the banners addressed to the reader, the
// papers the active list leaves out, hiding, and the flat view and sheet beside the cards.
//
// Carried over from the old my-work tests when the card deck became a card list plus project
// pages; each describe names the capability it guards.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlackChannelCheck } from "../controllers/admin.ts";
import { loadHistory, recordHistory } from "../paper-grid.ts";
import {
  drawOverview,
  drawPage,
  emptyCycle,
  makeState,
  overviewRow,
  paper,
  summaryFor,
} from "./projects.test-helpers.ts";
import { resetProjectsSessionState } from "./view.ts";

afterEach(() => {
  resetProjectsSessionState();
  localStorage.clear();
});

describe("the card list", () => {
  it("draws a card per active project and opens on the cards, not a whole-page view", () => {
    const { container } = drawOverview();
    expect(container.querySelector('[data-testid="project-card-p1"]')?.textContent).toContain(
      "Causal abstraction",
    );
    expect(container.querySelector('[data-testid="paper-legacy"]')).toBeNull();
    expect(container.querySelector(".my-work--sheet")).toBeNull();
  });

  it("says on each card how much is on file and when it is due", () => {
    const { container } = drawOverview({
      projects: [{ ...summaryFor(paper()), provided_count: 3, deadline: "2026-09-24T23:59:00Z" }],
    });
    const meta = container.querySelector('[data-testid="project-card-meta-p1"]')?.textContent;
    expect(meta).toContain("3/20");
    expect(meta).toContain("2026-09-24");
  });

  it("says it is still reading rather than claiming there is nothing", () => {
    const { container } = drawOverview({ projects: null });
    expect(container.textContent).toContain("Loading your projects");
    expect(container.textContent).not.toContain("No active projects");
  });

  it("says why the list failed and asks again on request", () => {
    const state = makeState();
    state.myProjects = null;
    state.myProjectsError = "AdminBot is not reachable.";
    const { container, rerender } = drawOverview({ state });
    expect(container.querySelector('[data-testid="projects-error"]')?.textContent).toContain(
      "not reachable",
    );
    container.querySelector<HTMLButtonElement>('[data-testid="projects-error"] button')!.click();
    expect(state.myProjectsError).toBeNull();
    rerender();
    expect(container.querySelector('[data-testid="projects-error"]')).toBeNull();
  });

  it("shows what the last write did, and any failure, above the list", () => {
    const { container } = drawOverview({
      notice: "Nudged 2 authors.",
      error: "Could not reach AdminBot.",
    });
    expect(container.querySelector(".my-work__notice-line")?.textContent).toContain("Nudged 2");
    expect(container.querySelector(".my-work__error-line")?.textContent).toContain("Could not");
  });

  it("keeps the lab-wide nudge off the reader's own list -- it lives on Active Papers", () => {
    const { container } = drawOverview({ viewerIsAdmin: true });
    expect(container.querySelector('[data-testid="my-work-review-nudges"]')).toBeNull();
  });

  it("rolls every open blocker on the reader's papers up above the cards", () => {
    const blocked = paper({
      artifacts: {
        blocker_log: JSON.stringify([
          {
            stage: "submission",
            title: "OpenReview rejects the PDF",
            note: "",
            by: "Ada",
            at: "1",
          },
        ]),
      },
    });
    const { container } = drawOverview({ papers: [blocked] });
    expect(container.querySelector('[data-testid="my-work-blockers"]')?.textContent).toContain(
      "OpenReview rejects the PDF",
    );
  });
});

describe("papers the active list leaves out", () => {
  const done = { completed_at: "2026-07-14T18:03:11.000Z" };

  it("keeps finished papers off the cards, in their own counted disclosure", () => {
    const shipped = paper({ id: "p2", title: "Shipped last summer", artifacts: done });
    const { container } = drawOverview({
      papers: [paper(), shipped],
      // The service leaves a completed paper off the active list.
      projects: [summaryFor(paper())],
    });
    expect(container.querySelector('[data-testid="project-card-p1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="project-card-p2"]')).toBeNull();
    const bucket = container.querySelector('[data-testid="my-work-completed"]');
    expect(bucket?.querySelector('[data-testid="my-work-item-p2"]')).not.toBeNull();
    expect(bucket?.querySelector("summary")?.textContent).toContain("(1)");
  });

  it("lists a rejected paper with what to do about it, never as finished", () => {
    const { container } = drawOverview({
      papers: [paper()],
      projects: [],
      overview: [overviewRow({ provided_count: 0, closed: true, missing_slots: [] })],
    });
    const row = container.querySelector('[data-testid="my-work-item-p1"]');
    expect(row?.textContent).toContain("Rejected");
    expect(row?.textContent).not.toContain("Everything is in");
    expect(row?.querySelector('[data-testid="project-other-p1"]')?.getAttribute("href")).toBe(
      "/my-work/p1",
    );
  });

  it("says a dormant paper is dormant", () => {
    const { container } = drawOverview({
      projects: [],
      overview: [overviewRow({ dormant: true })],
    });
    expect(container.querySelector('[data-testid="my-work-item-p1"]')?.textContent).toContain(
      "Dormant",
    );
  });

  it("says the work is waiting rather than done when nothing is chaseable yet", () => {
    const { container } = drawOverview({
      projects: [],
      overview: [overviewRow({ provided_count: 3, missing_slots: [] })],
    });
    const row = container.querySelector('[data-testid="my-work-item-p1"]');
    expect(row?.textContent).toContain("Waiting on earlier steps");
    expect(row?.textContent).not.toContain("Everything is in");
  });

  it("lists nothing as left out before the active list has arrived", () => {
    const { container } = drawOverview({ projects: null });
    expect(container.querySelector('[data-testid="projects-others"]')).toBeNull();
  });
});

describe("adding a project", () => {
  const year = new Date().getUTCFullYear();

  function fillProjectBasics(container: Element) {
    container.querySelector<HTMLInputElement>('[data-testid="my-work-add-alias"]')!.value = "cais";
    container.querySelector<HTMLInputElement>('[data-testid="my-work-add-started-on"]')!.value =
      "2026-01-15";
  }

  function submit(container: Element) {
    container
      .querySelector<HTMLFormElement>("#my-work-add-form")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
  }

  it("opens the form from the button", () => {
    const { container, state, rerender } = drawOverview();
    expect(container.querySelector("#my-work-add-form")).toBeNull();
    vi.stubGlobal("requestAnimationFrame", () => 0);
    try {
      container.querySelector<HTMLButtonElement>('[data-testid="my-work-add-project"]')!.click();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(state.myWorkProjectDraft).toBe("");
    rerender();
    expect(container.querySelector("#my-work-add-form")).not.toBeNull();
  });

  it("offers one conference select per row, the conference before the year", () => {
    const { container } = drawOverview({ projectDraft: "Causal abstraction" });
    const row = container.querySelector('[data-testid="register-venue-row-0"]');
    const order = [...(row?.querySelectorAll("select") ?? [])].map((select) =>
      select.getAttribute("data-testid"),
    );
    expect(order).toEqual(["register-venue-0", "register-venue-year-0", "register-venue-odds-0"]);
  });

  it("files the alias lowercased and the start date as typed", () => {
    const { container, saved } = drawOverview({ projectDraft: "Causal AI Scientist" });
    container.querySelector<HTMLInputElement>('[data-testid="my-work-add-alias"]')!.value = "CAIS";
    container.querySelector<HTMLInputElement>('[data-testid="my-work-add-started-on"]')!.value =
      "2026-01-15";
    submit(container);
    expect(saved.at(-1)?.alias).toBe("cais");
    expect(saved.at(-1)?.startedOn).toBe("2026-01-15");
  });

  // The reported bug: copying the title into the short name brings its punctuation and length
  // along, and the submit used to return without saying anything.
  it.each([
    ["an apostrophe", "Bob's Project"],
    ["a colon", "Agents: a survey"],
    ["more than the alias limit", "A Very Long Project Title That Goes On"],
  ])("says why it refused a short name carrying %s", (_label, text) => {
    const { container, saved, rerender } = drawOverview({ projectDraft: text });
    container.querySelector<HTMLInputElement>('[data-testid="my-work-add-alias"]')!.value = text;
    container.querySelector<HTMLInputElement>('[data-testid="my-work-add-started-on"]')!.value =
      "2026-01-15";
    submit(container);
    rerender();
    expect(saved).toHaveLength(0);
    expect(
      container.querySelector('[data-testid="my-work-add-error"]')?.textContent ?? "",
    ).toContain("cannot be a Slack channel name");
  });

  it("files a project whose title and short name are the same word", () => {
    const { container, saved } = drawOverview({ projectDraft: "CAIS" });
    container.querySelector<HTMLInputElement>('[data-testid="my-work-add-alias"]')!.value = "CAIS";
    container.querySelector<HTMLInputElement>('[data-testid="my-work-add-started-on"]')!.value =
      "2026-01-15";
    submit(container);
    expect(saved).toHaveLength(1);
    expect(saved.at(-1)).toMatchObject({ title: "CAIS", alias: "cais", id: "cais" });
    expect(container.querySelector('[data-testid="my-work-add-error"]')).toBeNull();
  });

  it("names the missing answer rather than doing nothing", () => {
    const { container, saved, rerender } = drawOverview({ projectDraft: "Causal AI Scientist" });
    submit(container);
    rerender();
    expect(saved).toHaveLength(0);
    expect(
      container.querySelector('[data-testid="my-work-add-error"]')?.textContent ?? "",
    ).toContain("short name");
  });

  it("refuses to file a project with no alias or no start date", () => {
    const { container, saved } = drawOverview({ projectDraft: "Causal AI Scientist" });
    submit(container);
    expect(saved).toHaveLength(0);
    container.querySelector<HTMLInputElement>('[data-testid="my-work-add-alias"]')!.value =
      "C.A.I.S. v2";
    container.querySelector<HTMLInputElement>('[data-testid="my-work-add-started-on"]')!.value =
      "2026-01-15";
    submit(container);
    expect(saved).toHaveLength(0);
  });

  it("registers a paper against the venue and year picked on the row", () => {
    const { container, saved, state } = drawOverview({ projectDraft: "Causal abstraction" });
    const venue = container.querySelector<HTMLSelectElement>('[data-testid="register-venue-0"]');
    const yearSelect = container.querySelector<HTMLSelectElement>(
      '[data-testid="register-venue-year-0"]',
    );
    fillProjectBasics(container);
    yearSelect!.value = String(year + 1);
    yearSelect!.dispatchEvent(new Event("change"));
    venue!.value = "COLM-workshop";
    venue!.dispatchEvent(new Event("change"));
    submit(container);
    expect(saved.at(-1)?.conference).toBe(`COLM ${year + 1} (workshop)`);
    expect(state.myWorkProjectVenues).toEqual([]);
  });

  it("takes several conferences, each with its own probability", () => {
    const { container, saved, state } = drawOverview({ projectDraft: "Causal abstraction" });
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
    // Submitted without a re-render: the handlers read live state, not what was last drawn.
    submit(container);
    const targets = JSON.parse(saved.at(-1)?.venueTargets ?? "[]");
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ venue_id: "COLM-workshop", confidence: 80 });
    expect(targets[1]).toMatchObject({ confidence: 50 });
    expect(saved.at(-1)?.conference).toContain("COLM");
    expect(saved.at(-1)?.confidence).toBe("80");
  });

  describe("the Slack channel already-exists check", () => {
    const check = (over: Partial<SlackChannelCheck> = {}): SlackChannelCheck => ({
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
    const startedOn = (container: HTMLElement) => {
      container.querySelector<HTMLInputElement>('[data-testid="my-work-add-started-on"]')!.value =
        "2026-01-15";
    };

    it("is not offered when the page has no way to answer it", () => {
      const { container } = drawOverview({ projectDraft: "Causal abstraction" });
      expect(container.querySelector('[data-testid="my-work-channel-exists"]')).toBeNull();
    });

    it("reports the tick so the channel names can be loaded", () => {
      const { container, channelToggles } = drawOverview({
        projectDraft: "Causal abstraction",
        channelCheck: check(),
      });
      container.querySelector<HTMLInputElement>('[data-testid="my-work-channel-exists"]')!.click();
      expect(channelToggles).toEqual([true]);
    });

    it("confirms an alias that matches a real channel", () => {
      const { container, rerender } = drawOverview({
        projectDraft: "Causal abstraction",
        channelCheck: check({ enabled: true, channels: ["proj-cais", "random-active"] }),
      });
      typeAlias(container, "CAIS", rerender);
      expect(container.querySelector('[data-testid="my-work-channel-check-ok"]')).not.toBeNull();
    });

    it("refuses a submit whose alias names no channel, and says what is near it", () => {
      const { container, saved, rerender } = drawOverview({
        projectDraft: "Causal abstraction",
        channelCheck: check({ enabled: true, channels: ["proj-cais"] }),
      });
      typeAlias(container, "cais2", rerender);
      startedOn(container);
      expect(
        container.querySelector('[data-testid="my-work-channel-check-mismatch"]')?.textContent,
      ).toContain("proj-cais");
      submit(container);
      expect(saved).toHaveLength(0);
    });

    it("files the project when the box is ticked and the channel is there", () => {
      const { container, saved, rerender } = drawOverview({
        projectDraft: "Causal abstraction",
        channelCheck: check({ enabled: true, channels: ["proj-cais"] }),
      });
      typeAlias(container, "cais", rerender);
      startedOn(container);
      submit(container);
      expect(saved).toHaveLength(1);
      expect(saved[0]?.alias).toBe("cais");
    });

    it("never blocks a submit when the lookup could not run", () => {
      const { container, saved, rerender } = drawOverview({
        projectDraft: "Causal abstraction",
        channelCheck: check({ enabled: true, channels: null, error: "Slack is unreachable." }),
      });
      typeAlias(container, "cais", rerender);
      startedOn(container);
      expect(
        container.querySelector('[data-testid="my-work-channel-check-unavailable"]')?.textContent,
      ).toContain("still file");
      submit(container);
      expect(saved).toHaveLength(1);
    });

    it("checks nothing while the box is unticked", () => {
      const { container, saved, rerender } = drawOverview({
        projectDraft: "Causal abstraction",
        channelCheck: check({ enabled: false, channels: ["proj-cais"] }),
      });
      typeAlias(container, "brand-new", rerender);
      startedOn(container);
      submit(container);
      expect(saved).toHaveLength(1);
    });
  });
});

describe("hiding a paper from your own list", () => {
  const twoPapers = () => [paper(), paper({ id: "p2", title: "Second paper" })];

  function hideSecond() {
    const page = drawPage({ papers: twoPapers(), paperId: "p2" });
    page.container.querySelector<HTMLButtonElement>('[data-testid="my-work-hide-p2"]')!.click();
    return page;
  }

  it("takes the card off the list without touching the paper", () => {
    expect(drawOverview({ papers: twoPapers() }).container.textContent).toContain("Second paper");
    const page = hideSecond();
    const after = drawOverview({ papers: twoPapers() });
    expect(after.container.querySelector('[data-testid="project-card-p2"]')).toBeNull();
    // Nothing was saved, so no coauthor's page changed.
    expect(page.saved).toEqual([]);
    expect(after.saved).toEqual([]);
  });

  it("says how many it is holding back, and gives them back in one click", () => {
    hideSecond();
    const hidden = drawOverview({ papers: twoPapers() });
    expect(
      hidden.container.querySelector('[data-testid="my-work-hidden-line"]')?.textContent,
    ).toContain("1");
    hidden.container
      .querySelector<HTMLButtonElement>('[data-testid="my-work-show-hidden"]')!
      .click();
    const restored = drawOverview({ papers: twoPapers() });
    expect(restored.container.querySelector('[data-testid="project-card-p2"]')).not.toBeNull();
    expect(restored.container.querySelector('[data-testid="my-work-hidden-line"]')).toBeNull();
  });

  it("offers the search-and-hide panel over the reader's own papers", () => {
    const { container } = drawOverview({ papers: twoPapers() });
    expect(container.querySelector("adminbot-paper-visibility")).not.toBeNull();
  });
});

describe("the decision banners above the list", () => {
  const decided = (id: string, extra: Record<string, unknown> = {}) =>
    paper({
      id,
      title: "A decided paper",
      current_step: "submission",
      venue_decision: "accept",
      accepted_venue: "EMNLP 2026",
      ...extra,
    });

  it("draws the decision banner on the member's own list", () => {
    const { container } = drawOverview({ papers: [decided("d1")] });
    expect(container.querySelector('[data-testid="decision-banner-d1"]')).not.toBeNull();
  });

  it("leaves out a decision answered before this session", () => {
    const { container } = drawOverview({
      papers: [decided("done-1", { artifacts: { decision_seen: "accept:EMNLP 2026" } })],
    });
    expect(container.querySelector('[data-testid="decision-banner-done-1"]')).toBeNull();
  });

  it("keeps one answered in this session", () => {
    const { container, saved, rerender } = drawOverview({ papers: [decided("live-1")] });
    container.querySelector<HTMLButtonElement>('[data-testid="decision-save-live-1"]')?.click();
    rerender();
    expect(container.querySelector('[data-testid="decision-banner-live-1"]')).not.toBeNull();
    expect(saved.at(-1)?.decisionSeen).toBe("accept:EMNLP 2026");
  });

  it("closes on the close button and records that it was seen", () => {
    const { container, saved, rerender } = drawOverview({ papers: [decided("close-1")] });
    container.querySelector<HTMLButtonElement>('[data-testid="decision-dismiss-close-1"]')?.click();
    rerender();
    expect(container.querySelector('[data-testid="decision-banner-close-1"]')).toBeNull();
    expect(saved.at(-1)?.decisionSeen).toBe("accept:EMNLP 2026");
    expect(saved.at(-1)?.presentationType).toBeUndefined();
  });

  const members = [{ id: "ada", name: "Ada Lovelace", privilege_level: "member" }];

  it("records sent only when the assigned owner explicitly confirms it", () => {
    const { container, saved, rerender } = drawOverview({
      papers: [decided("decision-email")],
      members,
    });
    container
      .querySelector<HTMLButtonElement>('[data-testid="decision-email-toggle-decision-email"]')
      ?.click();
    rerender();
    container
      .querySelector<HTMLButtonElement>('[data-testid="decision-email-sent-decision-email"]')
      ?.click();
    expect(saved.at(-1)).toMatchObject({
      id: "decision-email",
      decisionEmailSent: "accept:EMNLP 2026",
    });
  });

  it("can undo an accidental sent mark", () => {
    const { container, saved, rerender } = drawOverview({
      papers: [
        decided("decision-email-undo", {
          artifacts: { decision_coauthor_email_sent: "accept:EMNLP 2026" },
        }),
      ],
      members,
    });
    const toggle = '[data-testid="decision-email-toggle-decision-email-undo"]';
    expect(container.querySelector(toggle)?.textContent).toContain("sent");
    container.querySelector<HTMLButtonElement>(toggle)?.click();
    rerender();
    container
      .querySelector<HTMLButtonElement>('[data-testid="decision-email-sent-decision-email-undo"]')
      ?.click();
    expect(saved.at(-1)).toMatchObject({ id: "decision-email-undo", decisionEmailSent: "" });
  });
});

describe("the flat view", () => {
  function openFlat(options: Parameters<typeof drawOverview>[0] = {}, expand = true) {
    const drawn = drawOverview(options);
    drawn.container
      .querySelector<HTMLButtonElement>('[data-testid="my-work-open-legacy"]')!
      .click();
    drawn.rerender();
    // Field-edit cases open their controls; the default drawing is verified separately.
    if (expand) {
      for (const toggle of drawn.container.querySelectorAll<HTMLButtonElement>(
        '[data-testid^="paper-legacy-collapse-"]',
      )) {
        toggle.click();
        drawn.rerender();
      }
      for (const toggle of drawn.container.querySelectorAll<HTMLButtonElement>(
        '[data-testid^="paper-legacy-group-toggle-"]',
      )) {
        toggle.click();
        drawn.rerender();
      }
    }
    return drawn;
  }

  it("starts flat papers and their groups collapsed, then preserves a reader's expansion", () => {
    const drawn = openFlat({}, false);
    const toggle = '[data-testid="paper-legacy-collapse-p1"]';
    expect(drawn.container.querySelector(toggle)?.getAttribute("aria-expanded")).toBe("false");
    drawn.container.querySelector<HTMLButtonElement>(toggle)!.click();
    drawn.rerender();
    expect(drawn.container.querySelector(toggle)?.getAttribute("aria-expanded")).toBe("true");
    expect(
      drawn.container.querySelectorAll('[data-testid^="paper-legacy-group-toggle-"]'),
    ).toHaveLength(7);
    expect(
      drawn.container.querySelectorAll(
        '[data-testid^="paper-legacy-group-toggle-"][aria-expanded="true"]',
      ),
    ).toHaveLength(0);
  });

  it("is offered on a single paper, unlike the sheet", () => {
    const { container } = drawOverview({ papers: [paper()] });
    expect(container.querySelector('[data-testid="my-work-open-grid"]')).toBeNull();
    expect(container.querySelector('[data-testid="my-work-open-legacy"]')).not.toBeNull();
  });

  it("swaps the card list for the flat form and back", () => {
    const drawn = openFlat();
    expect(drawn.container.querySelector('[data-testid="paper-legacy"]')).not.toBeNull();
    expect(drawn.container.querySelector('[data-testid="project-card-p1"]')).toBeNull();
    drawn.container.querySelector<HTMLButtonElement>('[data-testid="paper-legacy-exit"]')!.click();
    drawn.rerender();
    expect(drawn.container.querySelector('[data-testid="paper-legacy"]')).toBeNull();
    expect(drawn.container.querySelector('[data-testid="project-card-p1"]')).not.toBeNull();
  });

  it("hides nothing: every paper on the list is on the flat form, active or not", () => {
    const done = paper({ id: "p2", title: "Second paper", artifacts: { completed_at: "x" } });
    const drawn = openFlat({ papers: [paper(), done], projects: null });
    expect(drawn.container.querySelector('[data-testid="paper-legacy-paper-p1"]')).not.toBeNull();
    expect(drawn.container.querySelector('[data-testid="paper-legacy-paper-p2"]')).not.toBeNull();
  });

  // Anything only a project page draws would be something the flat view's reader never sees. The
  // conference branch is the one that mattered: attendance, the trip, and reimbursements.
  it("carries each paper's conference branch, completion, blockers and PaperFlow", () => {
    const accepted = paper({
      venue_decision: "accept",
      accepted_venue: "EMNLP",
      accepted_year: 2026,
      is_archival: true,
      presentation_type: "poster",
    });
    const { container } = openFlat({
      papers: [accepted],
      slots: { p1: emptyCycle({ conferenceKey: "emnlp-2026" }) },
      trip: true,
    });
    const extras = container.querySelector('[data-testid="paper-legacy-extras-p1"]');
    expect(extras?.querySelector('[data-testid="paper-attendee-add-p1"]')).not.toBeNull();
    expect(extras?.querySelector('[data-testid="paper-travel-p1"]')).not.toBeNull();
    expect(extras?.querySelector('[data-testid="paper-completion-p1"]')).not.toBeNull();
    // The step picker is already a flat-form row; a second copy of it stays off this page.
    expect(container.querySelector('[data-testid="my-work-step-p1"]')).toBeNull();
    expect(container.querySelector('[data-testid="my-work-map-p1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="paper-legacy-report-p1"]')).not.toBeNull();
  });

  it("keeps the conference branch shut until the paper is accepted", () => {
    const { container } = openFlat({
      slots: { p1: emptyCycle({ conferenceKey: "emnlp-2026" }) },
      trip: true,
    });
    expect(container.querySelector('[data-testid="paper-cycle-p1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="paper-attendee-add-p1"]')).toBeNull();
    expect(container.querySelector('[data-testid="paper-travel-p1"]')).toBeNull();
  });

  it("offers the feedback request form, not raw feedback fields", () => {
    const cycle = emptyCycle({
      slots: ["feedback_arr", "feedback_arxiv", "feedback_camera_ready"].map((slot) => ({
        paper_id: "p1",
        slot,
        status: "missing",
      })) as never,
    });
    const { container, slotWrites } = openFlat({ slots: { p1: cycle } });
    expect(container.querySelector('[data-testid="paper-legacy-p1-feedback_arr"]')).toBeNull();
    const card = container.querySelector(
      '[data-testid="paper-legacy-paper-p1"] [data-testid="paper-feedback"]',
    );
    const form = card!.querySelector("form")!;
    form.querySelector<HTMLInputElement>('input[name="url"]')!.value =
      "https://example.com/draft.pdf";
    form.querySelector<HTMLTextAreaElement>('textarea[name="reason"]')!.value = "Ready for a read";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(slotWrites).toHaveLength(1);
    expect(slotWrites[0]).toMatchObject({ paperId: "p1", slot: "feedback_arr" });
    expect(JSON.parse(String(slotWrites[0]?.input.value_text))).toEqual({
      reason: "Ready for a read",
      url: "https://example.com/draft.pdf",
    });
  });

  it("drops an old member's flat-form draft and pending autosave on session reset", () => {
    vi.useFakeTimers();
    try {
      const first = openFlat();
      const title = first.container.querySelector<HTMLInputElement>(
        '[data-testid="paper-legacy-p1-title"]',
      )!;
      title.value = "Private draft";
      title.dispatchEvent(new Event("input", { bubbles: true }));
      first.rerender();
      expect(title.value).toBe("Private draft");
      recordHistory([
        {
          at: new Date().toISOString(),
          paperTitle: "Private paper",
          column: "Title",
          from: "",
          to: "Private draft",
          kind: "added",
        },
      ]);

      resetProjectsSessionState();
      vi.advanceTimersByTime(1000);
      expect(first.saved).toHaveLength(0);
      expect(loadHistory()).toEqual([]);

      const second = openFlat();
      expect(
        second.container.querySelector<HTMLInputElement>('[data-testid="paper-legacy-p1-title"]')
          ?.value,
      ).toBe("Causal abstraction");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the sheet", () => {
  const papers = (count: number) =>
    Array.from({ length: count }, (_unused, index) => paper({ id: `p${index + 1}` }));
  const onSheet = (container: HTMLElement) => container.querySelector(".my-work--sheet") !== null;

  // The landing rule main's My Projects used (opensOnSheet): an administrator as soon as the sheet
  // is offered, anybody else from five papers. Below that the cards are the page.
  describe("the drawing the page lands on", () => {
    it("lands a member with four papers on the cards, and still offers the sheet", () => {
      const { container } = drawOverview({ papers: papers(4) });
      expect(onSheet(container)).toBe(false);
      expect(container.querySelector('[data-testid="project-card-p1"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="my-work-open-grid"]')).not.toBeNull();
    });

    it("lands a member with five papers on the sheet", () => {
      const { container } = drawOverview({ papers: papers(5) });
      expect(onSheet(container)).toBe(true);
      expect(container.querySelector('[data-testid="project-card-p1"]')).toBeNull();
    });

    it("lands an administrator on the sheet as soon as it is offered", () => {
      expect(onSheet(drawOverview({ papers: papers(3), viewerIsAdmin: true }).container)).toBe(
        true,
      );
    });

    it("leaves an administrator on the cards where the sheet is not offered", () => {
      const { container } = drawOverview({ papers: papers(2), viewerIsAdmin: true });
      expect(onSheet(container)).toBe(false);
      expect(container.querySelector('[data-testid="my-work-open-grid"]')).toBeNull();
    });

    it("counts only the papers on the reader's list, not the hidden ones", () => {
      const list = papers(5);
      const page = drawPage({ papers: list, paperId: "p5" });
      page.container.querySelector<HTMLButtonElement>('[data-testid="my-work-hide-p5"]')!.click();
      expect(onSheet(drawOverview({ papers: list }).container)).toBe(false);
    });

    // A default that reasserted itself on the next render would make Back to cards do nothing.
    it("keeps the cards once the reader asks for them, and reopens the sheet on request", () => {
      const list = papers(6);
      const first = drawOverview({ papers: list });
      expect(onSheet(first.container)).toBe(true);
      first.container
        .querySelector<HTMLButtonElement>(".paper-grid__tools .btn:last-of-type")!
        .click();
      expect(onSheet(drawOverview({ papers: list }).container)).toBe(false);
      const second = drawOverview({ papers: list });
      second.container
        .querySelector<HTMLButtonElement>('[data-testid="my-work-open-grid"]')!
        .click();
      expect(onSheet(drawOverview({ papers: list }).container)).toBe(true);
    });

    it("starts over for the next member on this browser", () => {
      const list = papers(6);
      drawOverview({ papers: list })
        .container.querySelector<HTMLButtonElement>(".paper-grid__tools .btn:last-of-type")!
        .click();
      resetProjectsSessionState();
      expect(onSheet(drawOverview({ papers: list }).container)).toBe(true);
    });
  });

  it("is offered above the threshold and takes the page when asked for", () => {
    const first = drawOverview({ papers: papers(3) });
    expect(onSheet(first.container)).toBe(false);
    first.container.querySelector<HTMLButtonElement>('[data-testid="my-work-open-grid"]')!.click();
    first.rerender();
    expect(onSheet(first.container)).toBe(true);
    expect(first.container.querySelector('[data-testid="project-card-p1"]')).toBeNull();
  });

  it("is not offered for two papers -- two rows are worse than two cards", () => {
    const { container } = drawOverview({ papers: papers(2) });
    expect(container.querySelector('[data-testid="my-work-open-grid"]')).toBeNull();
  });

  it("goes back to the cards and reopens on request", () => {
    const list = papers(4);
    const first = drawOverview({ papers: list });
    first.container.querySelector<HTMLButtonElement>('[data-testid="my-work-open-grid"]')!.click();
    first.rerender();
    first.container
      .querySelector<HTMLButtonElement>(".paper-grid__tools .btn:last-of-type")!
      .click();
    first.rerender();
    expect(onSheet(first.container)).toBe(false);
    expect(first.container.querySelector('[data-testid="project-card-p1"]')).not.toBeNull();
  });

  it("keeps the decision banner above the sheet", () => {
    const decided = paper({
      venue_decision: "accept",
      accepted_venue: "EMNLP 2026",
      current_step: "submission",
    });
    const drawn = drawOverview({ papers: [decided, ...papers(4).slice(1)] });
    drawn.container.querySelector<HTMLButtonElement>('[data-testid="my-work-open-grid"]')!.click();
    drawn.rerender();
    expect(onSheet(drawn.container)).toBe(true);
    expect(drawn.container.querySelector('[data-testid="decision-banner-p1"]')).not.toBeNull();
  });
});
