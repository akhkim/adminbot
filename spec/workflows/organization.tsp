import "../common/primitives.tsp";

using AdminBot.Contracts.Common;

namespace AdminBot.Contracts.Workflows.Organization;

@format("uuid")
scalar OrganizationUnitId extends string;
@format("uuid")
scalar ResponsibilityId extends string;
@format("uuid")
scalar KnowledgeEntryId extends string;
@format("uuid")
scalar AchievementId extends string;

model OrganizationUnit extends VersionedRecord {
  id: OrganizationUnitId;
  organizationId: OrganizationId;
  name: string;
  parentId?: OrganizationUnitId;
  leadIds: PersonId[];
  memberIds: PersonId[];
}

model Responsibility extends VersionedRecord {
  id: ResponsibilityId;
  organizationId: OrganizationId;
  name: string;
  description: string;
  ownerIds: PersonId[];
  backupIds: PersonId[];
  contactRoute: string;
  public: boolean;
}

model KnowledgeEntry extends VersionedRecord {
  id: KnowledgeEntryId;
  organizationId: OrganizationId;
  title: string;
  summary: string;
  audience: "public" | "members" | "administrators";
  ownerId: PersonId;
  sourceUri?: url;
  relatedResources: ResourceRef[];
  reviewDueOn?: plainDate;
}

model Achievement extends VersionedRecord {
  id: AchievementId;
  organizationId: OrganizationId;
  personIds: PersonId[];
  title: string;
  publicSummary?: string;
  evidenceArtifactIds: ArtifactId[];
  publicationState: "private" | "proposed" | "public" | "withdrawn";
}

model MapLocation {
  latitude: float64;
  longitude: float64;
  precision: "city" | "region";
}

model PublicMemberProjection {
  personId: PersonId;
  displayName: string;
  biography?: string;
  researchTopics: string[];
  profileImageArtifactId?: ArtifactId;
  mapLocation?: MapLocation;
}
