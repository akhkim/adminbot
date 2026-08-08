import "../common/primitives.tsp";
import "../common/errors.tsp";

using AdminBot.Contracts.Common;

namespace AdminBot.Contracts.Identity;

enum RoleName {
  visitor,
  externalCollaborator: "external_collaborator",
  member,
  coreMember: "core_member",
  administrator,
  securityOperator: "security_operator",
  auditor,
}

enum ServicePurpose {
  agent,
  adapter,
  job,
  dataImport: "import",
  connectorWorker: "connector_worker",
}

model HumanPrincipal {
  kind: "human";
  id: PrincipalId;
  personId: PersonId;
  accountId: AccountId;
}

model ServicePrincipal {
  kind: "service";
  id: PrincipalId;
  purpose: ServicePurpose;
  name: string;
  proposalOnly: boolean;
}

model AnonymousPrincipal {
  kind: "anonymous";
  id: PrincipalId;
}

union Principal {
  human: HumanPrincipal,
  service: ServicePrincipal,
  anonymous: AnonymousPrincipal,
}

model Person extends VersionedRecord {
  id: PersonId;
  organizationId: OrganizationId;
  displayName: string;
  status: "active" | "inactive" | "merged";
}

model Account extends VersionedRecord {
  id: AccountId;
  personId: PersonId;
  organizationId: OrganizationId;
  loginHandle: string;
  status: "pending" | "active" | "suspended" | "closed";
}

model Session {
  id: SessionId;
  accountId: AccountId;
  principalId: PrincipalId;
  createdAt: utcDateTime;
  expiresAt: utcDateTime;
  lastReauthenticatedAt?: utcDateTime;
  revokedAt?: utcDateTime;
}

model Registration extends VersionedRecord {
  id: RegistrationId;
  organizationId: OrganizationId;
  requestedLoginHandle: string;
  requestedDisplayName: string;
  state: "submitted" | "under_review" | "approved" | "rejected" | "withdrawn";
  linkedPersonId?: PersonId;
  reviewedBy?: PersonId;
  reviewedAt?: utcDateTime;
}

model RoleAssignment extends VersionedRecord {
  id: RoleAssignmentId;
  organizationId: OrganizationId;
  personId: PersonId;
  role: RoleName;
  validFrom: utcDateTime;
  validUntil?: utcDateTime;
  assignedBy: PersonId;
}

model ResourceRelation extends VersionedRecord {
  personId: PersonId;
  resource: ResourceRef;
  relation: "owner" | "author" | "mentor" | "reviewer" | "manager";
  validUntil?: utcDateTime;
}

model ResolvedIdentity {
  principal: Principal;
  roles: RoleAssignment[];
}

interface IdentityService {
  resolveSession(sessionId: SessionId, now: utcDateTime):
    | ResolvedIdentity
    | ErrorResponse;
  revokeSession(sessionId: SessionId, reason: string): void | ErrorResponse;
  getPerson(personId: PersonId): Person | ErrorResponse;
}
