/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";
import type { LabSharingSnapshot } from "../data/lab-sharing.ts";
import { renderLabSharing } from "./lab-sharing.ts";

// The rows the service would have answered with. Seeded on the state rather than faked at the
// network, because what these tests are about is the panels: given this snapshot, what is on the
// page. The fetch layer has nothing to do here -- with no stored session the controller never
// reaches it.
function snapshot(overrides: Partial<LabSharingSnapshot> = {}): LabSharingSnapshot {
  return {
    projects: [
      { id: "paper-adminbot", title: "AdminBot" },
      { id: "paper-scm", title: "Causal Tutor" },
    ],
    mine: [
      {
        paper_id: "paper-scm",
        title: "Causal Tutor",
        owner_name: "Ada Lovelace",
        description: "A second pair of eyes on the SCM playground.",
        tags: ["causality", "visualization"],
        members_needed: 1,
        hours_per_week: 2,
        timeline: "before the demo",
        status: "open",
        can_manage: true,
      },
    ],
    open: [
      {
        paper_id: "paper-traces",
        title: "Trace labelling",
        owner_name: "Mei Lin",
        description: "Label ~400 traces by error type.",
        tags: ["annotation"],
        members_needed: 2,
        hours_per_week: 3,
        timeline: "this month",
        status: "open",
        can_manage: false,
      },
      {
        paper_id: "paper-tutor",
        title: "Tutor UX",
        owner_name: "Sirui Lu",
        description: "Click through the playground and file bugs.",
        tags: ["UI/UX feedback"],
        members_needed: 1,
        hours_per_week: 1,
        timeline: "no rush",
        status: "open",
        can_manage: false,
      },
    ],
    invites: [
      {
        id: "inv1",
        status: "pending",
        kind: "collaboration",
        project_title: "AdminBot",
        recipient_name: "Ada Lovelace",
      },
    ],
    status: {
      availability: "busy",
      message: "Heads down on the ARR rebuttal until Friday.",
      updated_at: "2026-09-10T10:00:00.000Z",
      expires_at: "2026-09-20T10:00:00.000Z",
    },
    ...overrides,
  };
}

function createState(overrides: Partial<AppViewState> = {}): AppViewState {
  return {
    tab: "labSharing",
    labSharing: snapshot(),
    ...overrides,
  } as unknown as AppViewState;
}

function renderView(overrides: Partial<AppViewState> = {}) {
  const state = createState(overrides);
  const container = document.createElement("div");
  document.body.append(container);
  const draw = () => render(renderLabSharing(state), container);
  (state as AppViewState & { requestUpdate?: () => void }).requestUpdate = draw;
  draw();
  return { state, container, draw };
}

function click(container: HTMLElement, selector: string): void {
  container.querySelector<HTMLElement>(selector)?.click();
}

function text(container: HTMLElement, testId: string): string {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.textContent ?? "";
}

