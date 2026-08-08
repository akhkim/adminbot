import "../common/primitives.tsp";
import "../common/errors.tsp";

using AdminBot.Contracts.Common;

namespace AdminBot.Contracts.Connectors;

@minLength(1)
scalar ConnectorId extends string;
@minLength(1)
scalar CredentialRef extends string;

enum RetryClass {
  noRetry: "never",
  safeWithSameKey: "safe_with_same_key",
  afterReconciliation: "after_reconciliation",
}

model ConnectorOperationDefinition {
  name: ConnectorOperationName;
  version: SemVer;
  inputSchema: SchemaRef;
  safeResultSchema: SchemaRef;
  requiredCredential: CredentialRef;
  requiredScopes: string[];
  supportsDryRun: boolean;
  vendorIdempotency: "native" | "verified_lookup" | "none";
  retryClass: RetryClass;
  compensationOperation?: ConnectorOperationName;
}

model ConnectorManifest {
  id: ConnectorId;
  version: SemVer;
  operations: ConnectorOperationDefinition[];
}

/** Short-lived authority minted for one approved effect and one operation. */
model EffectCapability {
  effectId: EffectId;
  operation: ConnectorOperationName;
  inputHash: Sha256;
  idempotencyKey: IdempotencyKey;
  credential: CredentialRef;
  grantedScopes: string[];
  expiresAt: utcDateTime;
}

model ConnectorInvocation {
  capability: EffectCapability;
  input: unknown;
}

model ConnectorSuccess {
  outcome: "succeeded";
  safeResult: Record<unknown>;
  vendorReference?: string;
  verifiedAt: utcDateTime;
}

model ConnectorFailure {
  outcome: "failed";
  safeErrorCode: string;
  retryClass: RetryClass;
}

model ConnectorUncertain {
  outcome: "uncertain";
  safeErrorCode: string;
  reconciliationToken?: string;
}

union ConnectorOutcome {
  succeeded: ConnectorSuccess,
  failed: ConnectorFailure,
  uncertain: ConnectorUncertain,
}

/** Implemented once per narrow operation; there is intentionally no arbitrary run method. */
interface ConnectorOperationPort {
  validate(invocation: ConnectorInvocation): void | ErrorResponse;
  dryRun(invocation: ConnectorInvocation): Record<unknown> | ErrorResponse;
  execute(invocation: ConnectorInvocation): ConnectorOutcome;
  reconcile(invocation: ConnectorInvocation, token: string): ConnectorOutcome;
}
