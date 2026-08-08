import { createHash, randomUUID } from "node:crypto";
import type { MemberRosterProjection } from "@adminbot/api-contracts";
import type {
  AccessRoleName,
  AdminBotUnitOfWork,
  MemberRecord,
  TransactionBoundary,
} from "@adminbot/ports";

export interface MemberActor {
  readonly accountId: string;
  readonly organizationId: string;
  readonly personId: string;
  readonly roles: readonly AccessRoleName[];
  readonly authenticationLevel: "single_factor" | "recent_reauthentication";
}

export interface MemberRosterServiceOptions {
  readonly transactions: TransactionBoundary;
  readonly organizationId: string;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

type ErrorResult = Readonly<{
  ok: false;
  status: 400 | 401 | 403 | 404 | 409;
  body: {
    code: "conflict" | "not_authenticated" | "not_authorized" | "not_found" | "payload_invalid";
    message: string;
    retryable: false;
  };
}>;

export type MemberCommandResult =
  | Readonly<{ ok: true; status: 200; body: MemberRosterProjection }>
  | ErrorResult;

const MEMBER_ROLES: ReadonlySet<AccessRoleName> = new Set([
  "external_collaborator", "member", "administrator",
]);

export class MemberRosterService {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly options: MemberRosterServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async list(actor: MemberActor | undefined): Promise<MemberCommandResult> {
    const denied = authorizeMember(actor, this.options.organizationId);
    if (denied !== undefined) return denied;
    if (actor === undefined) throw new Error("authorization invariant violated");
    return this.roster(actor, this.now());
  }

  async updateOwnProfile(actor: MemberActor | undefined, input: unknown): Promise<MemberCommandResult> {
    const denied = authorizeMember(actor, this.options.organizationId);
    if (denied !== undefined) return denied;
    if (actor === undefined) throw new Error("authorization invariant violated");
    const parsed = validateOwnProfile(input);
    if (!parsed.ok) return parsed.error;
    const now = this.now();
    const result = await this.options.transactions.write(async (unit) => {
      const updated = await repository(unit).updateOwnProfile({
        organizationId: this.options.organizationId,
        personId: actor.personId,
        now,
        ...parsed.value,
      });
      if (typeof updated === "string") return updated;
      await unit.audit.append({
        id: this.createId(), organizationId: this.options.organizationId,
        eventType: "member.profile_updated_self", actorId: actor.accountId,
        subjectId: actor.personId, occurredAt: now,
        safeDetails: { version: updated.profile.version, changedFields: parsed.changedFields.join(",") },
      });
      await unit.outbox.enqueue({
        id: this.createId(), organizationId: this.options.organizationId,
        eventType: "member.profile_updated_self", aggregateType: "member_profile",
        aggregateId: updated.profile.id, availableAt: now,
        payload: { personId: actor.personId, profileVersion: updated.profile.version },
      });
      return updated;
    });
    if (result === "not_found") return failure(404, "not_found", "member profile not found");
    if (result === "conflict") return failure(409, "conflict", "profile changed; refresh and try again");
    return this.roster(actor, now);
  }

  async updateGovernance(
    actor: MemberActor | undefined,
    personId: string,
    input: unknown,
  ): Promise<MemberCommandResult> {
    const denied = authorizeAdministrator(actor, this.options.organizationId);
    if (denied !== undefined) return denied;
    if (actor === undefined) throw new Error("authorization invariant violated");
    if (!uuid(personId)) return failure(404, "not_found", "member not found");
    const parsed = validateGovernance(input);
    if (!parsed.ok) return parsed.error;
    const now = this.now();
    const result = await this.options.transactions.write(async (unit) => {
      const updated = await repository(unit).updateGovernance({
        organizationId: this.options.organizationId,
        personId,
        now,
        ...parsed.value,
      });
      if (typeof updated === "string") return updated;
      await unit.audit.append({
        id: this.createId(), organizationId: this.options.organizationId,
        eventType: "member.governance_updated", actorId: actor.accountId,
        subjectId: personId, occurredAt: now,
        safeDetails: {
          profileVersion: updated.profile.version,
          membershipVersion: updated.membership.version,
          changedFields: parsed.changedFields.join(","),
          reasonDigest: createHash("sha256").update(parsed.value.reason).digest("hex"),
          reasonLength: parsed.value.reason.length,
        },
      });
      await unit.outbox.enqueue({
        id: this.createId(), organizationId: this.options.organizationId,
        eventType: "member.governance_updated", aggregateType: "membership",
        aggregateId: updated.membership.id, availableAt: now,
        payload: {
          personId,
          profileVersion: updated.profile.version,
          membershipVersion: updated.membership.version,
        },
      });
      return updated;
    });
    if (result === "not_found") return failure(404, "not_found", "member not found");
    if (result === "mentor_not_found") return failure(400, "payload_invalid", "mentor must be another active member");
    if (result === "conflict") return failure(409, "conflict", "member changed; refresh and try again");
    return this.roster(actor, now);
  }

