import { describe, expect, it, vi } from "vitest";
import { adminBotActionTypes } from "../contracts/actions.js";
import type { SlackDirectoryUser } from "../workflows/members/slack-roster-sync.js";
import { AdminBotMemoryStore, AdminBotService } from "./service.js";

// Synthetic lab and workspace only; the Slack read is a stub, so nothing reaches Slack.
const ACTOR = "system:slack-roster-sync";

function slack(id: string, extra: Partial<SlackDirectoryUser> = {}): SlackDirectoryUser {
  return {
    id,
    deleted: false,
    is_bot: false,
    is_app_user: false,
    is_restricted: false,
    is_ultra_restricted: false,
    real_name: `Person ${id}`,
    email: `${id.toLowerCase()}@lab.test`,
    tz: "America/Toronto",
    image: `https://avatars.test/${id}.png`,
    ...extra,
  };
}

function lab() {
  const store = new AdminBotMemoryStore();
  const execute = vi.fn(async () => ({ handled: true }));
  const service = new AdminBotService(store, { executor: { execute } });
  const seed = (
    member: Parameters<typeof service.upsertLabMember>[0],
    origin?: Parameters<typeof service.upsertLabMember>[1],
  ) => {
    const result = service.upsertLabMember(member, origin);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  };
  seed({ id: "admin-1", name: "Admin One", email: "admin-1@lab.test", privilege_level: "admin" });
  seed({ id: "linked", name: "Linked Member", email: "linked@lab.test", slack_user_id: "ULINK" });
  seed({ id: "by-email", name: "Email Member", email: "uemail@lab.test" });
  seed({ id: "leaver", name: "Leaving Member", email: "leaver@lab.test", slack_user_id: "ULEFT" });
  seed({ id: "test-row", name: "Test User", email: "test-row@example.com", slack_user_id: "UTEST" });
  // A real member who renamed themselves to opt out: the name is their own edit.
  seed({
    id: "mem_synthetic_dnc",
    name: "Synthetic Export Name",
    email: "dnc@lab.test",
    slack_user_id: "UDNC",
    privilege_level: "external_collaborator",
    receives_nudges: false,
  });
  seed(
    { id: "mem_synthetic_dnc", name: "Null,do not contact" },
    { source: "member", actor: "mem_synthetic_dnc" },
  );
  seed(
    { id: "linked", name: "Linked Member", avatar_url: "https://avatars.test/self-chosen.png" },
    { source: "member", actor: "linked" },
  );
  const users = [
    slack("ULINK"),
    slack("UEMAIL"),
    slack("ULEFT", { deleted: true }),
    slack("UTEST", { real_name: "Test User" }),
    slack("UDNC", { real_name: "Synthetic Export Name" }),
    slack("UNEW", { real_name: "New Person" }),
    slack("UGUEST", { is_ultra_restricted: true }),
    slack("UBOT", { is_bot: true }),
    slack("USLACKBOT"),
  ];
  const read = vi.fn(async () => users);
  const allProposals = () => adminBotActionTypes.flatMap((type) => store.listProposalsByType(type));
  return { store, service, execute, read, users, allProposals };
}

