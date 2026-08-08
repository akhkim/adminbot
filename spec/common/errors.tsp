import "./primitives.tsp";

namespace AdminBot.Contracts.Common;

enum ErrorCode {
  notAuthenticated: "not_authenticated",
  notAuthorized: "not_authorized",
  notFound: "not_found",
  conflict,
  payloadInvalid: "payload_invalid",
  stateInvalid: "state_invalid",
  policyDenied: "policy_denied",
  policyChanged: "policy_changed",
  approvalHashMismatch: "approval_hash_mismatch",
  approvalQuorumMissing: "approval_quorum_missing",
  connectorUnavailable: "connector_unavailable",
  effectUncertain: "effect_uncertain",
  privacyRouteDenied: "privacy_route_denied",
  rateLimited: "rate_limited",
  dependencyUnavailable: "dependency_unavailable",
  internalError: "internal_error",
}

/** Safe for clients and logs. Raw vendor and sensitive details are never placed here. */
@error
model ErrorResponse {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<unknown>;
}
