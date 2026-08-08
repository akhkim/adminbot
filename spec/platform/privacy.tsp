import "../common/primitives.tsp";
import "../common/errors.tsp";

using AdminBot.Contracts.Common;

namespace AdminBot.Contracts.Privacy;

@minLength(1)
scalar ReasoningDestinationId extends string;

enum DataClass {
  public,
  internal,
  confidential,
  secret,
  unknownData: "unknown",
}

enum PrivacyRoute {
  local,
  remote,
  hybrid,
  deny,
}

model DataProvenance {
  sourceType:
    | "user_input"
    | "artifact"
    | "database"
    | "inbound_adapter"
    | "generated";
  sourceId?: string;
  declaredClass?: DataClass;
  ownerIds: string[];
}

model ReasoningTask {
  purpose: string;
  input: unknown;
  provenance: DataProvenance[];
  requestedRoute?: "local" | "remote" | "hybrid";
  forceLocal: boolean;
}

model PrivacyClassification {
  effectiveClass: DataClass;
  ruleIds: string[];
  classifierVersion: SemVer;
  classifiedAt: utcDateTime;
  uncertain: boolean;
}

model PlaceholderManifest {
  sanitizedInput: unknown;
  @minValue(0) placeholderCount: int32;
  manifestDigest: Sha256;
  verificationRuleIds: string[];
}

model ReasoningReceipt {
  output: unknown;
  route: "local" | "remote" | "hybrid";
  classification: PrivacyClassification;
  destinations: ReasoningDestinationId[];
  redactedMetadata: Record<unknown>;
}

interface PrivacyBroker {
  reason(actor: ActorContext, task: ReasoningTask):
    | ReasoningReceipt
    | ErrorResponse;
}