  async replaceRoles(
    actor: MemberActor | undefined,
    personId: string,
    input: unknown,
  ): Promise<MemberCommandResult> {
    const denied = authorizeAdministrator(actor, this.options.organizationId);
    if (denied !== undefined) return denied;
    if (actor === undefined) throw new Error("authorization invariant violated");
    if (!uuid(personId)) return failure(404, "not_found", "member not found");
    if (personId === actor.personId) return failure(403, "not_authorized", "administrators cannot change their own roles");
    const parsed = validateRoles(input);
    if (!parsed.ok) return parsed.error;
    const now = this.now();
    const result = await this.options.transactions.write(async (unit) => {
      const updated = await repository(unit).replaceRoles({
        organizationId: this.options.organizationId,
        actorPersonId: actor.personId,
        personId,
        expectedMembershipVersion: parsed.value.expectedMembershipVersion,
        roles: parsed.value.roles,
        assignments: parsed.value.roles.map((role) => ({ id: this.createId(), role })),
        now,
      });
      if (typeof updated === "string") return updated;
      await unit.audit.append({
        id: this.createId(), organizationId: this.options.organizationId,
        eventType: "member.authorization_roles_replaced", actorId: actor.accountId,
        subjectId: personId, occurredAt: now,
        safeDetails: {
          membershipVersion: updated.membership.version,
          roles: parsed.value.roles.join(","),
          reasonDigest: digest(parsed.value.reason), reasonLength: parsed.value.reason.length,
        },
      });
      await unit.outbox.enqueue({
        id: this.createId(), organizationId: this.options.organizationId,
        eventType: "member.authorization_roles_replaced", aggregateType: "role_assignment",
        aggregateId: personId, availableAt: now,
        payload: { personId, membershipVersion: updated.membership.version },
      });
      return updated;
    });
    if (result === "not_found") return failure(404, "not_found", "member not found");
    if (result === "conflict") return failure(409, "conflict", "member roles changed; refresh and try again");
    if (result === "not_authorized") return failure(403, "not_authorized", "administrator role is no longer active");
    if (result === "self_change") return failure(403, "not_authorized", "administrators cannot change their own roles");
    if (result === "last_administrator") return failure(409, "conflict", "the last active administrator cannot be removed");
    if (result === "no_change") return failure(400, "payload_invalid", "role replacement has no changes");
    return this.roster(actor, now);
  }

  async replaceVisibility(
    actor: MemberActor | undefined,
    personId: string,
    input: unknown,
  ): Promise<MemberCommandResult> {
    const denied = authorizeAdministrator(actor, this.options.organizationId);
    if (denied !== undefined) return denied;
    if (actor === undefined) throw new Error("authorization invariant violated");
    if (!uuid(personId)) return failure(404, "not_found", "member not found");
    const parsed = validateVisibility(input);
    if (!parsed.ok) return parsed.error;
    const now = this.now();
    const result = await this.options.transactions.write(async (unit) => {
      const updated = await repository(unit).replaceVisibility({
        organizationId: this.options.organizationId, actorPersonId: actor.personId,
        personId, now, ...parsed.value,
      });
      if (typeof updated === "string") return updated;
      await unit.audit.append({
        id: this.createId(), organizationId: this.options.organizationId,
        eventType: "member.profile_visibility_replaced", actorId: actor.accountId,
        subjectId: personId, occurredAt: now,
        safeDetails: {
          profileVersion: updated.profile.version,
          visibility: visibilitySummary(parsed.value.fieldVisibility),
          reasonDigest: digest(parsed.value.reason), reasonLength: parsed.value.reason.length,
        },
      });
      await unit.outbox.enqueue({
        id: this.createId(), organizationId: this.options.organizationId,
        eventType: "member.profile_visibility_replaced", aggregateType: "member_profile",
        aggregateId: updated.profile.id, availableAt: now,
        payload: { personId, profileVersion: updated.profile.version },
      });
      return updated;
    });
    if (result === "not_found") return failure(404, "not_found", "member not found");
    if (result === "conflict") return failure(409, "conflict", "profile visibility changed; refresh and try again");
    if (result === "not_authorized") return failure(403, "not_authorized", "administrator role is no longer active");
    if (result === "no_change") return failure(400, "payload_invalid", "visibility replacement has no changes");
    return this.roster(actor, now);
  }

