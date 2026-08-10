// Focused public test helpers for environment, network, and time fixtures.

export {
  createSingleUserPromptMessage,
  extractNonEmptyAssistantText,
  isLiveProfileKeyModeEnabled,
  isLiveTestEnabled,
} from "../agents/live-test-helpers.js";
export { collectProviderApiKeys } from "../agents/auth/live-auth-keys.js";
export { isModelNotFoundErrorMessage } from "../agents/models/live-model-errors.js";
export {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
} from "../agents/embedded-agent-helpers/failover-matches.js";
export { maybeLoadShellEnvForGenerationProviders } from "../test-utils/generation-live-test-helpers.js";
export { isTruthyEnvValue } from "../infra/env.js";
export { getShellEnvAppliedKeys } from "../infra/system/shell-env.js";
export { encodePngRgba, fillPixel } from "../media/png-encode.js";
export { jsonResponse, requestBodyText, requestUrl } from "../test-helpers/http.js";
export { mockPinnedHostnameResolution } from "../test-helpers/ssrf.js";
export { createWindowsCmdShimFixture } from "../test-helpers/windows-cmd-shim.js";
export { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
export { withStateDirEnv } from "../test-helpers/state-dir-env.js";
export { captureEnv, withEnv, withEnvAsync } from "../test-utils/env.js";
export { withFetchPreconnect, type FetchMock } from "../test-utils/fetch-mock.js";
export { createMockServerResponse } from "../test-utils/mock-http-response.js";
export { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
export { withTempDir } from "../test-utils/temp-dir.js";
export { useFrozenTime, useRealTime } from "../test-utils/frozen-time.js";
export { withServer } from "./test-helpers/http-test-server.js";
export { createMockIncomingRequest } from "./test-helpers/mock-incoming-request.js";
export { withTempHome } from "./test-helpers/temp-home.js";
