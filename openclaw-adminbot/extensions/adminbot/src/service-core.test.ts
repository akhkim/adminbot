import { describe, expect, it, vi } from "vitest";
import { AdminBotService, payloadHash } from "./service-core.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

describe("AdminBotService", () => {
  it("keeps T4 candidate decisions pending until an allowed role approves the payload hash", () => {
    const service = new AdminBotService();
    const proposal = unwrap(
      service.createProposal({
        type: "candidate.accept_for_trial",
        summary: "Accept Jane Doe for trial",
        target: { name: "Jane Doe" },
      }),
    );

    expect(proposal.status).toBe("pending");
    expect(proposal.risk_tier).toBe("T4");
    expect(proposal.approval_requirement).toEqual({
      requires_approval: true,
      approver_roles: ["pi", "lab_manager"],
      min_approvals: 1,
    });

    expect(
      service.approve(proposal.id, {
        payload_hash: proposal.payload_hash,
        approver_role: "guest",
      }),
    ).toEqual({ ok: false, status: 403, error: { message: "approver role not allowed: guest" } });

    const approved = unwrap(
      service.approve(proposal.id, {
        payload_hash: proposal.payload_hash,
        approver_role: "pi",
        approver_id: "andrew",
      }),
    );

    expect(approved.status).toBe("approved");
    expect(approved.approvals).toHaveLength(1);
  });

  it("requires two approvals for public posts before execution", async () => {
    const service = new AdminBotService();
    const proposal = unwrap(
      service.createProposal({
        type: "social_media.post_publicly",
        summary: "Post paper announcement",
      }),
    );

    expect(
      service.approve(proposal.id, {
        payload_hash: proposal.payload_hash,
        approver_role: "pi",
        approver_id: "pi-1",
      }),
    ).toMatchObject({ ok: true });
    expect(service.getProposal(proposal.id)?.status).toBe("pending");
    expect(await service.execute(proposal.id, { dry_run: true })).toEqual({
      ok: false,
      status: 409,
      error: { message: "proposal is not approved" },
    });

    unwrap(
      service.approve(proposal.id, {
        payload_hash: proposal.payload_hash,
        approver_role: "lab_manager",
        approver_id: "manager-1",
      }),
    );

    const result = unwrap(
      await service.execute(proposal.id, {
        dry_run: true,
        idempotency_key: "post-paper-announcement",
      }),
    );
    expect(result).toMatchObject({
      action_id: proposal.id,
      status: "simulated",
      dry_run: true,
      idempotency_key: "post-paper-announcement",
    });
    expect(service.getProposal(proposal.id)?.status).toBe("approved");
  });

  it("requires approval for Slack message proposals", () => {
    const service = new AdminBotService();
    const proposal = unwrap(
      service.createProposal({
        type: "slack.send_message",
        summary: "Send Slack DM to U09NYHPDDL4",
        target: { service: "slack", target: "U09NYHPDDL4" },
        proposed_payload: {
          tool: "message",
          action: "send",
          channel: "slack",
          target: "U09NYHPDDL4",
          message: "Welcome to the workspace.",
        },
      }),
    );

    expect(proposal.status).toBe("pending");
    expect(proposal.risk_tier).toBe("T3");
    expect(proposal.approval_requirement).toEqual({
      requires_approval: true,
      approver_roles: ["pi", "lab_manager"],
      min_approvals: 1,
    });

    expect(
      service.approve(proposal.id, {
        payload_hash: proposal.payload_hash,
        approver_role: "lab_manager",
      }),
    ).toMatchObject({ ok: true });
  });

  it("auto-approves observational join form classification", async () => {
    const service = new AdminBotService();
    const proposal = unwrap(
      service.createProposal({
        type: "join_form.classify",
        summary: "Classify response 1",
      }),
    );

    expect(proposal.status).toBe("approved");
    expect(proposal.risk_tier).toBe("T0");
    expect(proposal.approval_requirement.requires_approval).toBe(false);
    expect(unwrap(await service.execute(proposal.id, { dry_run: true })).status).toBe("simulated");
  });

  it("rejects changed payload hashes and replays idempotent execution", async () => {
    const execute = vi.fn(async () => ({ handled: true }));
    const service = new AdminBotService(undefined, { executor: { execute } });
    const proposal = unwrap(
      service.createProposal({
        type: "email.send",
        summary: "Send candidate email",
      }),
    );

    expect(
      service.approve(proposal.id, {
        payload_hash: "wrong-hash",
        approver_role: "pi",
      }),
    ).toEqual({ ok: false, status: 409, error: { message: "payload hash mismatch" } });

    unwrap(
      service.approve(proposal.id, {
        payload_hash: proposal.payload_hash,
        approver_role: "pi",
      }),
    );
    const first = unwrap(
      await service.execute(proposal.id, {
        dry_run: false,
        idempotency_key: "email-send-1",
      }),
    );
    const second = unwrap(
      await service.execute(proposal.id, {
        dry_run: false,
        idempotency_key: "email-send-1",
      }),
    );

    expect(second).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.listAuditEvents().map((event) => event.type)).toContain(
      "execution.idempotent_replay",
    );
  });

  it("hashes equivalent object payloads consistently", () => {
    expect(payloadHash({ b: 2, a: { y: true, x: "x" } })).toBe(
      payloadHash({ a: { x: "x", y: true }, b: 2 }),
    );
  });

  it("stores lab member privilege levels with computed access grants", () => {
    const service = new AdminBotService();
    const member = unwrap(
      service.upsertLabMember({
        id: "zhijing",
        name: "Zhijing",
        email: "zhijing@example.test",
        privilege_level: "admin",
      }),
    );

    expect(member.access).toContainEqual({
      service: "slack",
      access: "admin",
      scope: "lab workspace",
    });
    expect(unwrap(service.listLabMembers()).members).toEqual([member]);
    expect(service.listAuditEvents().map((event) => event.type)).toContain("lab_member.upserted");
  });

  it("defaults temporary lab member privilege to member through service settings", () => {
    const service = new AdminBotService();
    const member = unwrap(
      service.upsertLabMember({
        id: "temporary-member",
        name: "Temporary Member",
      }),
    );

    expect(member.privilege_level).toBe("member");
    expect(member.access).toContainEqual({
      service: "google_drive",
      access: "edit",
      scope: "member paper folders",
    });

    unwrap(service.updateSettings({ default_privilege_level: "trial" }));
    const trial = unwrap(
      service.upsertLabMember({
        id: "trial-member",
        name: "Trial Member",
      }),
    );
    expect(trial.privilege_level).toBe("trial");
  });

  it("adds a progress-based paper timeline to listed papers and due nudges", () => {
    const service = new AdminBotService();
    unwrap(
      service.upsertPaper({
        id: "paper-timeline",
        title: "Paper Timeline",
        authors: ["alice"],
        current_step: "social_posts",
        reminder: {
          status: "waiting_on_authors",
          next_nudge_at: "2026-06-01T00:00:00.000Z",
        },
      }),
    );

    const [paper] = unwrap(service.listPapers()).papers;
    expect(paper?.timeline).toMatchObject({
      progress_percent: 69,
      total_estimated_business_days: 16,
      items: expect.arrayContaining([
        expect.objectContaining({ step: "overleaf_writing", status: "complete" }),
        expect.objectContaining({ step: "social_posts", status: "current" }),
        expect.objectContaining({ step: "slide_making", status: "upcoming" }),
        expect.objectContaining({ step: "poster_making", status: "upcoming" }),
      ]),
    });
    expect(unwrap(service.listPaperNudges("2026-06-02T00:00:00.000Z")).nudges[0]).toMatchObject({
      paper_id: "paper-timeline",
      timeline: expect.objectContaining({ progress_percent: 69 }),
    });
  });
  it("uses settings defaults for paper escalation", () => {
    const service = new AdminBotService();
    unwrap(
      service.updateSettings({
        paper_escalation_business_days: 2,
        head_professor_member_id: "zhijing",
      }),
    );
    const paper = unwrap(
      service.upsertPaper({
        id: "paper-settings",
        title: "Paper Settings",
        authors: ["alice"],
        current_step: "overleaf_writing",
        reminder: {
          status: "waiting_on_authors",
          last_author_dm_at: "2026-06-01T12:00:00.000Z",
        },
      }),
    );

    expect(paper.reminder).toMatchObject({
      escalation_after_business_days: 2,
      head_professor_member_id: "zhijing",
    });
    expect(unwrap(service.listPaperNudges("2026-06-03T12:00:00.000Z")).nudges).toEqual([
      expect.objectContaining({
        type: "head_professor_escalation",
        recipients: ["zhijing"],
        business_days_since_author_dm: 2,
      }),
    ]);
  });

  it("escalates paper reminders to the head professor after three business days", () => {
    const service = new AdminBotService();
    unwrap(
      service.upsertPaper({
        id: "paper-1",
        title: "Causal Garden Planning",
        authors: ["alice", "bob"],
        current_step: "arxiv_polish",
        artifacts: {
          overleaf_view_url: "https://overleaf.example/view",
          google_drive_pdf_url: "https://drive.example/pdf",
        },
        reminder: {
          status: "waiting_on_authors",
          last_author_dm_at: "2026-06-01T12:00:00.000Z",
          escalation_after_business_days: 3,
          head_professor_member_id: "zhijing",
        },
      }),
    );

    expect(unwrap(service.listPaperNudges("2026-06-03T12:00:00.000Z")).nudges).toEqual([
      expect.objectContaining({
        type: "author_nudge",
        paper_id: "paper-1",
        title: "Causal Garden Planning",
        step: "arxiv_polish",
        recipients: ["alice", "bob"],
        message: 'Remind authors to complete arxiv_polish for "Causal Garden Planning".',
        timeline: expect.objectContaining({ current_step_index: 4, progress_percent: 56 }),
      }),
    ]);
    expect(unwrap(service.listPaperNudges("2026-06-04T12:00:00.000Z")).nudges).toEqual([
      expect.objectContaining({
        type: "head_professor_escalation",
        recipients: ["zhijing"],
        business_days_since_author_dm: 3,
      }),
    ]);
  });

  it("does not escalate paper reminders after an author reply", () => {
    const service = new AdminBotService();
    unwrap(
      service.upsertPaper({
        id: "paper-2",
        title: "Paper With Reply",
        authors: ["alice"],
        current_step: "slide_making",
        reminder: {
          status: "waiting_on_authors",
          last_author_dm_at: "2026-06-01T12:00:00.000Z",
          last_author_reply_at: "2026-06-02T12:00:00.000Z",
          head_professor_member_id: "zhijing",
        },
      }),
    );

    expect(unwrap(service.listPaperNudges("2026-06-08T12:00:00.000Z")).nudges).toEqual([]);
  });
});