  private async roster(actor: MemberActor, now: Date): Promise<MemberCommandResult> {
    const members = await this.options.transactions.read((unit) =>
      repository(unit).list(this.options.organizationId, now),
    );
    return {
      ok: true,
      status: 200,
      body: {
        viewerPersonId: actor.personId,
        viewerRoles: [...actor.roles],
        members: members.map((member) => projectMember(member, actor)),
        asOf: now.toISOString(),
      },
    };
  }
}

function projectMember(member: MemberRecord, actor: MemberActor) {
  const self = member.profile.personId === actor.personId;
  const administrator = actor.roles.includes("administrator");
  const visible = (field: keyof MemberRecord["profile"]["fieldVisibility"]): boolean => {
    const audience = member.profile.fieldVisibility[field] ?? "administrators";
    return self || administrator || audience === "members" || audience === "public";
  };
  return {
    profile: {
      id: member.profile.id,
      organizationId: member.profile.organizationId,
      personId: member.profile.personId,
      displayName: member.profile.displayName,
      researchTopics: visible("researchTopics") ? [...member.profile.researchTopics] : [],
      fieldVisibility: member.profile.fieldVisibility,
      version: member.profile.version,
      createdAt: member.profile.createdAt.toISOString(),
      updatedAt: member.profile.updatedAt.toISOString(),
      ...(visible("preferredName") && member.profile.preferredName !== undefined
        ? { preferredName: member.profile.preferredName } : {}),
      ...(visible("institutionalEmail") && member.profile.institutionalEmail !== undefined
        ? { institutionalEmail: member.profile.institutionalEmail } : {}),
      ...(visible("biography") && member.profile.biography !== undefined
        ? { biography: member.profile.biography } : {}),
      ...(visible("profileImageArtifactId") && member.profile.profileImageArtifactId !== undefined
        ? { profileImageArtifactId: member.profile.profileImageArtifactId } : {}),
    },
    membership: {
      id: member.membership.id,
      organizationId: member.membership.organizationId,
      personId: member.membership.personId,
      tier: member.membership.tier,
      lifecycle: member.membership.lifecycle,
      version: member.membership.version,
      createdAt: member.membership.createdAt.toISOString(),
      updatedAt: member.membership.updatedAt.toISOString(),
      ...(member.membership.startDate === undefined ? {} : { startDate: member.membership.startDate }),
      ...(member.membership.endDate === undefined ? {} : { endDate: member.membership.endDate }),
      ...(member.membership.mentorId === undefined ? {} : { mentorId: member.membership.mentorId }),
    },
    personStatus: member.personStatus,
    ...(member.accountStatus === undefined ? {} : { accountState: member.accountStatus }),
    roles: self || administrator ? [...member.membership.roles] : [],
    ...(member.membership.mentorName === undefined ? {} : { mentorName: member.membership.mentorName }),
    canEditOwnProfile: self,
    canEditGovernance: administrator,
    canManageRoles: administrator && !self,
    canManageVisibility: administrator,
  };
}

type OwnProfileValue = {
  expectedVersion: number;
  preferredName?: string | null;
  biography?: string | null;
  researchTopics?: readonly string[];
};

function validateOwnProfile(input: unknown):
  | { ok: true; value: OwnProfileValue; changedFields: readonly string[] }
  | { ok: false; error: ErrorResult } {
  if (!record(input) || !onlyKeys(input, ["expectedVersion", "preferredName", "biography", "researchTopics"]) || !positiveInt(input.expectedVersion)) {
    return invalid("profile update is invalid");
  }
  const changedFields = ["preferredName", "biography", "researchTopics"].filter((key) => key in input);
  if (changedFields.length === 0) return invalid("profile update has no changes");
  const preferredName = nullableText(input.preferredName, 200);
  const biography = nullableText(input.biography, 5_000);
  const researchTopics = optionalStringArray(input.researchTopics, 30, 100);
  if (preferredName === false || biography === false || researchTopics === false) return invalid("profile fields are invalid");
  return {
    ok: true,
    changedFields,
    value: {
      expectedVersion: input.expectedVersion,
      ...(input.preferredName === undefined ? {} : { preferredName: preferredName as string | null }),
      ...(input.biography === undefined ? {} : { biography: biography as string | null }),
      ...(input.researchTopics === undefined ? {} : { researchTopics: researchTopics as readonly string[] }),
    },
  };
}

type GovernanceValue = {
  expectedProfileVersion: number;
  expectedMembershipVersion: number;
  reason: string;
  displayName?: string;
  institutionalEmail?: string | null;
  tier?: "external_collaborator" | "member";
  lifecycle?: "applicant" | "accepted" | "onboarding" | "active" | "leave" | "departing" | "alumni";
  mentorId?: string | null;
};

function validateGovernance(input: unknown):
  | { ok: true; value: GovernanceValue; changedFields: readonly string[] }
  | { ok: false; error: ErrorResult } {
  const keys = ["expectedProfileVersion", "expectedMembershipVersion", "displayName", "institutionalEmail", "tier", "lifecycle", "mentorId", "reason"];
  if (!record(input) || !onlyKeys(input, keys) || !positiveInt(input.expectedProfileVersion) || !positiveInt(input.expectedMembershipVersion)) return invalid("governance update is invalid");
  const reason = text(input.reason, 2_000);
  const changedFields = ["displayName", "institutionalEmail", "tier", "lifecycle", "mentorId"].filter((key) => key in input);
  if (reason === undefined || changedFields.length === 0) return invalid("governance update requires changes and a reason");
  const displayName = input.displayName === undefined ? undefined : text(input.displayName, 300);
  const institutionalEmail = nullableText(input.institutionalEmail, 320);
  if (displayName === undefined && input.displayName !== undefined) return invalid("display name is invalid");
  if (institutionalEmail === false || (typeof institutionalEmail === "string" && !email(institutionalEmail))) return invalid("institutional email is invalid");
  if (input.tier !== undefined && input.tier !== "external_collaborator" && input.tier !== "member") return invalid("membership tier is invalid");
  if (input.lifecycle !== undefined && !["applicant", "accepted", "onboarding", "active", "leave", "departing", "alumni"].includes(input.lifecycle as string)) return invalid("member lifecycle is invalid");
  if (input.mentorId !== undefined && input.mentorId !== null && !uuid(input.mentorId)) return invalid("mentor is invalid");
  return {
    ok: true,
    changedFields,
    value: {
      expectedProfileVersion: input.expectedProfileVersion,
      expectedMembershipVersion: input.expectedMembershipVersion,
      reason,
      ...(input.displayName === undefined ? {} : { displayName: displayName as string }),
      ...(input.institutionalEmail === undefined ? {} : { institutionalEmail: institutionalEmail as string | null }),
      ...(input.tier === undefined ? {} : { tier: input.tier }),
      ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle as NonNullable<GovernanceValue["lifecycle"]> }),
      ...(input.mentorId === undefined ? {} : { mentorId: input.mentorId }),
    },
  };
}