function input(container: HTMLElement, selector: string, value: string): void {
  const node = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!node) {
    throw new Error(`no input for ${selector}`);
  }
  node.value = value;
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("renderLabSharing", () => {
  it("renders every panel on the page", () => {
    const { container } = renderView();
    for (const testId of [
      "lab-sharing-director",
      "lab-sharing-invites",
      "lab-sharing-requests",
      "lab-sharing-seek-help",
      "lab-sharing-open-projects",
      "lab-sharing-announcements",
    ]) {
      expect(container.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
    }
  });

  // It was a preview; five of its six panels now read the service, so the blanket warning went.
  it("no longer calls the whole tab a preview", () => {
    const { container } = renderView();
    expect(container.querySelector('[data-testid="lab-sharing-coming-soon"]')).toBeNull();
  });

  it("shows the standing broadcast and its availability", () => {
    const { container } = renderView();
    expect(text(container, "lab-sharing-director")).toContain("ARR rebuttal");
    expect(text(container, "lab-sharing-director")).toContain("Busy");
  });

  // Nothing standing is nothing to say. An empty status card reads as a broadcast that failed to
  // load, which is worse than no card.
  it("leaves the broadcast strip out when there is none", () => {
    const { container } = renderView({ labSharing: snapshot({ status: null }) });
    expect(container.querySelector('[data-testid="lab-sharing-director"]')).toBeNull();
  });

  // The panel was drawn for invitations arriving. The service only has outgoing ones, so the card
  // names who it went to and where it has got to.
  it("lists an invitation the member sent, with its approval state", () => {
    const { container } = renderView();
    const card = container.querySelector('[data-testid="lab-sharing-invite-inv1"]');
    expect(card?.textContent).toContain("To Ada Lovelace");
    expect(card?.textContent).toContain("AdminBot");
    expect(card?.textContent).toContain("Waiting for an admin");
  });

  it("opens an invitation's details and closes them again", () => {
    const { container } = renderView();
    click(container, `[data-testid="lab-sharing-invite-inv1"] .lab-sharing-invite__view`);
    expect(container.querySelector('[data-testid="lab-sharing-invite-dialog"]')).not.toBeNull();
    click(container, ".lab-sharing-invite-dialog__close");
    expect(container.querySelector('[data-testid="lab-sharing-invite-dialog"]')).toBeNull();
  });

  it("lists the member's own posts", () => {
    const { container } = renderView();
    const requests = text(container, "lab-sharing-requests");
    expect(requests).toContain("Causal Tutor");
    expect(requests).toContain("A second pair of eyes");
  });

  // The search is the service's now, so an empty box shows the prompt and a query shows whatever
  // the last search put on the state.
  it("shows members only once a search has returned some", () => {
    const { state, container } = renderView({ labSharingSearchQuery: "" });
    expect(container.querySelector(".lab-sharing-seek__hint")).not.toBeNull();
    expect(container.querySelector(".lab-sharing-member")).toBeNull();

    state.labSharingSearchQuery = "ada";
    state.labSharingMembers = [
      {
        id: "m1",
        name: "Ada Lovelace",
        research_branch: "External Collaborator",
        research_topics: ["reasoning"],
        matched_fields: ["name"],
        projects: [{ id: "paper-adminbot", title: "AdminBot" }],
      },
    ];
    (state as AppViewState & { requestUpdate?: () => void }).requestUpdate?.();
    expect(text(container, "lab-sharing-member-m1")).toContain("Ada Lovelace");
    expect(text(container, "lab-sharing-member-m1")).toContain("External Collaborator");
  });

  it("offers the member's own papers as the project to ask about", () => {
    const { container } = renderView();
    expect(text(container, "lab-sharing-seek-help")).toContain("AdminBot");
    expect(text(container, "lab-sharing-seek-help")).toContain("Causal Tutor");
  });

  it("confirms a general call against the form contents before posting", () => {
    const { container } = renderView({
      labSharingAskProjectId: "paper-adminbot",
      labSharingAskComment: "Looking for reviewers.",
      labSharingAskMembers: 2,
      labSharingAskHours: 3,
      labSharingAskTags: ["QA", "causality"],
    });
    click(container, `[data-testid="lab-sharing-general-call"]`);
    const dialog = container.querySelector('[data-testid="lab-sharing-general-call-dialog"]');
    expect(dialog?.textContent).toContain("AdminBot");
    expect(dialog?.textContent).toContain("Looking for reviewers.");
    expect(dialog?.textContent).toContain("QA");
  });

  // The board is the service's answer, not a local list: a posted call shows up because the reload
  // brought it back, so the click must not invent a row of its own.
  it("closes the dialog on send without inventing a row", () => {
    const { container } = renderView({
      labSharingAskProjectId: "paper-adminbot",
      labSharingAskComment: "Fresh request.",
    });
    const before = [...container.querySelectorAll(".lab-sharing-request")].length;
    click(container, `[data-testid="lab-sharing-general-call"]`);
    click(container, `[data-testid="lab-sharing-general-call-send"]`);
    expect(container.querySelector('[data-testid="lab-sharing-general-call-dialog"]')).toBeNull();
    expect([...container.querySelectorAll(".lab-sharing-request")].length).toBe(before);
  });

  it("asks for a second click before taking a post down, and cancels instead", () => {
    const { container } = renderView();
    const row = `[data-testid="lab-sharing-request-paper-scm"]`;
    click(container, `${row} .lab-sharing-request__delete`);
    expect(container.querySelector(".lab-sharing-request__delete--confirm")).not.toBeNull();
    click(container, `${row} .lab-sharing-request__cancel`);
    expect(container.querySelector(".lab-sharing-request__delete--confirm")).toBeNull();
  });

  it("navigates the open-projects deck with the prev/next arrows", () => {
    const { container } = renderView();
    const firstTitle = container.querySelector(".lab-sharing-project__title")?.textContent ?? "";
    expect(text(container, "lab-sharing-open-projects")).toContain("1 / 2");

    click(container, ".lab-sharing-projects__nav--next");
    expect(container.querySelector(".lab-sharing-project__title")?.textContent).not.toBe(
      firstTitle,
    );
    expect(text(container, "lab-sharing-open-projects")).toContain("2 / 2");

    click(container, ".lab-sharing-projects__nav--prev");
    expect(container.querySelector(".lab-sharing-project__title")?.textContent).toBe(firstTitle);
  });

  // Discover answers with everybody's open posts; the member's own already have a panel.
  it("keeps the member's own posts out of the open-projects deck", () => {
    const { container } = renderView();
    expect(text(container, "lab-sharing-open-projects")).not.toContain("Causal Tutor");
  });

  it("reports a read that failed without hiding the rest of the tab", () => {
    const { container } = renderView({ labSharingErrors: ["Could not load projects."] });
    expect(text(container, "lab-sharing-notice")).toContain("Could not load projects.");
    expect(container.querySelector('[data-testid="lab-sharing-seek-help"]')).not.toBeNull();
  });

  // The one panel with nothing behind it. It keeps its design and says so on its face.
  it("composes and posts an announcement, and marks the panel as not live", () => {
    const { container } = renderView();
    expect(text(container, "lab-sharing-announcements")).toContain("Sample data");
    click(container, `[data-testid="lab-sharing-announcement-add"]`);
    input(container, '[data-testid="lab-sharing-announcement-compose"] textarea', "Heads up.");
    click(container, `[data-testid="lab-sharing-announcement-send"]`);
    expect(text(container, "lab-sharing-announcements")).toContain("Heads up.");
  });
});
