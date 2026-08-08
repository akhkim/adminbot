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
  fieldVisibility: Record<"self" | "members" | "administrators" | "public">;
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
  roleAssignments?: RoleName[];
  reason: string;
}

model ReconcileMemberAccessCommand {
  membershipId: MembershipId;
  dryRun: boolean;
}
