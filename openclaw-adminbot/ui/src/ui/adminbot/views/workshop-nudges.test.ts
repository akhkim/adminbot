/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmptyWorkshopNudgeReviewState,
  type WorkshopNudgeRecommendation,
  type WorkshopNudgeReviewState,
} from "../controllers/admin.ts";
import { renderWorkshopNudges, type WorkshopNudgesProps } from "./workshop-nudges.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

function recommendation(
  status: "allowed" | "prohibited" | "unclear" = "allowed",
): WorkshopNudgeRecommendation {
  return {
    pair_id: `paper-1::${status}`,
    final_rank: 1,
    topic_relevance: 0.9,
    match_rationale: "The call asks for work on reliable agents.",
    topic_evidence: ["AI safety", "reliable agents", "Trace)"],
    rank_explanation:
      "90% fit to the workshop's call for papers: The call asks for work on reliable agents. Attendance was unknown.",
    draft_fragment: "• “A safe paper” → Safety Workshop\n  Submission: 2035-09-01 AoE",
    paper: {
      paper_id: "paper-1",
      title: "A safe paper",
      current_submission_state: "Published",
      publication_sources: ["AdminBot paper store"],
      recipient_display_name: "Ada",
    },
    workshop: {
      workshop_id: status,
      name: `${status} workshop`,
      parent_conference_key: "neurips-2035",
      parent_conference: "NeurIPS 2035",
      conference_location: "Test City",
      topics: ["AI safety"],
      archival_status: "non_archival",
      cross_submission_status: status,
      cross_submission_evidence: `${status} in the official call`,
      cross_submission_source_url: `https://example.test/${status}`,
      profile_extracted_at: "2035-01-01T00:00:00Z",
      routes: [
        {
          deadline_id: `${status}-submission`,
          label: "Submission",
          submission_type: "direct",
          deadline_aoe: "2035-09-01 23:59:59",
          source_url: `https://example.test/${status}`,
        },
      ],
    },
  };
}

function state(overrides: Partial<WorkshopNudgeReviewState> = {}): WorkshopNudgeReviewState {
  const allowed = recommendation();
  return {
    ...createEmptyWorkshopNudgeReviewState(),
    result: {
      generated_at: "2035-01-01T00:00:00.000Z",
      paper_count: 1,
      workshop_count: 3,
      recipients: [
        {
          recipient_member_id: "member-1",
          recipient_display_name: "Ada",
          delivery_ready: true,
          recommendations: [allowed, recommendation("unclear"), recommendation("prohibited")],
          draft: {
            text: "Hi Ada —\n\nExact server message",
            pair_ids: [allowed.pair_id],
            recommendations: [allowed],
          },
        },
      ],
      unresolved_recipients: [],
      coverage: {
        members_without_usable_papers: [],
        papers_with_unresolved_authors: [],
        papers_without_active_recipients: [],
      },
    },
    selectedRecipientIds: ["member-1"],
    ...overrides,
  };
}

function draw(
  value: WorkshopNudgeReviewState = state(),
  handlers: Partial<WorkshopNudgesProps> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const props: WorkshopNudgesProps = {
    state: value,
    onRefresh: vi.fn(),
    onCancelRun: vi.fn(),
    onForceRefresh: vi.fn(),
    onToggleRecipient: vi.fn(),
    onSetRecipients: vi.fn(),
    onViewChange: vi.fn(),
    onSend: vi.fn(),
    ...handlers,
  };
  render(renderWorkshopNudges(props), container);
  return { container, props };
}

