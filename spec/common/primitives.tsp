namespace AdminBot.Contracts.Common;

@format("uuid")
scalar AccountId extends string;
@format("uuid")
scalar ActionId extends string;
@format("uuid")
scalar ApprovalId extends string;
@format("uuid")
scalar ArtifactId extends string;
@format("uuid")
scalar AuditEventId extends string;
@format("uuid")
scalar CorrelationId extends string;
@format("uuid")
scalar EffectId extends string;
@format("uuid")
scalar ExecutionId extends string;
@format("uuid")
scalar FeedbackId extends string;
@format("uuid")
scalar JobDefinitionId extends string;
@format("uuid")
scalar JobRunId extends string;
@format("uuid")
scalar OrganizationId extends string;
@format("uuid")
scalar PersonId extends string;
@format("uuid")
scalar PolicyDecisionId extends string;
@format("uuid")
scalar PrincipalId extends string;
@format("uuid")
scalar RegistrationId extends string;
@format("uuid")
scalar RequestId extends string;
@format("uuid")
scalar ResourceId extends string;
@format("uuid")
scalar RoleAssignmentId extends string;
@format("uuid")
scalar SessionId extends string;

@minLength(1)
scalar ActionType extends string;
@minLength(1)
scalar CapabilityName extends string;
@minLength(1)
scalar CommandName extends string;
@minLength(1)
scalar ConnectorOperationName extends string;
@minLength(1)
scalar IdempotencyKey extends string;
@minLength(1)
scalar Permission extends string;
@minLength(1)
scalar QueryName extends string;
@minLength(1)
scalar SchemaId extends string;
@minLength(1)
scalar TemplateId extends string;

@pattern("^[0-9a-f]{64}$")
scalar Sha256 extends string;
@pattern("^v?[0-9]+[.][0-9]+[.][0-9]+(?:[-+][0-9A-Za-z.-]+)?$")
scalar SemVer extends string;

enum AuthenticationLevel {
  anonymous,
  singleFactor: "single_factor",
  recentReauthentication: "recent_reauthentication",
}

model ResourceRef {
  type: string;
  id: ResourceId;
  organizationId: OrganizationId;
}

model SchemaRef {
  id: SchemaId;
  version: SemVer;
}

model PageRequest {
  @minValue(1) @maxValue(200) limit: int32 = 50;
  cursor?: string;
}

model Page<Item> {
  items: Item[];
  nextCursor?: string;
}

model VersionedRecord {
  @minValue(1) version: int32;
  createdAt: utcDateTime;
  updatedAt: utcDateTime;
}

/** Server-created context. It is never accepted from an untrusted request body. */
model ActorContext {
  principalId: PrincipalId;
  organizationId: OrganizationId;
  sessionId?: SessionId;
  authenticationLevel: AuthenticationLevel;
  requestId: RequestId;
  correlationId: CorrelationId;
  receivedAt: utcDateTime;
}
