import type { JsonValue, RegistrationProfileRecord } from "./shared.js";

export interface LegacyPersonImport {
  readonly id: string;
  readonly organizationId: string;
  readonly displayName: string;
  readonly status: "active" | "inactive";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LegacyAccountImport {
  readonly id: string;
  readonly organizationId: string;
  readonly personId: string;
  readonly loginHandle: string;
  readonly passwordHash: string;
  readonly status: "active";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LegacyRegistrationImport {
  readonly id: string;
  readonly organizationId: string;
  readonly kind: "claim" | "signup";
  readonly status: "submitted" | "approved" | "rejected";
  readonly requestedLoginHandle: string;
  readonly requestedDisplayName: string;
  readonly passwordHash?: string;
  readonly openRequestKey?: string;
  readonly openClaimPersonKey?: string;
  readonly linkedPersonId?: string;
  readonly reviewedByPersonId?: string;
  readonly reviewedAt?: Date;
  readonly profile?: RegistrationProfileRecord;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LegacyRoleAssignmentImport {
  readonly id: string;
  readonly organizationId: string;
  readonly personId: string;
  readonly role:
    | "external_collaborator"
    | "member"
    | "administrator"
    | "approver"
    | "security_operator"
    | "auditor";
  readonly validFrom: Date;
  readonly assignedBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LegacyIdentityLinkImport {
  readonly legacyMemberId: string;
  readonly personId: string;
  readonly importedAt: Date;
}

export interface LegacyIdentityImportBatch {
  readonly run: {
    readonly id: string;
    readonly scope: "identity";
    readonly sourceFingerprint: string;
    readonly mapperSetVersion: string;
    readonly redactedReport: JsonValue;
    readonly completedAt: Date;
  };
  readonly people: readonly LegacyPersonImport[];
  readonly accounts: readonly LegacyAccountImport[];
  readonly registrations: readonly LegacyRegistrationImport[];
  readonly roles: readonly LegacyRoleAssignmentImport[];
  readonly links: readonly LegacyIdentityLinkImport[];
}

export interface LegacyMigrationRepository {
  hasCompletedRun(
    scope: string,
    sourceFingerprint: string,
    mapperSetVersion: string,
  ): Promise<boolean>;
  importIdentity(batch: LegacyIdentityImportBatch): Promise<void>;
}