const ACCESS_ROLES = ["external_collaborator", "member", "administrator", "approver", "security_operator", "auditor"] as const;
const VISIBILITY_FIELDS = ["preferredName", "institutionalEmail", "biography", "researchTopics", "profileImageArtifactId"] as const;
const AUDIENCES = ["self", "members", "administrators", "public"] as const;

function validateRoles(input: unknown):
  | { ok: true; value: { expectedMembershipVersion: number; roles: readonly AccessRoleName[]; reason: string } }
  | { ok: false; error: ErrorResult } {
  if (!record(input) || !onlyKeys(input, ["expectedMembershipVersion", "roles", "reason"]) || !positiveInt(input.expectedMembershipVersion)) return invalid("role replacement is invalid");
  const reason = text(input.reason, 2_000);
  if (reason === undefined || !Array.isArray(input.roles) || input.roles.length === 0 || input.roles.length > ACCESS_ROLES.length) return invalid("roles and reason are required");
  if (input.roles.some((role) => typeof role !== "string" || !ACCESS_ROLES.includes(role as typeof ACCESS_ROLES[number]))) return invalid("authorization role is invalid");
  const roles = [...new Set(input.roles)] as AccessRoleName[];
  if (roles.length !== input.roles.length) return invalid("authorization roles must be unique");
  return { ok: true, value: { expectedMembershipVersion: input.expectedMembershipVersion, roles, reason } };
}

