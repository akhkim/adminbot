import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminBotSqliteService } from "./service-sqlite.js";

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

    const second = createAdminBotSqliteService({ databasePath, auditRetentionDays: 30 });
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
    unwrap(second.service.upsertLabMember({ id: "prof", name: "Prof", privilege_level: "member" }));
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
});