describe("Slack roster sync service", () => {
  it("applies creates, links, flags and proposals; never deletes on its own", async () => {
    const { store, service, read, allProposals } = lab();
    const dncBefore = store.getLabMember("mem_synthetic_dnc");
    const result = await service.syncSlackRoster(read, { actor: ACTOR });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const report = result.payload;
    expect(report.applied).toEqual({ created: 1, updated: 2, deactivated: 1, reactivated: 0 });
    expect(report.failed).toEqual([]);

    const created = store.getLabMember("new-person");
    expect(created).toMatchObject({
      slack_user_id: "UNEW",
      privilege_level: "external_collaborator",
      notes: "Created from the Slack roster sync.",
    });
    expect(created?.field_provenance?.slack_user_id?.source).toBe("import");
    expect(store.getLabMember("by-email")?.slack_user_id).toBe("UEMAIL");
    // A member-chosen avatar survives; the empty timezone beside it is filled.
    expect(store.getLabMember("linked")).toMatchObject({
      avatar_url: "https://avatars.test/self-chosen.png",
      timezone: "America/Toronto",
    });
    // Deactivated is flagged, not removed.
    expect(store.getLabMember("leaver")?.slack_deactivated_at).toBeTruthy();
    // Guests and bots are not imported.
    expect(store.listLabMembers().some((m) => m.slack_user_id === "UGUEST")).toBe(false);

    // The opt-out is reported, untouched, and not proposed.
    expect(report.opted_out).toEqual([
      expect.objectContaining({ member_id: "mem_synthetic_dnc", action: "opted out; admin review" }),
    ]);
    expect(store.getLabMember("mem_synthetic_dnc")).toEqual(dncBefore);

    // The test row is proposed, pending, T3, and still present.
    const removals = store.listProposalsByType("lab_member.remove");
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatchObject({
      status: "pending",
      risk_tier: "T3",
      proposed_payload: { member_id: "test-row", slack_user_id: "UTEST" },
    });
    expect(store.getLabMember("test-row")).toBeTruthy();
    // Nothing else was filed: the sync itself sends nothing to anyone.
    expect(allProposals().map((p) => p.type)).toEqual(["lab_member.remove"]);

    const audit = store.listAuditEvents().filter((e) => e.type === "slack_roster_sync.completed");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor).toBe(ACTOR);
  });

  it("is idempotent: a second run with the same Slack data changes nothing and files nothing", async () => {
    const { store, service, read, allProposals } = lab();
    await service.syncSlackRoster(read, { actor: ACTOR });
    const membersAfterFirst = JSON.stringify(store.listLabMembers());
    const proposalsAfterFirst = allProposals().length;
    const second = await service.syncSlackRoster(read, { actor: ACTOR });
    if (!second.ok) {
      throw new Error(second.error.message);
    }
    expect(second.payload).toMatchObject({
      creates: [],
      updates: [],
      deactivations: [],
      reactivations: [],
      applied: { created: 0, updated: 0, deactivated: 0, reactivated: 0 },
    });
    // The pending removal is reported again under its existing id, not filed twice.
    expect(second.payload.proposals).toHaveLength(1);
    expect(allProposals()).toHaveLength(proposalsAfterFirst);
    expect(JSON.stringify(store.listLabMembers())).toBe(membersAfterFirst);
  });

  it("does not re-propose a rejected removal", async () => {
    const { store, service, read } = lab();
    await service.syncSlackRoster(read, { actor: ACTOR });
    const [proposal] = store.listProposalsByType("lab_member.remove");
    store.updateProposal({ ...proposal!, status: "rejected" });
    await service.syncSlackRoster(read, { actor: ACTOR });
    expect(store.listProposalsByType("lab_member.remove")).toHaveLength(1);
  });

  it("deletes the record only after an admin approves, in-service and not via the connector", async () => {
    const { store, service, execute, read } = lab();
    await service.syncSlackRoster(read, { actor: ACTOR });
    const [proposal] = store.listProposalsByType("lab_member.remove");
    // Not approved: execution refuses.
    const early = await service.execute(proposal!.id, { dry_run: false });
    expect(early.ok).toBe(false);
    expect(store.getLabMember("test-row")).toBeTruthy();

    const approved = service.approve(proposal!.id, {
      payload_hash: proposal!.payload_hash,
      approver_role: "admin",
      approver_id: "admin-1",
    });
    expect(approved.ok).toBe(true);
    const executed = await service.execute(proposal!.id, { dry_run: false });
    expect(executed.ok && executed.payload.status).toBe("executed");
    expect(store.getLabMember("test-row")).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    const deleted = store.listAuditEvents().find((e) => e.type === "lab_member.deleted");
    expect(deleted?.actor).toBe("admin-1");
  });

  it("refuses the delete when the record was relinked while the approval sat", async () => {
    const { store, service, read } = lab();
    await service.syncSlackRoster(read, { actor: ACTOR });
    const [proposal] = store.listProposalsByType("lab_member.remove");
    service.upsertLabMember({ id: "test-row", name: "Test User", slack_user_id: "UREAL" });
    service.approve(proposal!.id, {
      payload_hash: proposal!.payload_hash,
      approver_role: "admin",
      approver_id: "admin-1",
    });
    const executed = await service.execute(proposal!.id, { dry_run: false });
    expect(executed.ok).toBe(false);
    expect(store.getLabMember("test-row")).toBeTruthy();
  });

  it("dry run plans without writing", async () => {
    const { store, service, read } = lab();
    const before = JSON.stringify(store.listLabMembers());
    const result = await service.syncSlackRoster(read, { actor: ACTOR, dryRun: true });
    expect(result.ok && result.payload.creates).toHaveLength(1);
    expect(JSON.stringify(store.listLabMembers())).toBe(before);
    expect(store.listProposalsByType("lab_member.remove")).toEqual([]);
  });

  it("refuses an empty Slack read and an oversized pass", async () => {
    const { service, store } = lab();
    const empty = await service.syncSlackRoster(async () => [], { actor: ACTOR });
    expect(empty).toMatchObject({ ok: false, status: 422 });
    // 30 new accounts plus the one test-row removal against a roster of six.
    const flood = Array.from({ length: 30 }, (_, i) => slack(`UFLOOD${i}`));
    const refused = await service.syncSlackRoster(async () => flood, { actor: ACTOR });
    expect(refused.ok && refused.payload.refused).toMatch(/refusing to apply 31/);
    expect(store.listLabMembers().some((m) => m.slack_user_id === "UFLOOD0")).toBe(false);
  });

  it("shares one pass between overlapping runs", async () => {
    const { service, read } = lab();
    const [a, b] = [
      service.syncSlackRoster(read, { actor: ACTOR }),
      service.syncSlackRoster(read, { actor: ACTOR }),
    ];
    expect(a).toBe(b);
    await a;
    expect(read).toHaveBeenCalledTimes(1);
  });
});