type Visibility = MemberRecord["profile"]["fieldVisibility"];
function validateVisibility(input: unknown):
  | { ok: true; value: { expectedProfileVersion: number; fieldVisibility: Visibility; reason: string } }
  | { ok: false; error: ErrorResult } {
  if (!record(input) || !onlyKeys(input, ["expectedProfileVersion", "fieldVisibility", "reason"]) || !positiveInt(input.expectedProfileVersion)) return invalid("visibility replacement is invalid");
  const reason = text(input.reason, 2_000);
  if (reason === undefined || !record(input.fieldVisibility) || !onlyKeys(input.fieldVisibility, VISIBILITY_FIELDS)) return invalid("complete field visibility and reason are required");
  if (VISIBILITY_FIELDS.some((field) => !AUDIENCES.includes(input.fieldVisibility[field] as typeof AUDIENCES[number]))) return invalid("field visibility audience is invalid");
  return { ok: true, value: { expectedProfileVersion: input.expectedProfileVersion, fieldVisibility: input.fieldVisibility as unknown as Visibility, reason } };
}

function authorizeMember(actor: MemberActor | undefined, organizationId: string): ErrorResult | undefined {
  if (actor === undefined) return failure(401, "not_authenticated", "authentication required");
  if (actor.organizationId !== organizationId || !actor.roles.some((role) => MEMBER_ROLES.has(role))) {
    return failure(403, "not_authorized", "member access required");
  }
  return undefined;
}

function authorizeAdministrator(actor: MemberActor | undefined, organizationId: string): ErrorResult | undefined {
  if (actor === undefined) return failure(401, "not_authenticated", "authentication required");
  if (actor.organizationId !== organizationId || !actor.roles.includes("administrator")) {
    return failure(403, "not_authorized", "administrator role required");
  }
  if (actor.authenticationLevel !== "recent_reauthentication") {
    return failure(403, "not_authorized", "recent reauthentication required");
  }
  return undefined;
}

function repository(unit: AdminBotUnitOfWork) {
  if (unit.members === undefined) throw new Error("member repository is not configured");
  return unit.members;
}
function invalid(message: string): { ok: false; error: ErrorResult } { return { ok: false, error: failure(400, "payload_invalid", message) }; }
function failure(status: ErrorResult["status"], code: ErrorResult["body"]["code"], message: string): ErrorResult { return { ok: false, status, body: { code, message, retryable: false } }; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const allowed = new Set(keys); return Object.keys(value).every((key) => allowed.has(key)); }
function positiveInt(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function text(value: unknown, maximum: number): string | undefined { return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum ? value.trim() : undefined; }
function nullableText(value: unknown, maximum: number): string | null | undefined | false { if (value === undefined) return undefined; if (value === null || value === "") return null; return typeof value === "string" && value.trim().length <= maximum ? value.trim() || null : false; }
function optionalStringArray(value: unknown, maximumItems: number, maximumLength: number): readonly string[] | undefined | false { if (value === undefined) return undefined; if (!Array.isArray(value) || value.length > maximumItems || value.some((item) => typeof item !== "string" || item.trim().length === 0 || item.trim().length > maximumLength)) return false; return [...new Set(value.map((item) => (item as string).trim()))]; }
function email(value: string): boolean { return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value); }
function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function visibilitySummary(value: Visibility): string { return VISIBILITY_FIELDS.map((field) => `${field}:${value[field]}`).join(","); }
