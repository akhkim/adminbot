import "../common/primitives.tsp";
import "../common/errors.tsp";
import "./automation.tsp";
import "./capabilities.tsp";
import "./governance.tsp";
import "./privacy.tsp";

using AdminBot.Contracts.Automation;
using AdminBot.Contracts.Capabilities;
using AdminBot.Contracts.Common;
using AdminBot.Contracts.Governance;
using AdminBot.Contracts.Privacy;

namespace AdminBot.Contracts.Supporting;

model ArtifactMetadata {
  id: ArtifactId;
  organizationId: OrganizationId;
  ownerId: PersonId;
  relatedResource?: ResourceRef;
  mediaType: string;
  byteLength: int64;
  sha256: Sha256;
  dataClass: DataClass;
  createdAt: utcDateTime;
  retentionUntil?: utcDateTime;
}

model ArtifactReadLease {
  artifact: ArtifactMetadata;
  leaseToken: string;
  expiresAt: utcDateTime;
}

interface ArtifactStore {
  getMetadata(actor: ActorContext, id: ArtifactId):
    | ArtifactMetadata
    | ErrorResponse;
  createReadLease(actor: ActorContext, id: ArtifactId):
    | ArtifactReadLease
    | ErrorResponse;
}

model TemplateDefinition {
  id: TemplateId;
  version: SemVer;
  name: string;
  variableSchema: SchemaRef;
  outputMediaType: string;
  maximumDataClass: DataClass;
  owner: string;
  reviewDate?: plainDate;
}

model RenderedTemplate {
  templateId: TemplateId;
  templateVersion: SemVer;
  content: string;
  dataClass: DataClass;
}

interface TemplateRegistry {
  get(id: TemplateId, version?: SemVer): TemplateDefinition | ErrorResponse;
  render(id: TemplateId, variables: unknown, version?: SemVer):
    | RenderedTemplate
    | ErrorResponse;
}

model QualityFeedback {
  id: FeedbackId;
  organizationId: OrganizationId;
  capability: CapabilityName;
  capabilityVersion: SemVer;
  relatedResource?: ResourceRef;
  rating: 1 | 2 | 3 | 4 | 5;
  correction?: unknown;
  correctionDataClass?: DataClass;
  trainingConsent: boolean;
  createdAt: utcDateTime;
}

model AuditEvent {
  id: AuditEventId;
  organizationId: OrganizationId;
  type: string;
  occurredAt: utcDateTime;
  principalId: PrincipalId;
  requestId: RequestId;
  correlationId: CorrelationId;
  resource?: ResourceRef;
  dataClass: DataClass;
  redactedDetails: Record<unknown>;
}

@format("uuid")
scalar SourceRecordId extends string;

model SourceIdentityClaim {
  scheme: "email" | "slack" | "whatsapp" | "form" | "openclaw" | "import";
  externalId: string;
  authenticated: boolean;
  evidenceDigest?: Sha256;
}

model SourceRecord {
  id: SourceRecordId;
  organizationId: OrganizationId;
  source: SourceIdentityClaim;
  receivedAt: utcDateTime;
  dataClass: DataClass;
  headers: Record<unknown>;
  bodyArtifactId?: ArtifactId;
  deduplicationDigest: Sha256;
}

model NormalizedInbound {
  sourceRecord: SourceRecord;
  proposedCommands: CommandRequest[];
  warnings: string[];
}

/** Inbound adapters normalize untrusted input; dispatch and authorization occur afterward. */
interface InboundAdapterPort {
  normalize(input: unknown): NormalizedInbound | ErrorResponse;
}

model NavigationContribution {
  audience: string;
  label: string;
  route: string;
}

model WorkflowManifest {
  name: string;
  version: SemVer;
  commands: CommandDefinition[];
  queries: QueryDefinition[];
  actions: ActionDefinition[];
  jobs: JobDefinition[];
  requiredCapabilities: string[];
  navigation: NavigationContribution[];
}
