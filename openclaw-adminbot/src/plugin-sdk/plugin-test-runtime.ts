// Focused public test helpers for plugin runtime, registry, and setup fixtures.

export { setDefaultChannelPluginRegistryForTests } from "../commands/channels/channel-test-registry.js";
export {
  createEmptyPluginRegistry,
  createPluginRegistry,
  type PluginRecord,
} from "../plugins/manifest/registry.js";
export {
  providerContractLoadError,
  pluginRegistrationContractRegistry,
  resolveProviderContractProvidersForPluginIds,
  resolveWebFetchProviderContractEntriesForPluginId,
  resolveWebSearchProviderContractEntriesForPluginId,
} from "../plugins/contracts/registry.js";
export { loadPluginManifestRegistry } from "../plugins/manifest/manifest-registry.js";
export {
  emitDiagnosticEventWithTrustedTraceContext,
  emitInternalDiagnosticEvent as emitInternalDiagnosticEventForTest,
  emitTrustedSecurityEvent,
} from "../infra/diagnostics/diagnostic-events.js";
export { runWithDiagnosticTraceContext } from "../infra/diagnostics/diagnostic-trace-context.js";
export { logMessageDispatchStarted, logMessageProcessed } from "../logging/diagnostic.js";
export { resolveBundledExplicitProviderContractsFromPublicArtifacts } from "../plugins/providers/provider-contract-public-artifacts.js";
export {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hooks/hook-runner-global.js";
export { addTestHook } from "../plugins/hooks/hooks.test-helpers.js";
export { createPluginRecord } from "../plugins/config/status.test-helpers.js";
export {
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
} from "../plugins/web/web-provider-public-artifacts.explicit.js";
export {
  getActivePluginRegistry,
  releasePinnedPluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime/runtime.js";
export {
  listImportedBundledPluginFacadeIds,
  resetFacadeRuntimeStateForTest,
} from "./facade-runtime.js";
export { capturePluginRegistration } from "../plugins/captured-registration.js";
export { clearHealthChecksForTest } from "../flows/health-check-registry.js";
export { runProviderCatalog } from "../plugins/providers/provider-discovery.js";
export { onTrustedInternalDiagnosticEvent } from "../infra/diagnostics/diagnostic-events.js";
export {
  buildProviderPluginMethodChoice,
  resolveProviderModelPickerEntries,
  resolveProviderWizardOptions,
  setProviderWizardProvidersResolverForTest,
} from "../plugins/providers/provider-wizard.js";
export { resolveProviderPluginChoice } from "../plugins/providers/provider-auth-choice.runtime.js";
export {
  clearEmbeddingProviders,
  getRegisteredEmbeddingProvider,
  listRegisteredEmbeddingProviders,
  registerEmbeddingProvider,
  restoreRegisteredEmbeddingProviders,
  type RegisteredEmbeddingProvider,
} from "../plugins/embedding/embedding-providers.js";
export {
  clearMemoryEmbeddingProviders,
  listRegisteredMemoryEmbeddingProviders,
  restoreRegisteredMemoryEmbeddingProviders,
  type RegisteredMemoryEmbeddingProvider,
} from "../plugins/memory-embedding-providers.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { PluginHookRegistration } from "../plugins/hooks/hook-types.js";
export type { RuntimeEnv } from "../runtime.js";
export type { MockFn } from "../test-utils/vitest-mock-fn.js";
export { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
export { readQueuedEntries as readQueuedDeliveryEntriesForTest } from "../infra/outbound/delivery-queue.test-helpers.js";
export {
  registerProviderPlugin,
  registerProviderPlugins,
  registerSingleProviderPlugin,
  requireRegisteredProvider,
  type RegisteredProviderCollections,
} from "../test-utils/plugin-registration.js";
export {
  createNonExitingRuntimeEnv,
  createNonExitingTypedRuntimeEnv,
  createRuntimeEnv,
  createTypedRuntimeEnv,
} from "../test-utils/plugin-runtime-env.js";
export {
  createPluginSetupWizardAdapter,
  createPluginSetupWizardConfigure,
  createPluginSetupWizardStatus,
  createQueuedWizardPrompter,
  createSetupWizardAdapter,
  createTestWizardPrompter,
  promptSetupWizardAllowFrom,
  resolveSetupWizardAllowFromEntries,
  resolveSetupWizardGroupAllowlist,
  runSetupWizardConfigure,
  runSetupWizardFinalize,
  runSetupWizardPrepare,
  selectFirstWizardOption,
  type WizardPrompter,
} from "../test-utils/plugin-setup-wizard.js";
export { createMockPluginRegistry } from "../plugins/hooks/hooks.test-helpers.js";
export { buildPluginApi } from "../plugins/api-builder.js";
export {
  createCapturedPluginRegistration,
  type CapturedPluginRegistration,
} from "../plugins/captured-registration.js";
export { createRuntimeTaskFlow } from "../plugins/runtime/runtime-taskflow.js";
