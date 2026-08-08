import { describe, expect, it, vi } from "vitest";
import type { AdminBotUnitOfWork, MemberRecord, TransactionBoundary } from "@adminbot/ports";
import { MemberRosterService, type MemberActor } from "./member-roster-service.js";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const MEMBER_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_ID = "20000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-08-08T12:00:00.000Z");

describe("MemberRosterService", () => {
  it("requires authenticated member access for roster reads", async () => {
    const { service } = setup();
    await expect(service.list(undefined)).resolves.toMatchObject({ status: 401 });
    await expect(service.list(actor(["auditor"]))).resolves.toMatchObject({ status: 403 });
  });

  it("lets a member update only their own self-service fields", async () => {
    const { service, repository } = setup();
    const result = await service.updateOwnProfile(actor(["member"]), {
      expectedVersion: 1,
      preferredName: "Synth",
      biography: "Synthetic biography",
      researchTopics: ["Systems", "Systems"],
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected roster");
    expect(result.body.members[0]).toMatchObject({ canEditOwnProfile: true });
    expect(repository.updateOwnProfile).toHaveBeenCalledWith(expect.objectContaining({ personId: MEMBER_ID, researchTopics: ["Systems"] }));
    await expect(service.updateOwnProfile(actor(["member"]), {
      expectedVersion: 1, displayName: "Privilege escalation",
    })).resolves.toMatchObject({ status: 400 });
  });

  it("requires a recently authenticated administrator for governance fields", async () => {
    const { service, repository } = setup();
    await expect(service.updateGovernance(actor(["administrator"], "single_factor"), OTHER_ID, {
      expectedProfileVersion: 1, expectedMembershipVersion: 1, tier: "member", reason: "Reviewed",
    })).resolves.toMatchObject({ status: 403, body: { message: "recent reauthentication required" } });
    const result = await service.updateGovernance(actor(["administrator"]), OTHER_ID, {
      expectedProfileVersion: 1, expectedMembershipVersion: 1,
      tier: "member", lifecycle: "active", mentorId: MEMBER_ID, reason: "Reviewed evidence",
    });
    expect(result).toMatchObject({ ok: true });
    expect(repository.updateGovernance).toHaveBeenCalledWith(expect.objectContaining({ personId: OTHER_ID, tier: "member" }));
  });

  it("replaces roles only for another member through a recently authenticated administrator", async () => {
    const { service, repository } = setup();
    const input = { expectedMembershipVersion: 1, roles: ["member", "approver"], reason: "Approved responsibility" };
    await expect(service.replaceRoles(actor(["administrator"], "single_factor"), OTHER_ID, input)).resolves.toMatchObject({ status: 403 });
    await expect(service.replaceRoles(actor(["administrator"]), MEMBER_ID, input)).resolves.toMatchObject({ status: 403, body: { message: "administrators cannot change their own roles" } });
    await expect(service.replaceRoles(actor(["administrator"]), OTHER_ID, input)).resolves.toMatchObject({ ok: true });
    expect(repository.replaceRoles).toHaveBeenCalledWith(expect.objectContaining({
      actorPersonId: MEMBER_ID, personId: OTHER_ID, roles: ["member", "approver"],
    }));
  });

  it("fails closed when live role recheck or last-administrator protection rejects the change", async () => {
    const { service, repository } = setup();
    const input = { expectedMembershipVersion: 1, roles: ["member"], reason: "Synthetic test" };
    repository.replaceRoles.mockResolvedValueOnce("not_authorized" as never);
    await expect(service.replaceRoles(actor(["administrator"]), OTHER_ID, input)).resolves.toMatchObject({ status: 403, body: { message: "administrator role is no longer active" } });
    repository.replaceRoles.mockResolvedValueOnce("last_administrator" as never);
    await expect(service.replaceRoles(actor(["administrator"]), OTHER_ID, input)).resolves.toMatchObject({ status: 409, body: { message: "the last active administrator cannot be removed" } });
  });

  it("replaces only complete valid visibility policies", async () => {
    const { service, repository } = setup();
    await expect(service.replaceVisibility(actor(["administrator"]), OTHER_ID, {
      expectedProfileVersion: 1, fieldVisibility: { biography: "public" }, reason: "Incomplete",
    })).resolves.toMatchObject({ status: 400 });
    const fieldVisibility = { preferredName: "members", institutionalEmail: "administrators", biography: "public", researchTopics: "members", profileImageArtifactId: "self" };
    await expect(service.replaceVisibility(actor(["administrator"]), OTHER_ID, {
      expectedProfileVersion: 1, fieldVisibility, reason: "Approved public biography",
    })).resolves.toMatchObject({ ok: true });
    expect(repository.replaceVisibility).toHaveBeenCalledWith(expect.objectContaining({ personId: OTHER_ID, fieldVisibility }));
  });

  it("never trusts a target identity in the self-edit payload", async () => {
    const { service, repository } = setup();
    await expect(service.updateOwnProfile(actor(["member"]), {
      expectedVersion: 1, personId: OTHER_ID, biography: "forged",
    })).resolves.toMatchObject({ status: 400 });
    expect(repository.updateOwnProfile).not.toHaveBeenCalled();
  });

  it("redacts administrator-only profile fields from ordinary roster projections", async () => {
    const { service } = setup({
      fieldVisibility: { biography: "administrators", institutionalEmail: "administrators", researchTopics: "members", preferredName: "members", profileImageArtifactId: "administrators" },
    });
    const result = await service.list(actor(["member"]));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected roster");
    const other = result.body.members.find(({ profile }) => profile.personId === OTHER_ID);
    expect(other?.profile.biography).toBeUndefined();
    expect(other?.profile.institutionalEmail).toBeUndefined();
  });

  it("does not treat an external collaborator as a member visibility audience", async () => {
    const { service } = setup({
      preferredName: "Visible publicly",
      biography: "Members only",
      fieldVisibility: { biography: "members", institutionalEmail: "administrators", researchTopics: "members", preferredName: "public", profileImageArtifactId: "self" },
    });
    const result = await service.list(actor(["external_collaborator"]));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected roster");
    const other = result.body.members.find(({ profile }) => profile.personId === OTHER_ID);
    expect(other?.profile.preferredName).toBe("Visible publicly");
    expect(other?.profile.biography).toBeUndefined();
    expect(other?.profile.researchTopics).toEqual([]);
    expect(other?.accountState).toBeUndefined();
  });
});

function setup(profileOverrides: Partial<MemberRecord["profile"]> = {}) {
  const records = [member(MEMBER_ID), member(OTHER_ID, profileOverrides)];
  const repository = {
    list: vi.fn(async () => records),
    updateOwnProfile: vi.fn(async () => records[0] as MemberRecord),
    updateGovernance: vi.fn(async () => records[1] as MemberRecord),
    replaceRoles: vi.fn(async () => records[1] as MemberRecord),
    replaceVisibility: vi.fn(async () => records[1] as MemberRecord),
  };
  const unit = {
    members: repository,
    audit: { append: vi.fn(async () => undefined) },
    outbox: { enqueue: vi.fn(async () => undefined) },
  } as unknown as AdminBotUnitOfWork;
  const transactions = {
    read: async <Result>(work: (value: AdminBotUnitOfWork) => Promise<Result>) => work(unit),
    write: async <Result>(work: (value: AdminBotUnitOfWork) => Promise<Result>) => work(unit),
  } satisfies TransactionBoundary;
  return { service: new MemberRosterService({ transactions, organizationId: ORGANIZATION_ID, now: () => NOW, createId: vi.fn(() => crypto.randomUUID()) }), repository };
}

function member(personId: string, profileOverrides: Partial<MemberRecord["profile"]> = {}): MemberRecord {
  return {
    profile: {
      id: personId, organizationId: ORGANIZATION_ID, personId,
      displayName: personId === MEMBER_ID ? "Synthetic Member" : "Other Member",
      preferredName: "Member", institutionalEmail: "member@example.com", biography: "Biography",
      researchTopics: ["Systems"],
      fieldVisibility: { preferredName: "members", institutionalEmail: "members", biography: "members", researchTopics: "members", profileImageArtifactId: "members" },
      version: 1, createdAt: NOW, updatedAt: NOW, ...profileOverrides,
    },
    membership: {
      id: personId, organizationId: ORGANIZATION_ID, personId,
      tier: "member", lifecycle: "active", roles: ["member"],
      version: 1, createdAt: NOW, updatedAt: NOW,
    },
    personStatus: "active",
    accountStatus: "active",
  };
}

function actor(roles: MemberActor["roles"], authenticationLevel: MemberActor["authenticationLevel"] = "recent_reauthentication"): MemberActor {
  return { accountId: "50000000-0000-4000-8000-000000000001", organizationId: ORGANIZATION_ID, personId: MEMBER_ID, roles, authenticationLevel };
}
