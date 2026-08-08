import "../common/primitives.tsp";
import "../common/errors.tsp";

using AdminBot.Contracts.Common;

namespace AdminBot.Contracts.Identity;

enum RoleName {
  externalCollaborator: "external_collaborator",
  member,
  administrator,
  approver,
  securityOperator: "security_operator",
  auditor,
}

enum RegistrationKind {
  claim,
  signup,
}

enum RegistrationState {
  submitted,
  underReview: "under_review",
  approved,
  rejected,
  withdrawn,
}

enum AccountState {
  pending,
  active,
  suspended,
  closed,
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
  loginHandle: EmailAddress;
  status: AccountState;
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
  kind: RegistrationKind;
  requestedLoginHandle: EmailAddress;
  requestedDisplayName: string;
  state: RegistrationState;
  linkedPersonId?: PersonId;
  profile?: SignupProfile;
  reviewedBy?: PersonId;
  reviewedAt?: utcDateTime;
}

/** Anonymous roster projection for a claim picker. It deliberately omits contact details. */
model ClaimablePerson {
  personId: PersonId;
  displayName: string;
}

model SignupProfile {
  displayName: string;
  slackUserId?: string;
  role?: string;
  affiliation?: string;
  researchBranch?: string;
  researchTopics?: string[];
  projects?: string[];
  hoursPerWeek?: float64;
  location?: string;
  timezone?: string;
  personalWebsite?: url;
  notes?: string;
}

model ClaimRegistrationInput {
  personId: PersonId;
  email: EmailAddress;
  @minLength(10) password: string;
}

model SignupRegistrationInput {
  email: EmailAddress;
  @minLength(10) password: string;
  profile: SignupProfile;
}

model RegistrationSubmitted {
  registrationId: RegistrationId;
  state: "submitted";
}

model RegistrationDecisionInput {
  decision: "approve" | "reject";
  reason?: string;
}

model LoginInput {
  email: EmailAddress;
  @minLength(1) password: string;
}

/** Safe browser view. The opaque session credential is delivered only in an HTTP-only cookie. */
model SessionView {
  sessionId: SessionId;
  expiresAt: utcDateTime;
  authenticationLevel: AuthenticationLevel;
  person: Person;
  roles: RoleName[];
}

model PasswordChangeInput {
  currentPassword: string;
  @minLength(10) newPassword: string;
}

model EmailChangeInput {
  currentPassword: string;
  newEmail: EmailAddress;
}

enum GatewayScope {
  operatorRead: "operator.read",
  operatorWrite: "operator.write",
  operatorApprovals: "operator.approvals",
  operatorPairing: "operator.pairing",
  operatorAdmin: "operator.admin",
}

model DeviceCredentialInput {
  deviceId: DeviceId;
  publicKey: string;
  platform?: string;
  deviceFamily?: string;
  displayName?: string;
}

/** The token value is intentionally transport-only and omitted from durable/audit schemas. */
model DeviceCredentialReceipt {
  deviceId: DeviceId;
  scopes: GatewayScope[];
  expiresAt: utcDateTime;

  /** Returned once to the authenticated device; never persisted in browser storage or audit. */
  credential: string;
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
