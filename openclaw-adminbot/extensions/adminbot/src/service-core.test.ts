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

  it("removes a pending proposal while retaining rejected audit state", () => {
    const service = new AdminBotService();
    const proposal = unwrap(
      service.createProposal({
        type: "slack.send_message",
        summary: "Send a test DM",
        proposed_payload: { message: "hello" },
      }),
    );

    const removed = unwrap(
      service.removePending(proposal.id, { actor: "control-ui", note: "no longer needed" }),
    );

    expect(removed.status).toBe("rejected");
    expect(unwrap(service.listPending()).proposals).toEqual([]);
    expect(
      service.approve(proposal.id, {
        payload_hash: proposal.payload_hash,
        approver_role: "pi",
      }),
    ).toEqual({ ok: false, status: 409, error: { message: "proposal is removed" } });
    expect(service.listAuditEvents()).toContainEqual(
      expect.objectContaining({
        action_id: proposal.id,
        type: "proposal.removed",
        actor: "control-ui",
        details: expect.objectContaining({ note: "no longer needed" }),
      }),
    );
  });

  it("removes an approved but unexecuted proposal", () => {
    const service = new AdminBotService();
    const proposal = unwrap(
      service.createProposal({
        type: "join_form.classify",
        summary: "Classify test response",
        proposed_payload: { responseId: "response-1" },
      }),
    );

    expect(proposal.status).toBe("approved");
    const removed = unwrap(service.removePending(proposal.id, { actor: "control-ui" }));
    expect(removed.status).toBe("rejected");
    expect(unwrap(service.listPending()).proposals).toEqual([]);
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
        role: "Principal investigator",
        status: "active",
        research_branch: "Machine intelligence",
        research_topics: ["reasoning", "alignment"],
        projects: ["AdminBot", "Jinesis"],
        hours_per_week: 40,
        capacity_percent: 70,
        affiliation: "Jinesis",
        location: "Cambridge, MA",
        timezone: "America/New_York",
      }),
    );

    expect(member).toMatchObject({
      research_branch: "Machine intelligence",
      projects: ["AdminBot", "Jinesis"],
      capacity_percent: 70,
    });
    expect(member.access).toContainEqual({
      service: "slack",
      access: "admin",
      scope: "lab workspace",
    });
    expect(unwrap(service.listLabMembers()).members).toEqual([member]);
    expect(service.listAuditEvents().map((event) => event.type)).toContain("lab_member.upserted");
  });

  it("validates lab member workload and status fields", () => {
    const service = new AdminBotService();

    expect(
      service.upsertLabMember({
        id: "invalid-capacity",
        name: "Invalid Capacity",
        capacity_percent: 101,
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      service.upsertLabMember({
        id: "invalid-hours",
        name: "Invalid Hours",
        hours_per_week: 169,
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      service.upsertLabMember({
        id: "invalid-status",
        name: "Invalid Status",
        status: "away" as never,
      }),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("lets a member self-edit whitelisted fields but not the governance fields", () => {
    const service = new AdminBotService();
    unwrap(
      service.upsertLabMember({
        id: "self-edit",
        name: "Self Edit",
        email: "self-edit@example.test",
        privilege_level: "member",
      }),
    );

    const updated = unwrap(service.updateOwnProfile("self-edit", { role: "Research scientist" }));
    expect(updated.role).toBe("Research scientist");
    expect(updated.privilege_level).toBe("member");

    for (const governed of [
      { privilege_level: "admin" },
      { status: "alumni" },
      { email: "elsewhere@example.test" },
      { access_overrides: [{ service: "slack", access: "admin" }] },
    ]) {
      expect(service.updateOwnProfile("self-edit", governed)).toMatchObject({
        ok: false,
        status: 400,
      });
    }
  });

  it("defaults a new lab member without an explicit tier to external_collaborator", () => {
    const service = new AdminBotService();
    const member = unwrap(
      service.upsertLabMember({
        id: "unspecified-member",
        name: "Unspecified Member",
      }),
    );

    expect(member.privilege_level).toBe("external_collaborator");
    expect(member.access).toContainEqual({
      service: "google_drive",
      access: "view",
      scope: "shared paper folders",
    });
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
  it("deletes paper records and records an audit event", () => {
    const service = new AdminBotService();
    unwrap(
      service.upsertPaper({
        id: "paper-delete",
        title: "Paper Delete",
        authors: ["alice"],
        current_step: "submission",
      }),
    );

    expect(unwrap(service.deletePaper("paper-delete"))).toEqual({
      deleted: true,
      paper_id: "paper-delete",
    });
    expect(unwrap(service.listPapers()).papers).toEqual([]);
    expect(service.deletePaper("paper-delete")).toEqual({
      ok: false,
      status: 404,
      error: { message: "paper not found: paper-delete" },
    });
    expect(service.listAuditEvents()).toContainEqual(
      expect.objectContaining({ type: "paper.deleted", actor: "paper-delete" }),
    );
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

  it("sends a member nudge over Slack immediately (no approval step), skipping members without a slack_user_id", async () => {
    const executor = { execute: vi.fn(async () => ({ handled: true })) };
    const service = new AdminBotService(undefined, { executor });
    unwrap(service.upsertLabMember({ id: "with-slack", name: "With Slack", slack_user_id: "U1" }));
    unwrap(service.upsertLabMember({ id: "no-slack", name: "No Slack" }));

    const result = unwrap(
      await service.sendMemberNudge(
        {
          channel: "slack",
          recipient_member_ids: ["with-slack", "no-slack", "missing"],
          message: "Reminder: submit your progress update.",
        },
        "admin-1",
      ),
    );

    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({
      type: "member_nudge.send",
      // Auto-approved and executed inline — never sits in Pending actions awaiting approval.
      status: "executed",
      approval_requirement: { requires_approval: false },
      target: { recipientMemberId: "with-slack" },
      proposed_payload: {
        channel: "slack",
        target: "U1",
        message: "Reminder: submit your progress update.",
      },
    });
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(result.skipped).toEqual([
      { member_id: "no-slack", reason: "member has no slack_user_id" },
      { member_id: "missing", reason: "member not found" },
    ]);
    expect(service.listAuditEvents().map((event) => event.type)).toContain("member_nudge.sent");
  });

  it("sends a member nudge over email, requiring a subject and skipping members without an email", async () => {
    const executor = { execute: vi.fn(async () => ({ handled: true })) };
    const service = new AdminBotService(undefined, { executor });
    unwrap(service.upsertLabMember({ id: "e1", name: "Has Email", email: "e1@example.test" }));
    unwrap(service.upsertLabMember({ id: "e2", name: "No Email" }));

    const missingSubject = await service.sendMemberNudge(
      { channel: "email", recipient_member_ids: ["e1"], message: "hi" },
      "admin-1",
    );
    expect(missingSubject).toMatchObject({ ok: false, status: 400 });

    const result = unwrap(
      await service.sendMemberNudge(
        {
          channel: "email",
          recipient_member_ids: ["e1", "e2"],
          message: "Announcement: lab meeting moved to Friday.",
          subject: "Schedule change",
        },
        "admin-1",
      ),
    );

    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({
      type: "member_nudge.send",
      status: "executed",
      proposed_payload: {
        channel: "email",
        to: "e1@example.test",
        subject: "Schedule change",
        body: "Announcement: lab meeting moved to Friday.",
      },
    });
    expect(result.skipped).toEqual([{ member_id: "e2", reason: "member has no email" }]);
  });

  it("skips a recipient whose send actually fails at execution, without failing the rest of the batch", async () => {
    const service = new AdminBotService(undefined, {
      executor: { execute: vi.fn(async () => ({ handled: false })) },
    });
    unwrap(service.upsertLabMember({ id: "with-slack", name: "With Slack", slack_user_id: "U1" }));

    const result = unwrap(
      await service.sendMemberNudge(
        { channel: "slack", recipient_member_ids: ["with-slack"], message: "hi" },
        "admin-1",
      ),
    );

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([
      {
        member_id: "with-slack",
        reason: "no live connector handles action type member_nudge.send",
      },
    ]);
  });

  it("rejects an empty message or an empty recipient list", async () => {
    const service = new AdminBotService();
    expect(
      await service.sendMemberNudge(
        { channel: "slack", recipient_member_ids: ["a"], message: "   " },
        "admin-1",
      ),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await service.sendMemberNudge(
        { channel: "slack", recipient_member_ids: [], message: "hi" },
        "admin-1",
      ),
    ).toMatchObject({ ok: false, status: 400 });
  });
});
