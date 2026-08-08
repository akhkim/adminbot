import "../common/primitives.tsp";
import "../platform/identity.tsp";

using AdminBot.Contracts.Common;
using AdminBot.Contracts.Identity;

namespace AdminBot.Contracts.Workflows.Members;

@format("uuid")
scalar MemberProfileId extends string;
@format("uuid")
scalar MembershipId extends string;
@format("uuid")
scalar OnboardingPlanId extends string;
@format("uuid")
scalar OnboardingStepId extends string;
@format("uuid")
scalar DownstreamGrantId extends string;

enum MembershipTier {
  externalCollaborator: "external_collaborator",
  member,
}

enum MemberLifecycleState {
  applicant,
  accepted,
  onboarding,
  active,
  leave,
  departing,
  alumni,
}

enum MemberFieldAudience {
  self,
  members,
  administrators,
  public,
}

model MemberFieldVisibility {
  preferredName: MemberFieldAudience;
  institutionalEmail: MemberFieldAudience;
  biography: MemberFieldAudience;
  researchTopics: MemberFieldAudience;
  profileImageArtifactId: MemberFieldAudience;
}

model MemberProfile extends VersionedRecord {
  id: MemberProfileId;
  organizationId: OrganizationId;
  personId: PersonId;
  displayName: string;
  preferredName?: string;
  institutionalEmail?: string;
  biography?: string;
  researchTopics: string[];
  profileImageArtifactId?: ArtifactId;
  fieldVisibility: MemberFieldVisibility;
}

model Membership extends VersionedRecord {
  id: MembershipId;
  organizationId: OrganizationId;
  personId: PersonId;
  tier: MembershipTier;
  lifecycle: MemberLifecycleState;
  startDate?: plainDate;
  endDate?: plainDate;
  mentorId?: PersonId;
}

model OnboardingStep {
  id: OnboardingStepId;
  kind:
    | "profile"
    | "account"
    | "access_grant"
    | "orientation"
    | "document"
    | "human_confirmation";
  title: string;
  state: "blocked" | "ready" | "in_progress" | "completed" | "skipped";
  dependsOn: OnboardingStepId[];
  ownerPersonId?: PersonId;
  completedAt?: utcDateTime;
  evidenceArtifactId?: ArtifactId;
}

model OnboardingPlan extends VersionedRecord {
  id: OnboardingPlanId;
  membershipId: MembershipId;
  templateVersion: SemVer;
  steps: OnboardingStep[];
}

/** Desired external access; it is not an AdminBot authorization role. */
model DownstreamGrant extends VersionedRecord {
  id: DownstreamGrantId;
  membershipId: MembershipId;
  system: "google" | "slack" | "overleaf" | "openclaw";
  bundle: string;
  state:
    | "desired"
    | "proposed"
    | "active"
    | "revocation_proposed"
    | "revoked"
    | "drifted";
  externalReference?: string;
}

model SubmitRegistrationCommand {
  registrationId: RegistrationId;
  displayName: string;
  loginHandle: string;
}

model ReviewRegistrationCommand {
  registrationId: RegistrationId;
  decision: "approve" | "reject";
  initialTier?: MembershipTier;
  note?: string;
}

model UpdateOwnProfileCommand {
  profileId: MemberProfileId;
  expectedVersion: int32;
  preferredName?: string;
  biography?: string;
  researchTopics?: string[];
  profileImageArtifactId?: ArtifactId;
}

model ChangeMembershipGovernanceCommand {
  membershipId: MembershipId;
  expectedVersion: int32;
  tier?: MembershipTier;
  lifecycle?: MemberLifecycleState;
  mentorId?: PersonId;
  reason: string;
}

model MemberRosterEntry {
  profile: MemberProfile;
  membership: Membership;
  personStatus: "active" | "inactive" | "merged";
  accountState?: AccountState;
  roles: RoleName[];
  mentorName?: string;
  canEditOwnProfile: boolean;
  canEditGovernance: boolean;
  canManageRoles: boolean;
  canManageVisibility: boolean;
}

model MemberRosterProjection {
  viewerPersonId: PersonId;
  viewerRoles: RoleName[];
  members: MemberRosterEntry[];
  asOf: utcDateTime;
}

model UpdateOwnMemberProfileInput {
  expectedVersion: int32;
  preferredName?: string | null;
  biography?: string | null;
  researchTopics?: string[];
}

model UpdateMemberGovernanceInput {
  expectedProfileVersion: int32;
  expectedMembershipVersion: int32;
  displayName?: string;
  institutionalEmail?: string | null;
  tier?: MembershipTier;
  lifecycle?: MemberLifecycleState;
  mentorId?: PersonId | null;
  @minLength(1) @maxLength(2000) reason: string;
}

/** Replaces the target's complete active authorization-role set. */
model ReplaceMemberRolesInput {
  expectedMembershipVersion: int32;
  @minItems(1) roles: RoleName[];
  @minLength(1) @maxLength(2000) reason: string;
}

/** Replaces the field-level roster audiences for the target profile. */
model ReplaceMemberVisibilityInput {
  expectedProfileVersion: int32;
  fieldVisibility: MemberFieldVisibility;
  @minLength(1) @maxLength(2000) reason: string;
}

model ReconcileMemberAccessCommand {
  membershipId: MembershipId;
  dryRun: boolean;
}
