import { describe, expect, it } from "vitest";
import { createAdminBotOpenReviewWorkflow } from "./openreview-workflow.js";
import { AdminBotMemoryStore, AdminBotService } from "./service-core.js";

const DAY = 86_400_000;
const DEADLINE = Date.parse("2026-09-10T00:00:00.000Z");
const VENUE = "TestVenue.cc/2026/Conference";

function discoverResult(role = "ac") {
  return {
    ok: true,
    profile_id: "~Zhijing_Jin1",
    venues: [
      {
        venue_id: VENUE,
        title: "TestVenue 2026",
        role,
        deadline_ms: DEADLINE,
        cycle_start_ms: DEADLINE - 20 * DAY,
        reviewers_message_submission_id: `${VENUE}/Submission{number}/-/Message`,
        area_chairs_message_submission_id: `${VENUE}/Submission{number}/Area_Chairs/-/Message`,
        submission_name: "Submission",
      },
    ],
    skipped: [{ venue_id: "OldVenue.cc/2025/Conference", role: "ac", reason: "deadline is stale" }],
  };
}

function statusResult(papers: Array<Record<string, unknown>>) {
  return {
    ok: true,
    profile_id: "~Zhijing_Jin1",
    venue_id: VENUE,
    role: "ac",
    papers,
    total_missing: papers.reduce(
      (total, entry) => total + ((entry.missing_reviewers as string[]) ?? []).length,
      0,
    ),
  };
}

function paper(number: number, missing: string[] = ["~Late_Reviewer1"]) {
  return {
    number,
    note_id: `note${number}`,
    title: `Paper ${number}`,
    abstract: "",
    keywords: [],
    assigned_reviewers: ["~Late_Reviewer1", "~Prompt_Reviewer1"],
    missing_reviewers: missing,
    reviewers_group_id: `${VENUE}/Submission${number}/Reviewers`,
    area_chairs_group_id: `${VENUE}/Submission${number}/Area_Chairs`,
    my_ac_signature: `${VENUE}/Submission${number}/Area_Chair_abcd`,
    my_sac_signature: `${VENUE}/Submission${number}/Senior_Area_Chairs`,
  };
}

type Harness = {
  workflow: ReturnType<typeof createAdminBotOpenReviewWorkflow>;
  store: AdminBotMemoryStore;
  service: AdminBotService;
  calls: string[][];
  executed: Array<Record<string, unknown>>;
};

function harness(options: {
  now: number;
  papers?: Array<Record<string, unknown>>;
  role?: string;
  maxSendsPerRun?: number;
}): Harness {
  const store = new AdminBotMemoryStore();
  const executed: Array<Record<string, unknown>> = [];
  const service = new AdminBotService(store, {
    executor: {
      async execute(proposal) {
        executed.push(proposal.proposed_payload as Record<string, unknown>);
        return { handled: true };
      },
    },
  });
  const calls: string[][] = [];
  const workflow = createAdminBotOpenReviewWorkflow({
    scriptPath: "/unused",
    service,
    store,
    now: () => options.now,
    ...(options.maxSendsPerRun === undefined ? {} : { maxSendsPerRun: options.maxSendsPerRun }),
    run: async (args) => {
      calls.push(args);
      if (args[0] === "discover") {
        return discoverResult(options.role ?? "ac");
      }
      if (args[0] === "status") {
        return statusResult(options.papers ?? [paper(1)]);
      }
      return { ok: true };
    },
  });
  return { workflow, store, service, calls, executed };
}

