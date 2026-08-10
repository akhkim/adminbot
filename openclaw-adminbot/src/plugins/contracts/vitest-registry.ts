// Vitest registry helpers load bundled capability runtimes for contract tests.
//
// Was speech-vitest-registry.ts, covering the speech, realtime, media-understanding and
// image/video/music generation capabilities. All of those were removed with their subsystems;
// transcript sources are the one capability left that still needs a contract-test loader.
import { loadBundledCapabilityRuntimeRegistry } from "../install/bundled-capability-runtime.js";
import type { TranscriptSourceProvider } from "../types.js";
import { BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS } from "./inventory/bundled-capability-metadata.js";

type TranscriptsSourceProviderContractEntry = {
  pluginId: string;
  provider: TranscriptSourceProvider;
};

const TRANSCRIPT_SOURCE_CONTRACT_PLUGIN_IDS = BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter(
  (entry) => entry.transcriptSourceProviderIds.length > 0,
).map((entry) => entry.pluginId);

/**
 * Loads transcript-source providers in bulk, falling back to per-plugin loads when the bulk read
 * misses a plugin — a plugin whose runtime throws must not hide the others.
 */
export function loadVitestTranscriptsSourceProviderContractRegistry(): TranscriptsSourceProviderContractEntry[] {
  const pluginIds = [...TRANSCRIPT_SOURCE_CONTRACT_PLUGIN_IDS];
  if (pluginIds.length === 0) {
    return [];
  }
  const pick = (ids: readonly string[]) =>
    loadBundledCapabilityRuntimeRegistry({
      pluginIds: [...ids],
      pluginSdkResolution: "src",
    }).transcriptSourceProviders.map((entry) => ({
      pluginId: entry.pluginId,
      provider: entry.provider,
    }));

  const bulkEntries = pick(pluginIds);
  const coveredPluginIds = new Set(bulkEntries.map((entry) => entry.pluginId));
  if (coveredPluginIds.size === pluginIds.length) {
    return bulkEntries;
  }
  return pluginIds.flatMap((pluginId) =>
    pick([pluginId]).filter((entry) => entry.pluginId === pluginId),
  );
}