describe("renderWorkshopNudges", () => {
  it("opens a recipient detail with evidence and the exact server text", () => {
    const value = state();
    value.view.detailKey = "recipient:member-1";
    const { container } = draw(value);
    expect(container.textContent).toContain("A safe paper");
    expect(container.textContent).toContain("90% call fit");
    expect(container.textContent).toContain("The call asks for work on reliable agents.");
    expect(container.textContent).toContain("AI safety, reliable agents, Trace");
    expect(container.textContent).not.toContain("Trace)");
    expect(container.textContent).toContain("AdminBot paper store");
    expect(container.textContent).toContain("Non-archival");
    expect(container.textContent).toContain("Does not count as publishing");
    expect(container.textContent).toContain("Cross-submission");
    expect(container.textContent).toContain("Allowed");
    expect(
      container.querySelector(".workshop-nudges__evidence details summary")?.textContent,
    ).toContain("Source evidence");
    expect(container.textContent).toContain("Sep 1, 2035 · 23:59 AoE");
    expect(container.textContent).not.toContain("2035-01-01T00:00:00");
    expect(container.textContent).toContain("Exact server message");
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      "Recipients",
    );
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(container.textContent).not.toContain("Download");
  });

  it("keeps matching administrator-triggered and opens rows through view state", () => {
    const onRefresh = vi.fn();
    const empty = createEmptyWorkshopNudgeReviewState();
    const emptyView = draw(empty, { onRefresh });
    expect(emptyView.container.textContent).toContain("No recommendations yet");
    expect(emptyView.container.textContent).toContain("Find recommendations");
    expect(onRefresh).not.toHaveBeenCalled();
    emptyView.container
      .querySelector<HTMLButtonElement>('[data-testid="workshop-nudges-refresh"]')
      ?.click();
    expect(onRefresh).toHaveBeenCalledOnce();

    const onViewChange = vi.fn();
    const queue = draw(state(), { onViewChange });
    queue.container.querySelector<HTMLButtonElement>(".workshop-nudges__row-link")?.click();
    expect(onViewChange).toHaveBeenCalledWith({ detailKey: "recipient:member-1" });
  });

  it("lets the administrator omit recipients and press Nudge", () => {
    const onToggleRecipient = vi.fn();
    const onSend = vi.fn();
    const { container } = draw(state(), { onToggleRecipient, onSend });
    const recipient = container.querySelector<HTMLInputElement>(
      'input[aria-label="Include Ada in Nudge"]',
    );
    recipient?.click();
    expect(onToggleRecipient).toHaveBeenCalledWith("member-1");
    const send = container.querySelector<HTMLButtonElement>('[data-testid="workshop-nudges-send"]');
    expect(send?.textContent).toContain("Nudge 1 recipient");
    send?.click();
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("disables delivery without a Slack identity", () => {
    const value = state();
    value.result = {
      ...value.result!,
      recipients: [
        {
          ...value.result!.recipients[0]!,
          delivery_ready: false,
          delivery_blocked_reason: "No Slack identity is linked.",
        },
      ],
    };
    value.selectedRecipientIds = [];
    value.view.detailKey = "recipient:member-1";
    const { container } = draw(value);
    expect(container.textContent).toContain("No Slack identity is linked.");
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Include Ada in Nudge"]')
        ?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="workshop-nudges-send"]')?.disabled,
    ).toBe(true);
    expect(container.textContent).not.toContain("Nudge 0 recipients");
  });

  it("reports incomplete coverage without equating it to no relevant papers", () => {
    const value = state();
    value.result = {
      ...value.result!,
      recipients: [],
      unresolved_recipients: [
        { paper: recommendation().paper, recommendations: [recommendation()] },
      ],
      coverage: {
        members_without_usable_papers: [{ member_id: "member-2", name: "Ben" }],
        papers_with_unresolved_authors: [
          { paper_id: "paper-1", title: "A safe paper", author_names: ["Unknown Author"] },
        ],
        papers_without_active_recipients: [{ paper_id: "paper-1", title: "A safe paper" }],
      },
    };
    value.view.tab = "unresolved";
    const { container } = draw(value);
    const text = container.textContent?.replace(/\s+/gu, " ") ?? "";
    expect(text).toContain("not interpreted as evidence");
    expect(text).toContain("1 member without a usable paper record");
    expect(text).toContain("1 paper with unresolved authors");
    expect(text).toContain("1 paper without an active linked recipient");
    expect(text).toContain("No active linked recipient");
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      "Unresolved papers",
    );
  });

  it("switches queues and selects all ready recipients on the page", () => {
    const onViewChange = vi.fn();
    const onSetRecipients = vi.fn();
    const { container } = draw(state(), { onViewChange, onSetRecipients });
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs).toHaveLength(2);
    tabs[1]?.click();
    expect(onViewChange).toHaveBeenCalledWith({ tab: "unresolved", page: 0, detailKey: null });

    const selectAll = container.querySelector<HTMLInputElement>(
      'input[aria-label="Select all ready recipients"]',
    );
    selectAll?.click();
    expect(onSetRecipients).toHaveBeenCalledWith(["member-1"], false);
  });

  // "Matching in progress… 1671 of 2540 model calls done" with no button on the card was the whole
  // page for an administrator whose pass had died: nothing to press, nothing to do but reload and
  // read the same number again.
  it("offers a way out of a pass that is not moving", () => {
    const onCancelRun = vi.fn();
    const onForceRefresh = vi.fn();
    const value = createEmptyWorkshopNudgeReviewState();
    value.run = { status: "running", calls_done: 1671, calls_total: 2540, calls_failed: 3 };
    const { container } = draw(value, { onCancelRun, onForceRefresh });

    expect(container.textContent).toContain("1671 of 2540 model calls done");
    expect(container.textContent).toContain("3 calls failed");
    container.querySelector<HTMLButtonElement>('[data-testid="workshop-nudges-cancel"]')?.click();
    expect(onCancelRun).toHaveBeenCalledOnce();
    container
      .querySelector<HTMLButtonElement>('[data-testid="workshop-nudges-force-refresh"]')
      ?.click();
    expect(onForceRefresh).toHaveBeenCalledOnce();
  });

  // Vercel ships this UI ahead of the Aurora service as a matter of routine, so a run arriving
  // without the newer counts must render as a pass with nothing wrong, not as "undefined failed".
  it("renders a run from a service that does not send failed-call counts", () => {
    const value = createEmptyWorkshopNudgeReviewState();
    value.run = { status: "running", calls_done: 10, calls_total: 20 };
    const { container } = draw(value);
    expect(container.textContent).toContain("10 of 20 model calls done");
    expect(container.textContent).not.toContain("undefined");
    expect(container.textContent).not.toContain("calls failed");
  });
});
