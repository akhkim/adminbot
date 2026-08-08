import { createHash } from "node:crypto";
import {
  isSupportedScryptHash,
  normalizeEmailAddress,
  openClaimPersonKey,
  openRegistrationEmailKey,
  RegistrationValidationError,
} from "@adminbot/identity";
import type {
  JsonValue,
  LegacyIdentityImportBatch,
  LegacyRegistrationImport,
  LegacyRoleAssignmentImport,
  RegistrationProfileRecord,
} from "@adminbot/ports";
import type { LegacyIdentitySnapshot, LegacyRegistrationRow } from "./legacy-source.js";

export const IDENTITY_MAPPER_SET_VERSION = "identity-v1";

export interface MigrationIssue {
  readonly code: string;
  readonly table: string;
  readonly rowNumber: number;
  readonly message: string;
}

export interface IdentityMappingResult {
  readonly batch?: LegacyIdentityImportBatch;
  readonly issues: readonly MigrationIssue[];
  readonly report: JsonValue;
}

export interface IdentityMappingOptions {
  readonly organizationId: string;
  readonly sourceFingerprint: string;
  readonly completedAt: Date;
}

interface ParsedMember {
  readonly personId: string;
  readonly displayName: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function mapLegacyIdentity(
  snapshot: LegacyIdentitySnapshot,
  options: IdentityMappingOptions,
): IdentityMappingResult {
  const issues: MigrationIssue[] = [];
  const people: LegacyIdentityImportBatch["people"][number][] = [];
  const accounts: LegacyIdentityImportBatch["accounts"][number][] = [];
  const registrations: LegacyRegistrationImport[] = [];
  const roles: LegacyRoleAssignmentImport[] = [];
  const links: LegacyIdentityImportBatch["links"][number][] = [];
  const members = new Map<string, ParsedMember>();
  const personByEmail = new Map<string, string>();
  let credentialAccountsRequiringReclaim = 0;
  const migrationPrincipalId = stableUuid(`migration-principal\0${options.organizationId}`);

  snapshot.members.forEach((row, index) => {
    try {
      const payload = parseRecord(row.payload_json, "member payload");
      const displayName = requiredTrimmedString(payload.name, "member name", 160);
      const payloadId = requiredTrimmedString(payload.id, "member id", 500);
      if (payloadId !== row.id) throw new Error("member id differs from its indexed column");
      const privilege = normalizePrivilege(row.privilege_level);
      if (payload.privilege_level !== undefined && normalizePrivilege(payload.privilege_level) !== privilege) {
        throw new Error("member privilege differs from its indexed column");
      }
      const createdAt = parseDate(payload.created_at, "member created_at");
      const updatedAt = parseDate(row.updated_at, "member updated_at");
      const personId = stableUuid(`legacy-person\0${options.organizationId}\0${row.id}`);
      const status = payload.status === "alumni" ? "inactive" : "active";
      const member = { personId, displayName, createdAt, updatedAt };
      members.set(row.id, member);
      people.push({
        id: personId,
        organizationId: options.organizationId,
        displayName,
        status,
        createdAt,
        updatedAt,
      });
      links.push({ legacyMemberId: row.id, personId, importedAt: options.completedAt });
      for (const role of rolesForPrivilege(privilege)) {
        roles.push({
          id: stableUuid(`legacy-role\0${options.organizationId}\0${row.id}\0${role}`),
          organizationId: options.organizationId,
          personId,
          role,
          validFrom: createdAt,
          assignedBy: migrationPrincipalId,
          createdAt: options.completedAt,
          updatedAt: options.completedAt,
        });
      }
    } catch (error) {
      issues.push(issue("member_invalid", "adminbot_lab_members", index, error));
    }
  });

  snapshot.credentials.forEach((row, index) => {
    let email: string;
    try {
      email = normalizeEmailAddress(row.email);
    } catch (error) {
      if (error instanceof RegistrationValidationError) {
        credentialAccountsRequiringReclaim += 1;
        return;
      }
      throw error;
    }
    try {
      const member = members.get(row.member_id);
      if (member === undefined) throw new Error("credential references an unknown member");
      if (personByEmail.has(email)) throw new Error("credential login handle is duplicated");
      if (!isSupportedScryptHash(row.password_scrypt)) {
        credentialAccountsRequiringReclaim += 1;
        return;
      }
      personByEmail.set(email, member.personId);
      accounts.push({
        id: stableUuid(`legacy-account\0${options.organizationId}\0${row.member_id}`),
        organizationId: options.organizationId,
        personId: member.personId,
        loginHandle: email,
        passwordHash: row.password_scrypt,
        status: "active",
        createdAt: parseDate(row.claimed_at, "credential claimed_at"),
        updatedAt: parseDate(row.updated_at, "credential updated_at"),
      });
    } catch (error) {
      issues.push(issue("credential_invalid", "adminbot_member_credentials", index, error));
    }
  });

  const pendingEmails = new Set<string>();
  const pendingPeople = new Set<string>();
  snapshot.registrations.forEach((row, index) => {
    try {
      const registration = mapRegistration(
        row,
        options,
        members,
        personByEmail,
      );
      if (registration.status === "submitted") {
        if (pendingEmails.has(registration.requestedLoginHandle)) {
          throw new Error("multiple open registrations share a login handle");
        }
        pendingEmails.add(registration.requestedLoginHandle);
        if (registration.linkedPersonId !== undefined) {
          if (pendingPeople.has(registration.linkedPersonId)) {
            throw new Error("multiple open claims share a member");
          }
          pendingPeople.add(registration.linkedPersonId);
        }
      }
      registrations.push(registration);
    } catch (error) {
      issues.push(issue("registration_invalid", "adminbot_account_registrations", index, error));
    }
  });

  const report = {
    scope: "identity",
    mapperSetVersion: IDENTITY_MAPPER_SET_VERSION,
    sourceFingerprint: options.sourceFingerprint,
    sourceTableCount: snapshot.sourceTableCount,
    people: people.length,
    accounts: accounts.length,
    credentialAccountsRequiringReclaim,
    registrations: registrations.length,
    roleAssignments: roles.length,
    legacySessionsInvalidated: snapshot.legacySessionCount,
    issues: issues.length,
  } satisfies JsonValue;
  if (issues.length > 0) return { issues, report };

  return {
    issues,
    report,
    batch: {
      run: {
        id: stableUuid(
          `legacy-migration-run\0identity\0${options.sourceFingerprint}\0${IDENTITY_MAPPER_SET_VERSION}`,
        ),
        scope: "identity",
        sourceFingerprint: options.sourceFingerprint,
        mapperSetVersion: IDENTITY_MAPPER_SET_VERSION,
        redactedReport: report,
        completedAt: options.completedAt,
      },
      people,
      accounts,
      registrations,
      roles,
      links,
    },
  };
}

function mapRegistration(
  row: LegacyRegistrationRow,
  options: IdentityMappingOptions,
  members: ReadonlyMap<string, ParsedMember>,
  personByEmail: ReadonlyMap<string, string>,
): LegacyRegistrationImport {
  if (row.kind !== "claim" && row.kind !== "signup") throw new Error("registration kind is unknown");
  const status = registrationStatus(row.status);
  const email = normalizeEmailAddress(row.email);
  const directMember = row.member_id === null ? undefined : members.get(row.member_id);
  if (row.member_id !== null && directMember === undefined) {
    throw new Error("registration references an unknown member");
  }
  const linkedPersonId = directMember?.personId ??
    (status === "approved" ? personByEmail.get(email) : undefined);
  if (row.kind === "claim" && linkedPersonId === undefined) {
    throw new Error("claim registration has no mapped member");
  }
  const profile = row.kind === "signup" ? parseLegacySignupProfile(row.profile_json) : undefined;
  const requestedDisplayName = directMember?.displayName ?? profile?.displayName ??
    [...members.values()].find((member) => member.personId === linkedPersonId)?.displayName;
  if (requestedDisplayName === undefined) {
    throw new Error("registration has no display name");
  }
  if (status === "submitted" && !isSupportedScryptHash(row.password_scrypt)) {
    throw new Error("pending registration password hash uses an unsupported format");
  }
  const createdAt = parseDate(row.created_at, "registration created_at");
  const reviewedAt = row.decided_at === null
    ? undefined
    : parseDate(row.decided_at, "registration decided_at");
  const reviewedByPersonId = row.decided_by === null
    ? undefined
    : members.get(row.decided_by)?.personId;
  return {
    id: stableUuid(`legacy-registration\0${options.organizationId}\0${row.id}`),
    organizationId: options.organizationId,
    kind: row.kind,
    status,
    requestedLoginHandle: email,
    requestedDisplayName,
    ...(status === "submitted" ? { passwordHash: row.password_scrypt } : {}),
    ...(status === "submitted"
      ? { openRequestKey: openRegistrationEmailKey(options.organizationId, email) }
      : {}),
    ...(status === "submitted" && row.kind === "claim" && linkedPersonId !== undefined
      ? { openClaimPersonKey: openClaimPersonKey(options.organizationId, linkedPersonId) }
      : {}),
    ...(linkedPersonId === undefined ? {} : { linkedPersonId }),
    ...(reviewedByPersonId === undefined ? {} : { reviewedByPersonId }),
    ...(reviewedAt === undefined ? {} : { reviewedAt }),
    ...(profile === undefined ? {} : { profile }),
    createdAt,
    updatedAt: reviewedAt ?? createdAt,
  };
}

function parseLegacySignupProfile(raw: string | null): RegistrationProfileRecord {
  if (raw === null) throw new Error("signup registration profile is missing");
  const profile = parseRecord(raw, "signup profile");
  const allowed = new Set([
    "name", "slack_user_id", "role", "affiliation", "research_branch", "research_topics",
    "projects", "hours_per_week", "location", "timezone", "personal_website", "notes",
  ]);
  if (Object.keys(profile).some((key) => !allowed.has(key))) {
    throw new Error("signup profile contains an unsupported field");
  }
  const displayName = requiredTrimmedString(profile.name, "signup name", 160);
  const slackUserId = optionalString(profile.slack_user_id, "signup slack_user_id", 80);
  const role = optionalString(profile.role, "signup role", 160);
  const affiliation = optionalString(profile.affiliation, "signup affiliation", 240);
  const researchBranch = optionalString(profile.research_branch, "signup research_branch", 160);
  const researchTopics = optionalStringArray(profile.research_topics, "signup research_topics");
  const projects = optionalStringArray(profile.projects, "signup projects");
  const hoursPerWeek = optionalNumber(profile.hours_per_week, "signup hours_per_week");
  const location = optionalString(profile.location, "signup location", 240);
  const timezone = optionalString(profile.timezone, "signup timezone", 100);
  const personalWebsite = optionalString(profile.personal_website, "signup personal_website", 2_048);
  const notes = optionalString(profile.notes, "signup notes", 4_000);
  return {
    displayName,
    ...(slackUserId === undefined ? {} : { slackUserId }),
    ...(role === undefined ? {} : { role }),
    ...(affiliation === undefined ? {} : { affiliation }),
    ...(researchBranch === undefined ? {} : { researchBranch }),
    ...(researchTopics === undefined ? {} : { researchTopics }),
    ...(projects === undefined ? {} : { projects }),
    ...(hoursPerWeek === undefined ? {} : { hoursPerWeek }),
    ...(location === undefined ? {} : { location }),
    ...(timezone === undefined ? {} : { timezone }),
    ...(personalWebsite === undefined ? {} : { personalWebsite }),
    ...(notes === undefined ? {} : { notes }),
  };
}

function normalizePrivilege(value: unknown): "external_collaborator" | "trial" | "member" | "admin" {
  if (value === "core_member") return "member";
  if (value === "external_collaborator" || value === "trial" || value === "member" || value === "admin") {
    return value;
  }
  throw new Error("member privilege is unknown");
}

function rolesForPrivilege(
  privilege: "external_collaborator" | "trial" | "member" | "admin",
): readonly LegacyRoleAssignmentImport["role"][] {
  if (privilege === "external_collaborator" || privilege === "trial") {
    return ["external_collaborator"];
  }
  if (privilege === "member") return ["member"];
  return ["member", "administrator", "approver", "security_operator", "auditor"];
}

function registrationStatus(value: string): LegacyRegistrationImport["status"] {
  if (value === "pending") return "submitted";
  if (value === "approved" || value === "rejected") return value;
  throw new Error("registration status is unknown");
}

function parseRecord(raw: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${field} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${field} is not an object`);
  }
  return parsed as Record<string, unknown>;
}

function parseDate(value: unknown, field: string): Date {
  if (typeof value !== "string") throw new Error(`${field} is not a timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} is not a timestamp`);
  return date;
}

function requiredTrimmedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${field} is invalid`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined || value === "") return undefined;
  return requiredTrimmedString(value, field, maximum);
}

function optionalStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64) throw new Error(`${field} is invalid`);
  return value.map((item) => requiredTrimmedString(item, field, 160));
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 168) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function issue(code: string, table: string, zeroBasedIndex: number, error: unknown): MigrationIssue {
  const message = error instanceof RegistrationValidationError || error instanceof Error
    ? error.message
    : "row is invalid";
  return { code, table, rowNumber: zeroBasedIndex + 1, message };
}

function stableUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
