export const apiErrorCodes = Object.freeze([
  "not_authenticated",
  "account_pending_approval",
  "not_authorized",
  "not_found",
  "conflict",
  "payload_invalid",
  "state_invalid",
  "policy_denied",
  "policy_changed",
  "approval_hash_mismatch",
  "approval_quorum_missing",
  "connector_unavailable",
  "effect_uncertain",
  "privacy_route_denied",
  "rate_limited",
  "dependency_unavailable",
  "internal_error",
] as const);

export type ApiErrorCode = (typeof apiErrorCodes)[number];

const apiErrorCodeSet = new Set<string>(apiErrorCodes);

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && apiErrorCodeSet.has(value);
}
