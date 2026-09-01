import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../contracts/actions.js";
import { createAdminBotSqliteService } from "./sqlite.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-sqlite-"));
  tempDirs.push(dir);
  return path.join(dir, "adminbot.sqlite");
}

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

describe("AdminBotSqliteStore", () => {
  it("keeps a paper's evidence slots across service instances, and drops them with the paper", () => {
    const databasePath = tempDbPath();
    const first = createAdminBotSqliteService({ databasePath });
    unwrap(first.service.upsertLabMember({ id: "ada", name: "Ada", privilege_level: "member" }));
    unwrap(
      first.service.upsertPaper({
        id: "p1",
        title: "Causal abstraction",
        authors: ["Ada"],
        current_step: "overleaf_writing",
        first_author_member_id: "ada",
      }),
    );
    unwrap(
      first.service.setPaperSlot({
        paperId: "p1",
        slot: "project_folder",
        input: { url: "https://docs.google.com/document/d/x" },
        memberId: "ada",
        privileged: true,
      }),
    );
    first.close();

    const second = createAdminBotSqliteService({ databasePath });
    const stored = unwrap(second.service.listPaperSlots("p1")).slots.find(
      (slot) => slot.slot === "project_folder",
    );
    expect(stored).toMatchObject({
      status: "provided",
      url: "https://docs.google.com/document/d/x",
      provided_by_member_id: "ada",
    });
    // Nullable columns come back absent rather than null, so nothing downstream has to treat "no
    // URL" and "URL is null" as two different absences.
    expect(stored?.waived_reason).toBeUndefined();

    // Deleting the paper takes its slots with it: a re-created id must not inherit the evidence of
    // a paper somebody removed.
    unwrap(second.service.deletePaper("p1"));
    unwrap(
      second.service.upsertPaper({
        id: "p1",
        title: "Causal abstraction, again",
        authors: ["Ada"],
        current_step: "brainstorming_docs",
      }),
    );
    expect(
      unwrap(second.service.listPaperSlots("p1")).slots.every((slot) => slot.status === "missing"),
    ).toBe(true);
    second.close();
  });

  it("keeps logistics requests, their files and their status across service instances", () => {
    const databasePath = tempDbPath();
    const first = createAdminBotSqliteService({ databasePath });
    unwrap(
      first.service.upsertLabMember({
        id: "ada",
        name: "Ada",
        privilege_level: "member",
      }),
    );
    unwrap(
      first.service.upsertLabMember({
        id: "grace",
        name: "Grace",
        privilege_level: "member",
      }),
    );
    const submitted = unwrap(
      first.service.submitLogisticsRequest("ada", {
        kind: "document_signature",
        documents: [
          {
            name: "form.pdf",
            size: 0,
            data_base64: Buffer.from("signed").toString("base64"),
          },
        ],
        description: "before the trip",
      }),
    );
    unwrap(
      first.service.submitLogisticsRequest("grace", {
        kind: "book_meeting",
        meetings: [{ purpose: "sync" }],
      }),
    );
    unwrap(first.service.setLogisticsRequestStatus(submitted.id, "in_progress", "zhijing"));
    first.close();

    const second = createAdminBotSqliteService({ databasePath });
    // The member index is the one that has to survive a reopen: "my requests" is the read every
    // member does on every visit, and a lost filter would hand them the whole lab's queue.
    const mine = unwrap(second.service.listLogisticsRequests("ada")).requests;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      id: submitted.id,
      status: "in_progress",
      member_name: "Ada",
    });
    expect(unwrap(second.service.listLogisticsRequests()).requests).toHaveLength(2);
    const opened = unwrap(
      second.service.getLogisticsRequest(submitted.id, {
        member_id: "ada",
        is_admin: false,
      }),
    );
    expect(opened.documents?.[0]?.data_base64).toBe(Buffer.from("signed").toString("base64"));
    second.close();
  });

  it("auto-creates a local sqlite ledger and preserves proposals across service instances", () => {
    const databasePath = tempDbPath();
    const first = createAdminBotSqliteService({
      databasePath,
      executor: { execute: async () => ({ handled: true }) },
    });
    const proposal = unwrap(
      first.service.createProposal({
        type: "email.send",
        summary: "Send accepted candidate email",
      }),
    );
    unwrap(
      first.service.approve(proposal.id, {
        payload_hash: proposal.payload_hash,
        approver_role: "admin",
      }),
    );
    first.close();

    const second = createAdminBotSqliteService({ databasePath });
    expect(second.service.getProposal(proposal.id)).toMatchObject({
      id: proposal.id,
      status: "approved",
      payload_hash: proposal.payload_hash,
    });
    expect(second.service.listAuditEvents().map((event) => event.type)).toEqual([
      "proposal.created",
      "approval.recorded",
    ]);
    second.close();
  });

  it("replays idempotent execution after reopening the sqlite ledger", async () => {
    const databasePath = tempDbPath();
    const first = createAdminBotSqliteService({
      databasePath,
      executor: { execute: async () => ({ handled: true }) },
    });
    const proposal = unwrap(
      first.service.createProposal({
        type: "calendar.create_tentative_hold",
        summary: "Hold interview slot",
      }),
    );
    unwrap(
      first.service.approve(proposal.id, {
        payload_hash: proposal.payload_hash,
        approver_role: "admin",
        approver_id: "andrew",
      }),
    );
    const result = unwrap(
      await first.service.execute(proposal.id, {
        dry_run: false,
        idempotency_key: "hold-slot-1",
      }),
    );
    first.close();

    const second = createAdminBotSqliteService({ databasePath });
    expect(
      unwrap(
        await second.service.execute(proposal.id, {
          dry_run: false,
          idempotency_key: "hold-slot-1",
        }),
      ),
    ).toEqual(result);
    second.close();
  });

  it("claims an idempotency key across concurrent sqlite service instances", async () => {
    const databasePath = tempDbPath();
    let releaseExecutor!: () => void;
    const executorGate = new Promise<void>((resolve) => {
      releaseExecutor = resolve;
    });
    let executorCalls = 0;
    const executor = {
      execute: async () => {
        executorCalls += 1;
        await executorGate;
        return { handled: true };
      },
    };
    const first = createAdminBotSqliteService({ databasePath, executor });
    const firstProposal = unwrap(
      first.service.createProposal({
        type: "calendar.create_tentative_hold",
        summary: "Hold first interview slot",
      }),
    );
    const secondProposal = unwrap(
      first.service.createProposal({
        type: "calendar.create_tentative_hold",
        summary: "Hold second interview slot",
      }),
    );
    for (const proposal of [firstProposal, secondProposal]) {
      unwrap(
        first.service.approve(proposal.id, {
          payload_hash: proposal.payload_hash,
          approver_role: "admin",
          approver_id: "andrew",
        }),
      );
    }

    const second = createAdminBotSqliteService({ databasePath, executor });
    const executing = first.service.execute(firstProposal.id, {
      dry_run: false,
      idempotency_key: "shared-hold-key",
    });
    const blocked = await second.service.execute(secondProposal.id, {
      dry_run: false,
      idempotency_key: "shared-hold-key",
    });
    expect(blocked).toMatchObject({
      ok: false,
      status: 409,
      error: { message: expect.stringContaining("already in progress") },
    });
    expect(executorCalls).toBe(1);

    releaseExecutor();
    const result = unwrap(await executing);
    expect(
      unwrap(
        await second.service.execute(secondProposal.id, {
          dry_run: false,
          idempotency_key: "shared-hold-key",
        }),
      ),
    ).toEqual(result);
    expect(executorCalls).toBe(1);
    first.close();
    second.close();
  });

  it("prunes audit events when retention is configured", () => {
    const databasePath = tempDbPath();
    const first = createAdminBotSqliteService({
      databasePath,
      executor: { execute: async () => ({ handled: true }) },
    });
    first.store.recordAudit({
      id: "aud_old",
      type: "proposal.created",
      timestamp: "2000-01-01T00:00:00.000Z",
    });
    first.store.recordAudit({
      id: "aud_new",
      type: "proposal.created",
      timestamp: new Date().toISOString(),
    });
    first.close();

    const second = createAdminBotSqliteService({
      databasePath,
      auditRetentionDays: 30,
    });
    expect(second.service.listAuditEvents().map((event) => event.id)).toEqual(["aud_new"]);
    second.close();
  });

  it("preserves lab members and paper pipeline records across service instances", () => {
    const databasePath = tempDbPath();
    const first = createAdminBotSqliteService({
      databasePath,
      executor: { execute: async () => ({ handled: true }) },
    });
    unwrap(
      first.service.upsertLabMember({
        id: "alice",
        name: "Alice",
        privilege_level: "member",
        slack_user_id: "U123",
        role: "Industry Researcher",
        status: "active",
        research_branch: "Causal AI",
        research_topics: ["causal inference", "reasoning"],
        projects: ["Project Atlas"],
        hours_per_week: 32,
      }),
    );
    unwrap(
      first.service.upsertPaper({
        id: "paper-1",
        title: "Paper One",
        authors: ["alice"],
        current_step: "overleaf_writing",
        artifacts: {
          overleaf_edit_url: "https://overleaf.example/edit",
        },
        reminder: {
          status: "waiting_on_authors",
          next_nudge_at: "2026-06-01T00:00:00.000Z",
        },
      }),
    );
    first.close();

    const second = createAdminBotSqliteService({ databasePath });
    expect(unwrap(second.service.listLabMembers()).members).toEqual([
      expect.objectContaining({
        id: "alice",
        research_branch: "Causal AI",
        research_topics: ["causal inference", "reasoning"],
        projects: ["Project Atlas"],
      }),
    ]);
    expect(unwrap(second.service.listPapers()).papers).toEqual([
      expect.objectContaining({
        id: "paper-1",
        current_step: "overleaf_writing",
        artifacts: { overleaf_edit_url: "https://overleaf.example/edit" },
      }),
    ]);
    expect(unwrap(second.service.deletePaper("paper-1"))).toEqual({
      deleted: true,
      paper_id: "paper-1",
    });
    second.close();

    const third = createAdminBotSqliteService({ databasePath });
    expect(unwrap(third.service.listPapers()).papers).toEqual([]);
    third.close();
  });

  it("preserves an external collaborator's subgroup across service instances", () => {
    const databasePath = tempDbPath();
    const first = createAdminBotSqliteService({ databasePath });
    unwrap(
      first.service.upsertLabMember({
        id: "prof",
        name: "Prof",
        privilege_level: "external_collaborator",
        collaborator_subgroup: "external_prof",
      }),
    );
    first.close();

    const second = createAdminBotSqliteService({ databasePath });
    expect(unwrap(second.service.listLabMembers()).members[0]).toMatchObject({
      id: "prof",
      privilege_level: "external_collaborator",
      collaborator_subgroup: "external_prof",
    });
    // Reopening must not resurrect the subgroup once a promotion cleared it.
    unwrap(
      second.service.upsertLabMember({
        id: "prof",
        name: "Prof",
        privilege_level: "member",
      }),
    );
    second.close();

    const third = createAdminBotSqliteService({ databasePath });
    expect(
      unwrap(third.service.listLabMembers()).members[0]?.collaborator_subgroup,
    ).toBeUndefined();
    third.close();
  });

  it("preserves AdminBot settings across service instances", () => {
    const databasePath = tempDbPath();
    const first = createAdminBotSqliteService({
      databasePath,
      executor: { execute: async () => ({ handled: true }) },
    });
    unwrap(
      first.service.updateSettings({
        paper_escalation_business_days: 4,
        head_professor_member_id: "zhijing",
      }),
    );
    first.close();

    const second = createAdminBotSqliteService({ databasePath });
    expect(unwrap(second.service.getSettings())).toMatchObject({
      paper_escalation_business_days: 4,
      head_professor_member_id: "zhijing",
    });
    second.close();
  });

  it("persists pending Slack channel naming enforcement across restarts", async () => {
    const databasePath = tempDbPath();
    const first = createAdminBotSqliteService({
      databasePath,
      executor: { execute: async () => ({ handled: true }) },
    });
    await first.service.processSlackChannelNamingEvent({
      event_type: "channel_created",
      channel_id: "C123",
      channel_name: "eu-post-training",
      owner_user_id: "U123",
    });
    first.close();

    const second = createAdminBotSqliteService({
      databasePath,
      executor: { execute: async () => ({ handled: true }) },
    });
    const sweep = unwrap(
      await second.service.runSlackChannelNamingSweep("cron", "2099-01-01T00:00:00.000Z"),
    );
    expect(sweep.scanned).toBe(1);
    // The record survived the restart, so the sweep can still act on it -- by filing a rename for
    // an admin to approve, which is all it does now.
    expect(sweep.renames_proposed).toBe(1);
    second.close();
  });

  // Checklists seeded before bullets gained nested points stored them as bare strings, which the
  // Control UI renders as empty bullets. Opening the database rewrites them from the definitions.
  it("rebuilds onboarding checklists stored under an older step shape, keeping acknowledgements", () => {
    const databasePath = tempDbPath();
    const first = createAdminBotSqliteService({ databasePath });
    unwrap(first.service.upsertLabMember({ id: "ada", name: "Ada Lovelace" }));
    const acknowledgedAt = unwrap(
      first.service.acknowledgeOwnOnboardingStep("ada", "calendar_conventions"),
    ).onboarding.steps.find((step) => step.id === "calendar_conventions")?.acknowledged_at;
    expect(acknowledgedAt).toBeTruthy();
    // Rewind the stored copy to the shape members were seeded with before the UI change.
    const stale = first.store.getLabMember("ada");
    first.store.saveLabMember({
      ...stale!,
      onboarding: {
        ...stale!.onboarding!,
        steps: stale!.onboarding!.steps.map((step) => ({
          ...step,
          bullets: ["Mandatory events come with a personal email invite."],
        })),
      } as (typeof stale)["onboarding"] & object,
    });
    first.close();

    const second = createAdminBotSqliteService({ databasePath });
    const step = second.store
      .getLabMember("ada")
      ?.onboarding?.steps.find((entry) => entry.id === "calendar_conventions");
    expect(step?.acknowledged_at).toBe(acknowledgedAt);
    expect(step?.bullets?.every((bullet) => typeof bullet.text === "string")).toBe(true);
    second.close();
  });

  // `core_member` was retired into `member`. Rows seeded before that carry a level the union no
  // longer contains, so opening the database rewrites them; the cast is the only way to write the
  // retired shape now that the type is narrowed.
  it("migrates members stored at the retired core_member level to member", () => {
    const databasePath = tempDbPath();
    const first = createAdminBotSqliteService({ databasePath });
    unwrap(first.service.upsertLabMember({ id: "ada", name: "Ada Lovelace" }));
    // A genuine retired row carries the grants that tier had, which are exactly the grants `member`
    // now holds — so the migration only has to move the level, never recompute access.
    const grants = unwrap(
      first.service.upsertLabMember({
        id: "grace",
        name: "Grace Hopper",
        privilege_level: "member",
      }),
    ).access;
    const seeded = first.store.getLabMember("ada");
    first.store.saveLabMember({
      ...seeded!,
      privilege_level: "core_member",
      access: grants,
    } as unknown as AdminBotLabMember);
    first.close();

    const second = createAdminBotSqliteService({ databasePath });
    const migrated = second.store.getLabMember("ada");
    expect(migrated?.privilege_level).toBe("member");
    // The indexed column drives listing/filtering, so it must not keep the retired value either.
    const listed = unwrap(second.service.listLabMembers()).members.find(
      (member) => member.id === "ada",
    );
    expect(listed?.privilege_level).toBe("member");
    // Lab-wide scopes the retired tier carried survive the move.
    expect(migrated?.access).toContainEqual({
      service: "paper_pipeline",
      access: "edit",
      scope: "paper records",
    });
    second.close();
  });
});