describe("runCycle", () => {
  it("fires the milestone whose moment has arrived and records it as sent", async () => {
    const { workflow, store } = harness({ now: DEADLINE - 7 * DAY + 3600_000 });
    const result = await workflow.runCycle({ dryRun: false });

    expect(result.outcomes).toEqual([
      expect.objectContaining({
        venue_id: VENUE,
        milestone_key: "pre-7",
        status: "sent",
        recipients: 1,
      }),
    ]);
    const milestones = store.listOpenReviewMilestones();
    expect(milestones).toHaveLength(1);
    expect(milestones[0]?.milestone_key).toBe("pre-7");
  });

  it("never sends the same milestone twice, even across runs", async () => {
    const { workflow, store, executed } = harness({ now: DEADLINE - 7 * DAY + 3600_000 });
    await workflow.runCycle({ dryRun: false });
    const second = await workflow.runCycle({ dryRun: false });

    expect(second.outcomes).toEqual([expect.objectContaining({ status: "no_milestone_due" })]);
    expect(store.listOpenReviewMilestones()).toHaveLength(1);
    expect(executed).toHaveLength(1);
  });

  it("does not query OpenReview for status when no milestone is due", async () => {
    const { workflow, calls } = harness({ now: DEADLINE - 15 * DAY });
    await workflow.runCycle({ dryRun: false });
    expect(calls.map((call) => call[0])).toEqual(["discover"]);
  });

  it("addresses reviewers as an AC and area chairs as an SAC", async () => {
    const asAc = harness({ now: DEADLINE - 7 * DAY + 3600_000 });
    await asAc.workflow.runCycle({ dryRun: false });
    expect(asAc.executed[0]?.groups).toEqual([`${VENUE}/Submission1/Reviewers`]);
    expect(asAc.executed[0]?.invitation).toBe(`${VENUE}/Submission1/-/Message`);

    const asSac = harness({ now: DEADLINE - 7 * DAY + 3600_000, role: "sac" });
    await asSac.workflow.runCycle({ dryRun: false });
    expect(asSac.executed[0]?.groups).toEqual([`${VENUE}/Submission1/Area_Chairs`]);
    expect(asSac.executed[0]?.invitation).toBe(`${VENUE}/Submission1/Area_Chairs/-/Message`);
  });

  it("holds overdue warnings as proposals instead of sending them", async () => {
    const { workflow, service, executed } = harness({ now: DEADLINE + DAY + 3600_000 });
    const result = await workflow.runCycle({ dryRun: false });

    expect(result.outcomes[0]).toMatchObject({ milestone_key: "overdue-1", status: "proposed" });
    expect(executed).toEqual([]);
    const pending = service.listPending();
    expect(pending.ok && pending.payload.proposals[0]?.type).toBe("openreview.warning");
  });

  it("composes but does not deliver on a dry run", async () => {
    const { workflow, executed } = harness({ now: DEADLINE - 7 * DAY + 3600_000 });
    const result = await workflow.runCycle({ dryRun: true });
    expect(result.outcomes[0]).toMatchObject({ status: "dry_run", recipients: 1 });
    expect(executed).toEqual([]);
  });

  it("skips a milestone when every assigned review is already in", async () => {
    const { workflow, executed } = harness({
      now: DEADLINE - 7 * DAY + 3600_000,
      papers: [paper(1, [])],
    });
    const result = await workflow.runCycle({ dryRun: false });
    expect(result.outcomes[0]).toMatchObject({ status: "skipped", recipients: 0 });
    expect(executed).toEqual([]);
    // Still recorded, so the milestone does not come back once someone falls behind later.
    expect(result.outcomes[0]?.milestone_key).toBe("pre-7");
  });

  it("aborts before sending anything when a run would exceed the message cap", async () => {
    const { workflow, executed, store } = harness({
      now: DEADLINE - 7 * DAY + 3600_000,
      papers: [paper(1), paper(2), paper(3)],
      maxSendsPerRun: 2,
    });
    const result = await workflow.runCycle({ dryRun: false });

    expect(result.errors[0]).toMatchObject({ reason: "send_cap_reached" });
    expect(executed).toEqual([]);
    expect(store.listOpenReviewMilestones()).toEqual([]);
  });

  it("reports a milestone whose catch-up window closed as missed rather than sending it late", async () => {
    const { workflow, executed } = harness({ now: DEADLINE - 3 * DAY });
    const result = await workflow.runCycle({ dryRun: false });
    expect(result.missed.map((entry) => entry.milestone_key)).toContain("pre-7");
    expect(result.missed.map((entry) => entry.milestone_key)).toContain("halfway");
    expect(executed).toEqual([]);
  });

  it("records a per-cycle snapshot so the panel has numbers between runs", async () => {
    const { workflow, store } = harness({
      now: DEADLINE - 7 * DAY + 3600_000,
      papers: [paper(1), paper(2, [])],
    });
    await workflow.runCycle({ dryRun: false });
    const [cycle] = store.listOpenReviewCycles();
    expect(cycle).toMatchObject({
      venue_id: VENUE,
      role: "ac",
      title: "TestVenue 2026",
      papers_total: 2,
      reviews_missing: 1,
    });
  });

  it("reports why discovery dropped a venue, so an empty run is not ambiguous", async () => {
    const { workflow } = harness({ now: DEADLINE - 15 * DAY });
    const result = await workflow.runCycle({ dryRun: false });
    expect(result.skipped).toEqual([
      { venue_id: "OldVenue.cc/2025/Conference", role: "ac", reason: "deadline is stale" },
    ]);
  });

  it("surfaces a failed discovery instead of silently doing nothing", async () => {
    const store = new AdminBotMemoryStore();
    const workflow = createAdminBotOpenReviewWorkflow({
      scriptPath: "/unused",
      service: new AdminBotService(store, {}),
      store,
      now: () => DEADLINE,
      run: async () => ({ ok: false, reason: "no_credentials", error: "not set" }),
    });
    const result = await workflow.runCycle({ dryRun: false });
    expect(result.errors).toEqual([{ reason: "no_credentials", error: "not set" }]);
    expect(result.outcomes).toEqual([]);
  });
});

