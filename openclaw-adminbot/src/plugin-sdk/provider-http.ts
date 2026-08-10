// Shared provider-facing HTTP helpers. Keep generic transport utilities here so
// capability SDKs do not depend on each other.

export {
  assertOkOrThrowHttpError,
  assertOkOrThrowProviderError,
  assertProviderBinaryResponseContent,
  createProviderHttpError,
  extractProviderErrorDetail,
  extractProviderRequestId,
  formatProviderErrorPayload,
  formatProviderHttpErrorMessage,
  readProviderBinaryResponse,
  readProviderJsonArrayFieldResponse,
  readProviderJsonObjectResponse,
  readProviderJsonResponse,
  readResponseTextLimited,
  truncateErrorDetail,
} from "../agents/transport/provider-http-errors.js";
export { fetchWithTimeoutGuarded } from "../infra/net/provider-fetch.js";
export {
  executeProviderOperationWithRetry,
  providerOperationRetryConfig,
} from "../provider-runtime/operation-retry.js";
export type {
  ProviderOperationRetryStage,
  TransientProviderRetryConfig,
  TransientProviderRetryOptions,
  TransientProviderRetryParams,
} from "../provider-runtime/operation-retry.js";
export type {
  ProviderAttributionPolicy,
  ProviderRequestCapabilities,
  ProviderRequestCapabilitiesInput,
  ProviderRequestCompatibilityFamily,
  ProviderEndpointClass,
  ProviderEndpointResolution,
  ProviderRequestCapability,
  ProviderRequestPolicyInput,
  ProviderRequestPolicyResolution,
  ProviderRequestTransport,
} from "../agents/transport/provider-attribution.js";
export type {
  ProviderRequestAuthOverride,
  ProviderRequestProxyOverride,
  ProviderRequestTlsOverride,
  ProviderRequestTransportOverrides,
} from "../agents/transport/provider-request-config.js";
export { resolveProviderRequestHeaders } from "../agents/transport/provider-request-config.js";
export {
  resolveProviderEndpoint,
  resolveProviderRequestCapabilities,
  resolveProviderRequestPolicy,
} from "../agents/transport/provider-attribution.js";
