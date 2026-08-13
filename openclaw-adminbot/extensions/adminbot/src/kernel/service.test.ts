import { describe, expect, it, vi } from "vitest";
import { adminBotMandatoryProfileFields } from "../contracts/actions.js";
import { AdminBotService, payloadHash } from "./service.js";

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
      approver_roles: ["admin"],
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
        approver_role: "admin",
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
        approver_role: "admin",
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
        approver_role: "admin",
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
      approver_roles: ["admin"],
      min_approvals: 1,
    });

    expect(
      service.approve(proposal.id, {
        payload_hash: proposal.payload_hash,
        approver_role: "admin",
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
        approver_role: "admin",
      }),
    ).toEqual({ ok: false, status: 409, error: { message: "payload hash mismatch" } });

    unwrap(
      service.approve(proposal.id, {
        payload_hash: proposal.payload_hash,
        approver_role: "admin",
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
        approver_role: "admin",
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

  describe("Slack channel naming enforcement", () => {
    it("reminds owner on invalid names, then renames after 48 hours", async () => {
      const executor = { execute: vi.fn(async () => ({ handled: true })) };
      const service = new AdminBotService(undefined, { executor });

      const created = await service.processSlackChannelNamingEvent({
        event_type: "channel_created",
        channel_id: "C1",
        channel_name: "eu-post-training",
        owner_user_id: "U1",
      });
      expect(created).toMatchObject({
        ok: true,
        payload: { status: "reminder_sent", suggested_name: "proj-eu-post-training" },
      });

      const now = Date.now();
      const beforeDue = await service.runSlackChannelNamingSweep(
        "cron",
        new Date(now + 47 * 60 * 60 * 1000).toISOString(),
      );
      expect(beforeDue).toMatchObject({
        ok: true,
        payload: { reminders_pending: 1, renamed: 0 },
      });

      const due = await service.runSlackChannelNamingSweep(
        "cron",
        new Date(now + 49 * 60 * 60 * 1000).toISOString(),
      );
      expect(due).toMatchObject({
        ok: true,
        payload: { renamed: 1, skipped: 0 },
      });
      // reminder DM + rename + post-rename DM
      expect(executor.execute).toHaveBeenCalledTimes(3);
    });

    it("clears pending enforcement when the channel is renamed to a compliant name", async () => {
      const executor = { execute: vi.fn(async () => ({ handled: true })) };
      const service = new AdminBotService(undefined, { executor });

      await service.processSlackChannelNamingEvent({
        event_type: "channel_created",
        channel_id: "C2",
        channel_name: "rule-coherence-project",
        owner_user_id: "U2",
      });
      const renamed = await service.processSlackChannelNamingEvent({
        event_type: "channel_rename",
        channel_id: "C2",
        channel_name: "proj-rule-coherence-project",
      });
      expect(renamed).toMatchObject({ ok: true, payload: { status: "compliant" } });

      const sweep = await service.runSlackChannelNamingSweep("cron", "2099-01-01T00:00:00.000Z");
      expect(sweep).toMatchObject({ ok: true, payload: { scanned: 0, renamed: 0 } });
    });
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
        email: "zhijing@cs.toronto.edu",
        privilege_level: "admin",
        role: "Professor",
        status: "active",
        research_branch: "Machine intelligence",
        research_topics: ["reasoning", "alignment"],
        projects: ["AdminBot", "Jinesis"],
        hours_per_week: 40,
        availability: [
          { start: "2026-08-01", end: "2026-09-03", project: "AdminBot", hours_per_week: 28 },
          { start: "2026-08-01", end: "2026-09-03", project: "Jinesis", hours_per_week: 12 },
        ],
        affiliation: "Jinesis",
        location: "Cambridge, MA",
        timezone: "America/New_York",
      }),
    );

    expect(member).toMatchObject({
      research_branch: "Machine intelligence",
      projects: ["AdminBot", "Jinesis"],
      availability: [
        { start: "2026-08-01", end: "2026-09-03", project: "AdminBot", hours_per_week: 28 },
        { start: "2026-08-01", end: "2026-09-03", project: "Jinesis", hours_per_week: 12 },
      ],
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
        id: "invalid-availability",
        name: "Invalid Availability",
        availability: [
          { start: "2026-09-03", end: "2026-08-01", project: "A", hours_per_week: 10 },
        ],
      }),
    ).toMatchObject({ ok: false, status: 400 });
    // Role is a closed vocabulary: the roster is filtered and counted by it, and three spellings
    // of "PhD student" made those counts lie.
    expect(
      service.upsertLabMember({
        id: "invalid-role",
        name: "Invalid Role",
        role: "Chief Scientist",
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      service.upsertLabMember({ id: "vocab-role", name: "Vocab Role", role: "PhD Student" }).ok,
    ).toBe(true);
    // A role nobody has recorded yet is different from a wrong one.
    expect(service.upsertLabMember({ id: "no-role", name: "No Role", role: "" }).ok).toBe(true);
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

  it("accepts a collaborator subgroup only for external collaborators", () => {
    const service = new AdminBotService();
    const collaborator = unwrap(
      service.upsertLabMember({
        id: "sub",
        name: "Sub",
        privilege_level: "external_collaborator",
        collaborator_subgroup: "coauthor_minor",
      }),
    );
    expect(collaborator.collaborator_subgroup).toBe("coauthor_minor");

    // The stored level is enough: an edit that does not resend privilege_level still validates.
    expect(
      unwrap(service.upsertLabMember({ id: "sub", name: "Sub", collaborator_subgroup: "alumni" }))
        .collaborator_subgroup,
    ).toBe("alumni");

    // A promotion drops the subgroup rather than leaving a stale one on the record.
    expect(
      unwrap(service.upsertLabMember({ id: "sub", name: "Sub", privilege_level: "member" }))
        .collaborator_subgroup,
    ).toBeUndefined();

    for (const rejected of [
      // "sub" is a plain member after the promotion above, so its stored level refuses this now.
      { id: "sub", name: "Sub", collaborator_subgroup: "alumni" },
      {
        id: "bad-level-2",
        name: "Bad Level",
        privilege_level: "admin",
        collaborator_subgroup: "alumni",
      },
      {
        id: "bad-value",
        name: "Bad Value",
        privilege_level: "external_collaborator",
        collaborator_subgroup: "pen_pal",
      },
    ] as const) {
      expect(service.upsertLabMember(rejected as never)).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("lets a member self-edit whitelisted fields but not the governance fields", () => {
    const service = new AdminBotService();
    unwrap(
      service.upsertLabMember({
        id: "self-edit",
        name: "Self Edit",
        email: "self-edit@cs.toronto.edu",
        privilege_level: "member",
      }),
    );

    const updated = unwrap(service.updateOwnProfile("self-edit", { role: "Industry Researcher" }));
    expect(updated.role).toBe("Industry Researcher");
    expect(updated.privilege_level).toBe("member");

    for (const governed of [
      { privilege_level: "admin" },
      { collaborator_subgroup: "coauthor_major" },
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

  // The lab runs no object storage, so an uploaded picture lives on the record as a data URL. It
  // used to fail the https check that guards the link fields, which made the upload control inert.
  it("stores an uploaded profile photo inline, within the size and type limits", () => {
    const service = new AdminBotService();
    unwrap(
      service.upsertLabMember({
        id: "photo",
        name: "Photo Member",
        email: "photo@cs.toronto.edu",
        privilege_level: "member",
      }),
    );

    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    expect(unwrap(service.updateOwnProfile("photo", { avatar_url: png })).avatar_url).toBe(png);

    // An SVG is a document that can carry script, and this value is rendered as an <img src>.
    expect(
      service.updateOwnProfile("photo", {
        avatar_url: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      }),
    ).toMatchObject({ ok: false, status: 400 });

    // Over the 512 KB cap the upload control already enforces client-side.
    const oversized = `data:image/png;base64,${"A".repeat(1024 * 1024)}`;
    expect(service.updateOwnProfile("photo", { avatar_url: oversized })).toMatchObject({
      ok: false,
      status: 400,
    });

    // A link out is still a link: the other fields keep refusing data URLs.
    expect(service.updateOwnProfile("photo", { cv_url: png })).toMatchObject({
      ok: false,
      status: 400,
    });

    // And a real https photo URL still works.
    const hosted = "https://example.test/avatar.png";
    expect(unwrap(service.updateOwnProfile("photo", { avatar_url: hosted })).avatar_url).toBe(
      hosted,
    );
  });

  // The URN is looked up by the lab, not typed by the member, so a self update carrying one is
  // dropped like any other non-whitelisted key -- the disabled control on the profile page is the
  // label for this rule, never the rule itself.
  it("ignores a linkedin_urn sent through a self profile update, but lets an admin set it", () => {
    const service = new AdminBotService();
    unwrap(
      service.upsertLabMember({
        id: "urn-member",
        name: "URN Member",
        email: "urn-member@cs.toronto.edu",
        privilege_level: "member",
      }),
    );

    const selfEdited = unwrap(
      service.updateOwnProfile("urn-member", {
        linkedin_urn: "ACoAAB7654321",
        role: "Postdoc",
      }),
    );
    expect(selfEdited.linkedin_urn ?? "").toBe("");
    // The rest of the same update still lands: the key is dropped, the request is not refused.
    expect(selfEdited.role).toBe("Postdoc");

    const byAdmin = unwrap(
      service.upsertLabMember({
        id: "urn-member",
        name: "URN Member",
        email: "urn-member@cs.toronto.edu",
        privilege_level: "member",
        linkedin_urn: "ACoAAB1234567",
      }),
    );
    expect(byAdmin.linkedin_urn).toBe("ACoAAB1234567");
  });

  it("lets a member self-edit availability and time off, and validates both", () => {
    const service = new AdminBotService();
    unwrap(service.upsertLabMember({ id: "sched", name: "Sched", privilege_level: "member" }));

    const saved = unwrap(
      service.updateOwnProfile("sched", {
        availability: [
          { start: "2026-08-03", end: "2026-08-09", project: "Atlas", hours_per_week: 18 },
          // Sentinel project: declared spare capacity, not a real project.
          { start: "2026-08-10", end: "2026-08-16", project: "__open__", hours_per_week: 6 },
          // No project: the whole-term baseline shape.
          { start: "2026-09-01", end: "2026-12-01", hours_per_week: 12 },
        ],
        time_off: [
          { start: "2026-10-12", end: "2026-10-25", kind: "conference", availability: "partial" },
          { start: "2026-11-02", end: "2026-12-20", kind: "course_load", availability: "none" },
        ],
      }),
    );
    expect(saved.availability).toHaveLength(3);
    expect(saved.time_off?.[1]).toMatchObject({ kind: "course_load", availability: "none" });

    for (const bad of [
      { availability: [{ start: "2026-08-09", end: "2026-08-03", hours_per_week: 4 }] },
      { availability: [{ start: "03-08-2026", end: "2026-08-09", hours_per_week: 4 }] },
      { availability: [{ start: "2026-08-03", end: "2026-08-09", hours_per_week: 200 }] },
      { availability: "not-a-list" },
      {
        time_off: [
          { start: "2026-08-03", end: "2026-08-09", kind: "sabbatical", availability: "none" },
        ],
      },
      // availability is not derivable from kind, so an invalid state must be rejected outright.
      {
        time_off: [
          { start: "2026-08-03", end: "2026-08-09", kind: "vacation", availability: "maybe" },
        ],
      },
    ]) {
      expect(service.updateOwnProfile("sched", bad)).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("lets a member self-edit milestones, links and the non-Jinesis time-off kinds", () => {
    const service = new AdminBotService();
    unwrap(service.upsertLabMember({ id: "plan", name: "Plan", privilege_level: "member" }));

    const saved = unwrap(
      service.updateOwnProfile("plan", {
        availability: [
          {
            start: "2026-09-01",
            end: "2026-12-01",
            project: "Atlas",
            hours_per_week: 12,
            link: "https://example.com/board",
          },
        ],
        time_off: [
          // The two kinds added for the time-availability tab, plus a member's own name for the
          // category that does not fit the closed list.
          { start: "2026-12-24", end: "2027-01-02", kind: "personal", availability: "none" },
          {
            start: "2026-09-08",
            end: "2026-12-05",
            kind: "other_project",
            availability: "partial",
          },
          {
            start: "2026-10-13",
            end: "2026-10-17",
            kind: "other",
            availability: "none",
            label: "Reading week",
            link: "https://example.com/syllabus",
          },
        ],
        milestones: [
          { date: "2027-06-12", label: "Graduation" },
          { date: "2026-11-03", label: "Thesis draft", link: "https://example.com/thesis" },
        ],
      }),
    );
    expect(saved.milestones).toHaveLength(2);
    expect(saved.time_off?.[2]).toMatchObject({ label: "Reading week", kind: "other" });
    expect(saved.availability?.[0]?.link).toBe("https://example.com/board");

    for (const bad of [
      { milestones: "not-a-list" },
      { milestones: [{ date: "12-06-2027", label: "Graduation" }] },
      // A milestone with no label is an unexplained mark on someone's timeline.
      { milestones: [{ date: "2027-06-12", label: "   " }] },
      { milestones: [{ date: "2027-06-12", label: "Graduation", link: "not-a-url" }] },
      // Rendered as anchors, so anything but https is refused rather than left to the renderer.
      { milestones: [{ date: "2027-06-12", label: "Graduation", link: "http://example.com" }] },
      {
        availability: [
          {
            start: "2026-09-01",
            end: "2026-12-01",
            hours_per_week: 4,
            link: "javascript:alert(1)",
          },
        ],
      },
      {
        time_off: [
          {
            start: "2026-10-13",
            end: "2026-10-17",
            kind: "other",
            availability: "none",
            label: "x".repeat(121),
          },
        ],
      },
    ]) {
      expect(service.updateOwnProfile("plan", bad)).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("restricts the availability doc link to https Google Docs or Drive hosts", () => {
    const service = new AdminBotService();
    unwrap(service.upsertLabMember({ id: "doc", name: "Doc", privilege_level: "member" }));

    const saved = unwrap(
      service.updateOwnProfile("doc", {
        availability_doc_url: "https://docs.google.com/document/d/abc123/edit",
      }),
    );
    expect(saved.availability_doc_url).toBe("https://docs.google.com/document/d/abc123/edit");

    // Empty clears the link; the importer just skips members without one.
    expect(
      unwrap(service.updateOwnProfile("doc", { availability_doc_url: "" })).availability_doc_url,
    ).toBe("");

    // The importer fetches this URL with the AdminBot's own Google credentials, so anything off
    // the allowlist would turn a self-editable profile field into a fetch primitive.
    for (const bad of [
      "http://docs.google.com/document/d/abc123",
      "https://evil.example.com/document/d/abc123",
      "https://docs.google.com.evil.example.com/d/abc",
      "file:///etc/passwd",
      "not a url",
      "https://169.254.169.254/latest/meta-data/",
      42,
    ]) {
      expect(service.updateOwnProfile("doc", { availability_doc_url: bad })).toMatchObject({
        ok: false,
        status: 400,
      });
    }
  });

  it("saves an OpenReview id shaped like a real tilde id and rejects everything else", () => {
    const service = new AdminBotService();
    unwrap(service.upsertLabMember({ id: "or", name: "OR", privilege_level: "member" }));

    const saved = unwrap(service.updateOwnProfile("or", { openreview_id: "~Jane_Doe1" }));
    expect(saved.openreview_id).toBe("~Jane_Doe1");

    expect(unwrap(service.updateOwnProfile("or", { openreview_id: "" })).openreview_id).toBe("");

    for (const bad of [
      "Jane_Doe1", // missing the leading tilde
      "~Jane_Doe", // missing the disambiguating digit
      "https://openreview.net/profile?id=~Jane_Doe1", // the URL, not the id
      42,
    ]) {
      expect(service.updateOwnProfile("or", { openreview_id: bad })).toMatchObject({
        ok: false,
        status: 400,
      });
    }
  });

  it("validates each social link against its own platform's URL shape", () => {
    const service = new AdminBotService();
    unwrap(service.upsertLabMember({ id: "social", name: "Social", privilege_level: "member" }));

    const saved = unwrap(
      service.updateOwnProfile("social", {
        github_url: "https://github.com/octocat",
        twitter_url: "https://x.com/octocat",
        linkedin_url: "https://www.linkedin.com/in/octocat",
        scholar_url: "https://scholar.google.com/citations?user=abc123",
        cv_url: "https://example.com/jane-doe-cv.pdf",
        intake_form_url: "https://docs.google.com/forms/d/e/1FAIpQLSc/viewform?edit2=2_ABaOnud",
      }),
    );
    expect(saved.github_url).toBe("https://github.com/octocat");
    expect(saved.twitter_url).toBe("https://x.com/octocat");
    expect(saved.linkedin_url).toBe("https://www.linkedin.com/in/octocat");
    expect(saved.scholar_url).toBe("https://scholar.google.com/citations?user=abc123");
    expect(saved.cv_url).toBe("https://example.com/jane-doe-cv.pdf");
    expect(saved.intake_form_url).toContain("docs.google.com/forms/");

    // Empty clears each link.
    expect(unwrap(service.updateOwnProfile("social", { github_url: "" })).github_url).toBe("");

    for (const bad of [
      { github_url: "https://gitlab.com/octocat" }, // wrong platform for the field
      { github_url: "https://github.com/" }, // no username
      { twitter_url: "https://github.com/octocat" }, // GitHub link in the Twitter field
      { linkedin_url: "https://linkedin.com/company/openai" }, // company page, not a personal profile
      { scholar_url: "https://scholar.google.com/citations" }, // missing ?user=
      { scholar_url: "http://scholar.google.com/citations?user=abc123" }, // not https
      { cv_url: "not a url" },
      // Only the member's own Forms response link belongs here; a stray link filed under it would
      // read on the profile as "these are their intake answers" when it is nothing of the sort.
      { intake_form_url: "https://example.com/my-answers" },
      { intake_form_url: "https://docs.google.com/document/d/abc/edit" },
    ]) {
      expect(service.updateOwnProfile("social", bad)).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("requires a @cs.toronto.edu email for core members, but exempts external collaborators", () => {
    const service = new AdminBotService();

    const student = unwrap(
      service.upsertLabMember({
        id: "student",
        name: "Student",
        privilege_level: "member",
        email: "student@cs.toronto.edu",
      }),
    );
    expect(student.email).toBe("student@cs.toronto.edu");

    expect(
      service.upsertLabMember({
        id: "wrong-domain",
        name: "Wrong Domain",
        privilege_level: "member",
        email: "wrong-domain@gmail.com",
      }),
    ).toMatchObject({ ok: false, status: 400 });

    // The whole point of external_collaborator is people outside the department directory.
    const collaborator = unwrap(
      service.upsertLabMember({
        id: "collab",
        name: "Collaborator",
        privilege_level: "external_collaborator",
        email: "collab@otheruni.edu",
      }),
    );
    expect(collaborator.email).toBe("collab@otheruni.edu");
  });

  it("re-saving an unrelated field does not re-trigger email validation", () => {
    const service = new AdminBotService();
    unwrap(
      service.upsertLabMember({
        id: "resave",
        name: "Resave",
        privilege_level: "member",
        email: "resave@cs.toronto.edu",
      }),
    );

    // Sending the same email back alongside an unrelated change must not fail just because
    // upsertLabMember re-validates the whole merged record on every call.
    const saved = unwrap(service.updateOwnProfile("resave", { location: "Toronto" }));
    expect(saved.location).toBe("Toronto");
    expect(saved.email).toBe("resave@cs.toronto.edu");
  });

  it("saves a calendar email in any domain, since Google Calendar is rarely the university address", () => {
    const service = new AdminBotService();
    unwrap(
      service.upsertLabMember({
        id: "cal",
        name: "Cal",
        privilege_level: "member",
        email: "cal@cs.toronto.edu",
      }),
    );

    const saved = unwrap(
      service.updateOwnProfile("cal", { calendar_email: "cal.personal@gmail.com" }),
    );
    expect(saved.calendar_email).toBe("cal.personal@gmail.com");

    expect(service.updateOwnProfile("cal", { calendar_email: "not an email" })).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("moves availability_updated_at only when the schedule content actually changes", () => {
    // The stamp is an ISO string, so consecutive saves in the same millisecond are
    // indistinguishable; the clock has to advance for "did it move" to mean anything.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
      const service = new AdminBotService();
      unwrap(service.upsertLabMember({ id: "stamp", name: "Stamp", privilege_level: "member" }));

      const first = unwrap(
        service.updateOwnProfile("stamp", {
          availability: [{ start: "2026-08-03", end: "2026-08-09", hours_per_week: 10 }],
        }),
      );
      expect(first.availability_updated_at).toBe("2026-08-01T00:00:00.000Z");

      // An unrelated profile save must not reset the staleness badge, or a member who stopped
      // updating their hours would look current.
      vi.setSystemTime(new Date("2026-08-02T00:00:00Z"));
      const unrelated = unwrap(service.updateOwnProfile("stamp", { location: "Zurich" }));
      expect(unrelated.availability_updated_at).toBe(first.availability_updated_at);

      // Re-sending an identical schedule is not a change either.
      const resent = unwrap(
        service.updateOwnProfile("stamp", {
          availability: [{ start: "2026-08-03", end: "2026-08-09", hours_per_week: 10 }],
        }),
      );
      expect(resent.availability_updated_at).toBe(first.availability_updated_at);

      vi.setSystemTime(new Date("2026-08-03T00:00:00Z"));
      const changed = unwrap(
        service.updateOwnProfile("stamp", {
          availability: [{ start: "2026-08-03", end: "2026-08-09", hours_per_week: 12 }],
        }),
      );
      expect(changed.availability_updated_at).toBe("2026-08-03T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
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
      // Progress is work-based (11 of 16 estimated days), so it does not move when parallel
      // branches shorten the schedule.
      progress_percent: 69,
      // The critical path, not the sum of every estimate: slides and poster run alongside the
      // arXiv/announcement chain, taking 4 days off the schedule's 16 days of work.
      total_estimated_business_days: 12,
      items: expect.arrayContaining([
        expect.objectContaining({ step: "overleaf_writing", status: "complete" }),
        expect.objectContaining({ step: "social_posts", status: "current" }),
        expect.objectContaining({ step: "slide_making", status: "upcoming" }),
        expect.objectContaining({ step: "poster_making", status: "upcoming" }),
      ]),
    });

    // The flow branches at the submission: slides hang off it rather than off the announcements,
    // so the two chains overlap in time instead of queueing behind one another.
    const byStep = new Map(paper?.timeline?.items.map((item) => [item.step, item]));
    expect(byStep.get("slide_making")?.depends_on).toEqual(["submission"]);
    expect(byStep.get("google_drive_pdf")?.depends_on).toEqual(["submission"]);
    expect(byStep.get("slide_making")?.offset_start_business_day).toBe(
      byStep.get("google_drive_pdf")?.offset_start_business_day,
    );
    expect(byStep.get("brainstorming_docs")?.depends_on).toEqual([]);
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

  // Regression guard for the approval model. Each of these once passed silently while the policy
  // table was ignored: approvalPolicy() dropped its arguments, resolvePolicy() returned a fresh
  // single-admin policy, listPending() rewrote stored requirements, and approve()/execute()
  // compared against hardcoded literals instead of the requirement.
  describe("approval policy enforcement", () => {
    it("carries each action's declared roles and quorum onto the proposal", () => {
      const service = new AdminBotService();
      const publicPost = unwrap(
        service.createProposal({ type: "social_media.post_publicly", summary: "Announce" }),
      );
      const draft = unwrap(
        service.createProposal({ type: "social_media.draft", summary: "Draft post" }),
      );

      expect(publicPost.approval_requirement).toEqual({
        requires_approval: true,
        approver_roles: ["admin"],
        min_approvals: 2,
      });
      expect(publicPost.status).toBe("pending");
      expect(draft.approval_requirement.requires_approval).toBe(false);
      expect(draft.status).toBe("approved");
    });

    it("does not let one person satisfy a two-person quorum", async () => {
      const service = new AdminBotService();
      const proposal = unwrap(
        service.createProposal({ type: "paper_publish.submit", summary: "Submit to NeurIPS" }),
      );
      expect(proposal.approval_requirement.min_approvals).toBe(2);

      // Same member, different role label and note: still one approver.
      unwrap(
        service.approve(proposal.id, {
          payload_hash: proposal.payload_hash,
          approver_role: "admin",
          approver_id: "andrew",
          note: "first",
        }),
      );
      unwrap(
        service.approve(proposal.id, {
          payload_hash: proposal.payload_hash,
          approver_role: "admin",
          approver_id: "andrew",
          note: "second",
        }),
      );

      expect(service.getProposal(proposal.id)?.status).toBe("pending");
      expect(await service.execute(proposal.id, { dry_run: true })).toMatchObject({
        ok: false,
        status: 409,
      });

      unwrap(
        service.approve(proposal.id, {
          payload_hash: proposal.payload_hash,
          approver_role: "admin",
          approver_id: "zhijing",
        }),
      );
      expect(service.getProposal(proposal.id)?.status).toBe("approved");
      expect(await service.execute(proposal.id, { dry_run: true })).toMatchObject({ ok: true });
    });

    it("rejects an approver whose role is outside the action's allowed roles", () => {
      const service = new AdminBotService();
      const proposal = unwrap(
        service.createProposal({ type: "paper_publish.submit", summary: "Submit to NeurIPS" }),
      );

      // Every approval-gated action is admin-only, so a plain member is always outside the set.
      expect(proposal.approval_requirement.approver_roles).toEqual(["admin"]);
      expect(
        service.approve(proposal.id, {
          payload_hash: proposal.payload_hash,
          approver_role: "member",
          approver_id: "manager-1",
        }),
      ).toMatchObject({ ok: false, status: 403 });
    });

    it("leaves stored approval requirements untouched when listing pending proposals", () => {
      const service = new AdminBotService();
      const proposal = unwrap(
        service.createProposal({ type: "reimbursement.submit", summary: "Submit expenses" }),
      );

      unwrap(service.listPending());
      unwrap(service.listPending());

      expect(service.getProposal(proposal.id)?.approval_requirement).toEqual({
        requires_approval: true,
        approver_roles: ["admin"],
        min_approvals: 2,
      });
    });
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

  // Onboarding was generated once at first upsert and never updated by any code path, so every
  // checklist stayed permanently unfinished and could not drive a reminder.
  describe("onboarding step tracking", () => {
    function seed(service: AdminBotService, id: string, extra: Record<string, unknown> = {}) {
      return unwrap(service.upsertLabMember({ id, name: id, slack_user_id: `U-${id}`, ...extra }));
    }

    it("starts every member with the LinkedIn step outstanding", () => {
      const service = new AdminBotService();
      const member = seed(service, "sam");
      expect(member.onboarding?.steps.find((step) => step.id === "linkedin")?.status).not.toBe(
        "complete",
      );
    });

    it("marks a step complete and promotes the next required one", () => {
      const service = new AdminBotService();
      seed(service, "sam");
      const updated = unwrap(service.setOnboardingStep("sam", "linkedin", true, "sam"));

      const steps = updated.onboarding?.steps ?? [];
      expect(steps.find((step) => step.id === "linkedin")?.status).toBe("complete");
      expect(updated.onboarding?.completed.map((step) => step.id)).toContain("linkedin");
      expect(updated.onboarding?.remaining.map((step) => step.id)).not.toContain("linkedin");
      // `current` is positional — the first required step still outstanding.
      expect(updated.onboarding?.current_step?.id).toBe("profile_photo");
    });

    it("can un-complete a step, pulling current back to it", () => {
      const service = new AdminBotService();
      seed(service, "sam");
      unwrap(service.setOnboardingStep("sam", "profile_photo", true, "sam"));
      const reverted = unwrap(service.setOnboardingStep("sam", "profile_photo", false, "admin"));
      expect(reverted.onboarding?.current_step?.id).toBe("profile_photo");
    });

    it("rejects an unknown step and an unknown member", () => {
      const service = new AdminBotService();
      seed(service, "sam");
      expect(service.setOnboardingStep("sam", "myspace", true, "sam")).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(service.setOnboardingStep("ghost", "linkedin", true, "admin")).toMatchObject({
        ok: false,
        status: 404,
      });
    });

    it("does not reset a member's progress when their profile is edited", () => {
      const service = new AdminBotService();
      seed(service, "sam");
      unwrap(service.setOnboardingStep("sam", "linkedin", true, "sam"));
      const edited = unwrap(service.upsertLabMember({ id: "sam", name: "Sam Student" }));
      expect(edited.onboarding?.steps.find((step) => step.id === "linkedin")?.status).toBe(
        "complete",
      );
    });

    it("lists only current members who still owe the step", () => {
      const service = new AdminBotService();
      seed(service, "sam");
      seed(service, "joined");
      seed(service, "gone", { status: "alumni" });
      seed(service, "outsider", { status: "external" });
      unwrap(service.setOnboardingStep("joined", "linkedin", true, "joined"));

      const pending = unwrap(service.listOnboardingStepPending("linkedin"));
      expect(pending.members.map((member) => member.id)).toEqual(["sam"]);
      expect(service.listOnboardingStepPending("myspace")).toMatchObject({
        ok: false,
        status: 400,
      });
    });

    it("carries the composed nudge message so external tooling reuses the exact wording", () => {
      const service = new AdminBotService();
      const pending = unwrap(service.listOnboardingStepPending("linkedin"));
      // Bullets are {text, points} objects; interpolating the object itself printed
      // "[object Object]" into real DMs.
      expect(pending.message).not.toContain("[object Object]");
      expect(pending.message).toContain("Connect on LinkedIn");
      // The reaction line is what scripts/adminbot_onboarding_confirm.py acts on.
      expect(pending.message).toContain("React to this message with ✅");
    });
  });

  describe("onboarding step nudge", () => {
    it("nudges each outstanding member once, with the step's own links", async () => {
      const executor = { execute: vi.fn(async () => ({ handled: true })) };
      const service = new AdminBotService(undefined, { executor });
      unwrap(service.upsertLabMember({ id: "sam", name: "Sam", slack_user_id: "U1" }));
      unwrap(service.upsertLabMember({ id: "kai", name: "Kai", slack_user_id: "U2" }));
      unwrap(service.upsertLabMember({ id: "done", name: "Done", slack_user_id: "U3" }));
      unwrap(service.setOnboardingStep("done", "linkedin", true, "done"));

      const result = unwrap(
        await service.nudgeOnboardingStep({ step_id: "linkedin", channel: "slack" }, "admin-1"),
      );

      expect(result.created).toHaveLength(2);
      expect(result.created.every((proposal) => proposal.type === "member_nudge.send")).toBe(true);
      // The message is derived from the checklist definition, so it cannot drift from the
      // welcome screen's wording or links.
      const payload = JSON.stringify(result.created[0]?.proposed_payload);
      expect(payload).toContain("https://www.linkedin.com/company/jinesis-lab/");
      expect(payload).toContain("Connect on LinkedIn");
    });

    it("sends nothing when everyone has already done the step", async () => {
      const executor = { execute: vi.fn(async () => ({ handled: true })) };
      const service = new AdminBotService(undefined, { executor });
      unwrap(service.upsertLabMember({ id: "sam", name: "Sam", slack_user_id: "U1" }));
      unwrap(service.setOnboardingStep("sam", "linkedin", true, "sam"));

      expect(
        unwrap(await service.nudgeOnboardingStep({ step_id: "linkedin", channel: "slack" }, "a")),
      ).toEqual({ created: [], skipped: [] });
    });

    it("skips members with no route on the chosen channel instead of failing the batch", async () => {
      const executor = { execute: vi.fn(async () => ({ handled: true })) };
      const service = new AdminBotService(undefined, { executor });
      unwrap(service.upsertLabMember({ id: "sam", name: "Sam", slack_user_id: "U1" }));
      unwrap(service.upsertLabMember({ id: "noslack", name: "No Slack" }));

      const result = unwrap(
        await service.nudgeOnboardingStep({ step_id: "linkedin", channel: "slack" }, "admin-1"),
      );
      expect(result.created).toHaveLength(1);
      expect(result.skipped.map((skip) => skip.member_id)).toEqual(["noslack"]);
    });

    it("carries a subject on the email channel and honours an override message", async () => {
      const executor = { execute: vi.fn(async () => ({ handled: true })) };
      const service = new AdminBotService(undefined, { executor });
      unwrap(service.upsertLabMember({ id: "sam", name: "Sam", email: "sam@example.com" }));

      const result = unwrap(
        await service.nudgeOnboardingStep(
          { step_id: "linkedin", channel: "email", message: "Please join the org." },
          "admin-1",
        ),
      );
      const payload = JSON.stringify(result.created[0]?.proposed_payload);
      expect(payload).toContain("Please join the org.");
      expect(payload).toContain("Reminder: Connect on LinkedIn");
    });
  });

  describe("migrateMemberNotesToFields", () => {
    it("moves a notes line into the field that owns it, and keeps the rest of the prose", () => {
      const service = new AdminBotService();
      unwrap(
        service.upsertLabMember({
          id: "m1",
          name: "Ada",
          notes: "Joined month: 2026-03\nWhatsApp: +1 555 0100\nPrefers async check-ins.",
        }),
      );

      const result = unwrap(service.migrateMemberNotesToFields("admin"));
      expect(result.fieldsFilled).toBe(2);
      expect(result.membersUpdated).toBe(1);

      const member = unwrap(service.listLabMembers()).members[0]!;
      expect(member.joined_month).toBe("2026-03");
      expect(member.whatsapp).toBe("+1 555 0100");
      // Unrecognised prose is not a schema field and must survive untouched.
      expect(member.notes).toBe("Prefers async check-ins.");
    });

    it("never overwrites a field that already holds a value", () => {
      const service = new AdminBotService();
      unwrap(
        service.upsertLabMember({
          id: "m1",
          name: "Ada",
          location: "Toronto",
          notes: "Location: Somewhere stale",
        }),
      );

      const result = unwrap(service.migrateMemberNotesToFields("admin"));

      // The stored field wins; the line was a duplicate of a fact already held properly.
      expect(unwrap(service.listLabMembers()).members[0]?.location).toBe("Toronto");
      expect(result.fieldsFilled).toBe(0);
      // It is still removed, because leaving it keeps the two-sources-of-truth problem alive.
      expect(unwrap(service.listLabMembers()).members[0]?.notes).toBeUndefined();
    });

    it("splits research interests into the list the roster stores", () => {
      const service = new AdminBotService();
      unwrap(
        service.upsertLabMember({
          id: "m1",
          name: "Ada",
          notes: "Research interests: reasoning, alignment",
        }),
      );

      unwrap(service.migrateMemberNotesToFields("admin"));

      expect(unwrap(service.listLabMembers()).members[0]?.research_topics).toEqual([
        "reasoning",
        "alignment",
      ]);
    });

    it("is a no-op on a second run", () => {
      const service = new AdminBotService();
      unwrap(service.upsertLabMember({ id: "m1", name: "Ada", notes: "Joined month: 2026-03" }));

      unwrap(service.migrateMemberNotesToFields("admin"));
      const second = unwrap(service.migrateMemberNotesToFields("admin"));

      // A partial run must be safe to repeat, so re-running changes nothing.
      expect(second.membersUpdated).toBe(0);
      expect(second.fieldsFilled).toBe(0);
      expect(unwrap(service.listLabMembers()).members[0]?.joined_month).toBe("2026-03");
    });

    it("leaves a member with only free-text notes completely alone", () => {
      const service = new AdminBotService();
      unwrap(service.upsertLabMember({ id: "m1", name: "Ada", notes: "Just a note." }));

      const result = unwrap(service.migrateMemberNotesToFields("admin"));

      expect(result.membersUpdated).toBe(0);
      expect(unwrap(service.listLabMembers()).members[0]?.notes).toBe("Just a note.");
    });
  });

  // upsertLabMember merges its input over the stored record, so callers legitimately send only the
  // fields they are changing. Validating the raw patch instead of the merge meant a partial update
  // read as "a member with no name" -- and because the HTTP layer casts the JSON body straight to
  // the input type, the missing name reached validateLabMember as undefined and threw a TypeError
  // out of the route as a 500. That is the whole "add a commitment button does nothing" bug: the
  // Control UI's schedule editor sends availability/time_off/milestones and never a name, and an
  // admin session routes those through this method rather than through updateOwnProfile.
  describe("partial updates", () => {
    function seeded() {
      const service = new AdminBotService();
      unwrap(
        service.upsertLabMember({
          id: "ada",
          name: "Ada Lovelace",
          privilege_level: "admin",
          location: "Toronto",
        }),
      );
      return service;
    }

    it("accepts a schedule patch that carries no name, keeping the stored one", () => {
      const service = seeded();
      const saved = unwrap(
        service.upsertLabMember({
          id: "ada",
          availability: [
            { start: "2026-04-01", end: "2026-04-30", hours_per_week: 10, project: "Writing" },
          ],
        } as never),
      );
      expect(saved.name).toBe("Ada Lovelace");
      expect(saved.location).toBe("Toronto");
      expect(saved.availability).toHaveLength(1);
    });

    it("accepts a time-off patch that carries no name", () => {
      const service = seeded();
      const saved = unwrap(
        service.upsertLabMember({
          id: "ada",
          time_off: [
            { start: "2026-12-24", end: "2027-01-02", kind: "vacation", availability: "none" },
          ],
        } as never),
      );
      expect(saved.name).toBe("Ada Lovelace");
      expect(saved.time_off).toHaveLength(1);
    });

    // A genuinely nameless *new* member is still refused -- but as a 400 the caller can read,
    // never as a thrown TypeError.
    it("refuses a new member with no name, without throwing", () => {
      const service = new AdminBotService();
      const result = service.upsertLabMember({ id: "ghost", availability: [] } as never);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.error.message).toBe("member name is required");
      }
    });

    it("still refuses a patch that blanks the name outright", () => {
      const service = seeded();
      const result = service.upsertLabMember({ id: "ada", name: "   " } as never);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("member name is required");
      }
    });
  });

  describe("mandatory profile fields", () => {
    it("lists current members missing a required field, and skips alumni/external", () => {
      const service = new AdminBotService();
      unwrap(
        service.upsertLabMember({
          id: "blank",
          name: "Blank",
          privilege_level: "member",
          // Nothing else set -- every mandatory field is missing.
        }),
      );
      unwrap(
        service.upsertLabMember({
          id: "full",
          name: "Full",
          privilege_level: "member",
          calendar_email: "full@gmail.com",
          location: "Toronto",
          slack_user_id: "U9",
          research_topics: ["nlp"],
          correspondence_email: "full@cs.toronto.edu",
          whatsapp: "(+1) 555 0100",
          joined_month: "2026-03",
          github_url: "https://github.com/full",
          linkedin_url: "https://www.linkedin.com/in/full",
          linkedin_urn: "ACoAAB1234567",
          cv_url: "https://example.com/cv.pdf",
          openreview_id: "~Full_Member1",
        }),
      );
      unwrap(service.upsertLabMember({ id: "gone", name: "Gone", status: "alumni" }));

      const result = unwrap(service.listMembersWithIncompleteMandatoryFields());
      expect(result.members.map((member) => member.id)).toEqual(["blank"]);
      expect(result.members[0]?.missing_fields).toEqual(
        expect.arrayContaining([
          "calendar_email",
          "location",
          "slack_user_id",
          "research_topics",
          "correspondence_email",
          "whatsapp",
          "joined_month",
          "github_url",
          "linkedin_url",
          "linkedin_urn",
          "cv_url",
          "openreview_id",
        ]),
      );
    });

    // The reminder and the profile page's required marks are one list now. Chasing a field the
    // page calls optional is the bug this pins shut; `name` is the sole documented exception,
    // because validateLabMember refuses a nameless member outright.
    it("chases exactly the fields the profile page marks required, less name", () => {
      const service = new AdminBotService();
      unwrap(service.upsertLabMember({ id: "blank", name: "Blank", privilege_level: "member" }));
      const missing = unwrap(service.listMembersWithIncompleteMandatoryFields()).members[0]
        ?.missing_fields;
      expect(missing).toEqual(
        adminBotMandatoryProfileFields.filter((field) => field !== "name"),
      );
    });

    it("sends one Slack reminder per member with an incomplete profile", async () => {
      const executor = { execute: vi.fn(async () => ({ handled: true })) };
      const service = new AdminBotService(undefined, { executor });
      unwrap(
        service.upsertLabMember({
          id: "blank1",
          name: "Blank One",
          slack_user_id: "U1",
        }),
      );
      unwrap(
        service.upsertLabMember({
          id: "blank2",
          name: "Blank Two",
          slack_user_id: "U2",
        }),
      );
      unwrap(
        service.upsertLabMember({
          id: "full",
          name: "Full",
          calendar_email: "full@gmail.com",
          location: "Toronto",
          slack_user_id: "U3",
          research_topics: ["nlp"],
          correspondence_email: "full@cs.toronto.edu",
          whatsapp: "(+1) 555 0100",
          joined_month: "2026-03",
          github_url: "https://github.com/full",
          linkedin_url: "https://www.linkedin.com/in/full",
          linkedin_urn: "ACoAAB1234567",
          cv_url: "https://example.com/cv.pdf",
          openreview_id: "~Full_Member1",
        }),
      );

      const result = unwrap(await service.sendMandatoryFieldsReminders("cron"));
      expect(result.created.map((proposal) => proposal.type)).toEqual([
        "member_nudge.send",
        "member_nudge.send",
      ]);
      const recipients = result.created.map(
        (proposal) => (proposal.target as { recipientMemberId?: string })?.recipientMemberId,
      );
      expect(recipients.sort()).toEqual(["blank1", "blank2"]);
    });

    it("leaves a member alone for three days after reminding them", async () => {
      const executor = { execute: vi.fn(async () => ({ handled: true })) };
      const service = new AdminBotService(undefined, { executor });
      unwrap(service.upsertLabMember({ id: "blank1", name: "Blank One", slack_user_id: "U1" }));

      const first = unwrap(await service.sendMandatoryFieldsReminders("cron"));
      expect(first.created).toHaveLength(1);

      // The cron script may run daily; the cadence is the product's, not the schedule's, so a
      // second pass inside the window sends nothing rather than nagging.
      const second = unwrap(await service.sendMandatoryFieldsReminders("cron"));
      expect(second.created).toHaveLength(0);
    });

    it("reminds again once the window has passed", async () => {
      const executor = { execute: vi.fn(async () => ({ handled: true })) };
      const service = new AdminBotService(undefined, { executor });
      unwrap(service.upsertLabMember({ id: "blank1", name: "Blank One", slack_user_id: "U1" }));

      unwrap(await service.sendMandatoryFieldsReminders("cron"));
      // Four days on, the same still-incomplete profile is fair game again.
      vi.setSystemTime(new Date(Date.now() + 4 * 24 * 60 * 60 * 1000));
      try {
        const later = unwrap(await service.sendMandatoryFieldsReminders("cron"));
        expect(later.created).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("sends nothing when every member's required fields are filled in", async () => {
      const executor = { execute: vi.fn(async () => ({ handled: true })) };
      const service = new AdminBotService(undefined, { executor });
      unwrap(
        service.upsertLabMember({
          id: "full",
          name: "Full",
          calendar_email: "full@gmail.com",
          location: "Toronto",
          slack_user_id: "U1",
          research_topics: ["nlp"],
          correspondence_email: "full@cs.toronto.edu",
          whatsapp: "(+1) 555 0100",
          joined_month: "2026-03",
          github_url: "https://github.com/full",
          linkedin_url: "https://www.linkedin.com/in/full",
          linkedin_urn: "ACoAAB1234567",
          cv_url: "https://example.com/cv.pdf",
          openreview_id: "~Full_Member1",
        }),
      );

      expect(unwrap(await service.sendMandatoryFieldsReminders("cron"))).toEqual({
        created: [],
        skipped: [],
      });
    });
  });

  describe("refreshMemberDirectoryFromSlack", () => {
    it("backfills slack_user_id by email match and leaves an already-linked member alone", async () => {
      const service = new AdminBotService();
      unwrap(
        service.upsertLabMember({
          id: "unlinked",
          name: "Unlinked",
          email: "unlinked@cs.toronto.edu",
        }),
      );
      unwrap(
        service.upsertLabMember({
          id: "already-linked",
          name: "Already Linked",
          email: "already@cs.toronto.edu",
          slack_user_id: "U-EXISTING",
        }),
      );
      const resolveSlackUserIdsByEmail = vi.fn(async (emails: string[]) => {
        expect(emails).toEqual(["unlinked@cs.toronto.edu"]);
        return new Map([["unlinked@cs.toronto.edu", "U-NEW"]]);
      });

      const result = unwrap(
        await service.refreshMemberDirectoryFromSlack(
          { resolveSlackUserIdsByEmail },
          "admin-actor",
        ),
      );

      expect(result.idsResolved).toBe(1);
      const members = unwrap(service.listLabMembers()).members;
      expect(members.find((m) => m.id === "unlinked")?.slack_user_id).toBe("U-NEW");
      expect(members.find((m) => m.id === "already-linked")?.slack_user_id).toBe("U-EXISTING");
      expect(service.listAuditEvents().map((event) => event.type)).toContain(
        "member_directory.slack_synced",
      );
    });

    it("leaves a stored timezone alone when the Slack lookup never answered", async () => {
      const service = new AdminBotService();
      unwrap(
        service.upsertLabMember({
          id: "m1",
          name: "Ada",
          slack_user_id: "U1",
          timezone: "America/Toronto",
        }),
      );

      // An empty map is what a failed transport produces. Read as an answer it wipes the roster;
      // timezone is mandatory, so that quietly makes every profile incomplete.
      const result = unwrap(
        await service.refreshMemberDirectoryFromSlack(
          { fetchSlackTimezones: async () => new Map<string, string | null>() },
          "cron",
        ),
      );

      expect(result.timezonesChecked).toBe(0);
      expect(result.timezonesUpdated).toBe(0);
      expect(unwrap(service.listLabMembers()).members[0]?.timezone).toBe("America/Toronto");
    });

    it("syncs timezone from Slack and clears it when Slack has nothing", async () => {
      const service = new AdminBotService();
      unwrap(
        service.upsertLabMember({
          id: "stale-tz",
          name: "Stale Timezone",
          email: "stale@cs.toronto.edu",
          slack_user_id: "U1",
          timezone: "America/Chicago",
        }),
      );
      unwrap(
        service.upsertLabMember({
          id: "no-slack-tz",
          name: "No Slack Timezone",
          email: "noslacktz@cs.toronto.edu",
          slack_user_id: "U2",
          timezone: "America/Denver",
        }),
      );
      const fetchSlackTimezones = vi.fn(async (ids: string[]) => {
        expect(ids.sort()).toEqual(["U1", "U2"]);
        // U1 has a zone; U2 was asked and Slack had none, which is null rather than absent.
        return new Map<string, string | null>([
          ["U1", "America/Toronto"],
          ["U2", null],
        ]);
      });

      const result = unwrap(
        await service.refreshMemberDirectoryFromSlack({ fetchSlackTimezones }, "admin-actor"),
      );

      expect(result.timezonesChecked).toBe(2);
      expect(result.timezonesUpdated).toBe(2);
      const members = unwrap(service.listLabMembers()).members;
      expect(members.find((m) => m.id === "stale-tz")?.timezone).toBe("America/Toronto");
      expect(members.find((m) => m.id === "no-slack-tz")?.timezone).toBeUndefined();
    });

    it("leaves timezone untouched for a member with no slack_user_id", async () => {
      const service = new AdminBotService();
      unwrap(
        service.upsertLabMember({
          id: "no-slack",
          name: "No Slack",
          email: "noslack@cs.toronto.edu",
          timezone: "America/Toronto",
        }),
      );
      const fetchSlackTimezones = vi.fn(async () => new Map<string, string>());

      const result = unwrap(
        await service.refreshMemberDirectoryFromSlack({ fetchSlackTimezones }, "admin-actor"),
      );

      expect(result.timezonesChecked).toBe(0);
      expect(fetchSlackTimezones).toHaveBeenCalledWith([]);
      expect(unwrap(service.listLabMembers()).members[0]?.timezone).toBe("America/Toronto");
    });
  });
});