describe("applyAssignment", () => {
  function withMember(overrides: Record<string, unknown>) {
    const h = harness({ now: DEADLINE });
    h.store.saveLabMember({
      id: "bernhard",
      name: "Bernhard Example",
      privilege_level: "member",
      access: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      ...overrides,
    });
    return h;
  }

  it("refuses to add a member with a standing reviewer exemption", async () => {
    const h = withMember({ openreview_id: "~Bernhard_Example1", reviewer_exempt: true });
    const result = await h.workflow.applyAssignment({
      venueId: VENUE,
      submission: "12",
      reviewer: "~Bernhard_Example1",
    });

    expect(result).toMatchObject({ ok: false, reason: "reviewer_exempt" });
    // The bridge is never reached, so nothing can be posted to OpenReview.
    expect(h.calls.some((call) => call[0] === "assign")).toBe(false);
  });

  it("still allows removing an exempt member, which is how the rule gets applied late", async () => {
    const h = withMember({ openreview_id: "~Bernhard_Example1", reviewer_exempt: true });
    const result = await h.workflow.applyAssignment({
      venueId: VENUE,
      submission: "12",
      reviewer: "~Bernhard_Example1",
      remove: true,
    });

    expect(result).toMatchObject({ ok: true });
    expect(h.calls.some((call) => call[0] === "assign")).toBe(true);
  });

  it("adds a member who carries no exemption", async () => {
    const h = withMember({ openreview_id: "~Bernhard_Example1" });
    const result = await h.workflow.applyAssignment({
      venueId: VENUE,
      submission: "12",
      reviewer: "~Bernhard_Example1",
    });

    expect(result).toMatchObject({ ok: true });
    expect(h.calls.some((call) => call[0] === "assign")).toBe(true);
  });
});

describe("suggestReviewers", () => {
  it("ranks lab members against the submissions that are still missing reviews", async () => {
    const { workflow, store } = harness({
      now: DEADLINE,
      papers: [
        { ...paper(1), title: "Causal Inference at Scale", keywords: ["causality"] },
        { ...paper(2, []), title: "Unrelated Robotics" },
      ],
    });
    store.saveLabMember({
      id: "ada",
      name: "Ada Lovelace",
      privilege_level: "member",
      access: [],
      research_topics: ["causality"],
      openreview_id: "~Ada_Lovelace1",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const suggestions = await workflow.suggestReviewers(VENUE);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.submission_number).toBe(1);
    expect(suggestions[0]?.suggestions[0]).toMatchObject({
      member_id: "ada",
      openreview_id: "~Ada_Lovelace1",
      blocked_reason: undefined,
    });
  });
  it("passes the chairing profile through, so it is never suggested on its own papers", async () => {
    const { workflow, store } = harness({
      now: DEADLINE,
      papers: [{ ...paper(1), title: "Causal Inference at Scale", keywords: ["causality"] }],
    });
    store.saveLabMember({
      id: "zhijing",
      name: "Zhijing Jin",
      privilege_level: "admin",
      access: [],
      research_topics: ["causality"],
      // Same profile the fake status reports as the one running the pass.
      openreview_id: "~Zhijing_Jin1",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const [submission] = await workflow.suggestReviewers(VENUE);
    expect(submission?.suggestions[0]).toMatchObject({
      member_id: "zhijing",
      blocked_reason: "is the profile chairing this venue",
    });
  });
});
