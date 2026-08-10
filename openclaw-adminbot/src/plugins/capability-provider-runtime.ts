/** Resolves plugin capability providers through manifest contracts, bundled compat, and runtime registries. */
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types/openclaw.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { loadBundledCapabilityRuntimeRegistry } from "./install/bundled-capability-runtime.js";
import {
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "./install/bundled-compat.js";
import {
  hasManifestContractValue,
  isManifestPluginAvailableForControlPlane,
  loadManifestContractSnapshot,
  listAvailableManifestContractValues,
} from "./manifest/manifest-contract-eligibility.js";
import type { PluginRegistry } from "./manifest/registry-types.js";
import {
  resolveConfigScopedRuntimeCacheValue,
  type ConfigScopedRuntimeCache,
} from "./plugin-cache-primitives.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import {
  resolvePluginRegistryLoadCacheKey,
  resolveRuntimePluginRegistry,
  type PluginLoadOptions,
} from "./runtime/loader.js";

type CapabilityProviderRegistryKey =
  | "embeddingProviders"
  | "memoryEmbeddingProviders"
  | "transcriptSourceProviders";

type CapabilityContractKey =
  | "embeddingProviders"
  | "memoryEmbeddingProviders"
  | "transcriptSourceProviders";

type CapabilityProviderForKey<K extends CapabilityProviderRegistryKey> =
  PluginRegistry[K][number] extends { provider: infer T } ? T : never;
type CapabilityProviderEntries = PluginRegistry[CapabilityProviderRegistryKey];
type CapabilityPluginResolution = {
  runtimePluginIds: string[];
  bundledCompatPluginIds: string[];
};

const capabilityProviderSnapshotCache: ConfigScopedRuntimeCache<CapabilityProviderEntries> =
  new WeakMap();

const CAPABILITY_CONTRACT_KEY: Record<CapabilityProviderRegistryKey, CapabilityContractKey> = {
  embeddingProviders: "embeddingProviders",
  memoryEmbeddingProviders: "memoryEmbeddingProviders",
  transcriptSourceProviders: "transcriptSourceProviders",
};

// Every capability that opted out of the globally-disabled check, or merged manifest providers
// while active, was a media or speech capability. What survives follows the plain rule: plugins
// off means no providers resolve.
function shouldSkipCapabilityResolution(params: { cfg?: OpenClawConfig }): boolean {
  return params.cfg?.plugins?.enabled === false;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return sortUniqueStrings(values);
}

/** Loads the manifest snapshot used to resolve capability-provider ownership. */
export function loadCapabilityManifestSnapshot(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
}): Pick<PluginMetadataSnapshot, "index" | "plugins"> {
  return loadManifestContractSnapshot({
    config: params.cfg,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
}

function resolveCapabilityPluginIds(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerId?: string;
}): CapabilityPluginResolution {
  const contractKey = CAPABILITY_CONTRACT_KEY[params.key];
  const snapshot = loadCapabilityManifestSnapshot(params);
  const contractPlugins = snapshot.plugins.filter((plugin) =>
    hasManifestContractValue({
      plugin,
      contract: contractKey,
      value: params.providerId,
    }),
  );
  return {
    runtimePluginIds: uniqueSorted(
      contractPlugins
        .filter((plugin) =>
          isManifestPluginAvailableForControlPlane({
            snapshot,
            plugin,
            config: params.cfg,
          }),
        )
        .map((plugin) => plugin.id),
    ),
    bundledCompatPluginIds: uniqueSorted(
      contractPlugins.filter((plugin) => plugin.origin === "bundled").map((plugin) => plugin.id),
    ),
  };
}

function resolveBundledCapabilityCompatPluginIds(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerId?: string;
}): string[] {
  return resolveCapabilityPluginIds(params).bundledCompatPluginIds;
}

export function resolveManifestCapabilityProviderIds(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
}): string[] {
  const contractKey = CAPABILITY_CONTRACT_KEY[params.key];
  return listAvailableManifestContractValues({
    snapshot: loadCapabilityManifestSnapshot(params),
    contract: contractKey,
    config: params.cfg,
  });
}

export function resolveBundledCapabilityProviderIds(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
}): string[] {
  const contractKey = CAPABILITY_CONTRACT_KEY[params.key];
  const snapshot = loadCapabilityManifestSnapshot(params);
  return uniqueSorted(
    snapshot.plugins.flatMap((plugin) =>
      plugin.origin === "bundled" ? (plugin.contracts?.[contractKey] ?? []) : [],
    ),
  );
}

function resolveCapabilityProviderConfig(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  pluginIds?: string[];
}) {
  const pluginIds = params.pluginIds ?? resolveBundledCapabilityCompatPluginIds(params);
  const enablementCompat = withBundledPluginEnablementCompat({
    config: params.cfg,
    pluginIds,
  });
  return withBundledPluginVitestCompat({
    config: enablementCompat,
    pluginIds,
    env: process.env,
  });
}

function createCapabilityProviderFallbackLoadOptions(params: {
  compatConfig?: OpenClawConfig;
  pluginIds: string[];
}): PluginLoadOptions {
  return {
    ...(params.compatConfig === undefined ? {} : { config: params.compatConfig }),
    onlyPluginIds: params.pluginIds,
    activate: false,
  };
}

function resolveCapabilityProviderSnapshotCacheKey(params: {
  key: CapabilityProviderRegistryKey;
  loadOptions: PluginLoadOptions;
}): string {
  return JSON.stringify({
    key: params.key,
    load: resolvePluginRegistryLoadCacheKey(params.loadOptions),
  });
}

function findProviderById<K extends CapabilityProviderRegistryKey>(
  entries: PluginRegistry[K],
  providerId: string,
): CapabilityProviderForKey<K> | undefined {
  const providerEntries = entries as unknown as Array<{
    provider: CapabilityProviderForKey<K> & { id?: unknown };
  }>;
  for (const entry of providerEntries) {
    if (entry.provider.id === providerId) {
      return entry.provider;
    }
  }
  return undefined;
}

function mergeCapabilityProviders<K extends CapabilityProviderRegistryKey>(
  left: PluginRegistry[K],
  right: PluginRegistry[K],
): CapabilityProviderForKey<K>[] {
  const merged = new Map<string, CapabilityProviderForKey<K>>();
  const unnamed: CapabilityProviderForKey<K>[] = [];
  const addEntries = (entries: PluginRegistry[K]) => {
    for (const entry of entries) {
      const provider = entry.provider as CapabilityProviderForKey<K> & { id?: string };
      if (!provider.id) {
        unnamed.push(provider);
        continue;
      }
      if (!merged.has(provider.id)) {
        merged.set(provider.id, provider);
      }
    }
  };

  addEntries(left);
  addEntries(right);
  return [...merged.values(), ...unnamed];
}

function mergeCapabilityProviderEntries<K extends CapabilityProviderRegistryKey>(
  left: PluginRegistry[K],
  right: PluginRegistry[K],
): PluginRegistry[K] {
  const merged = new Map<string, PluginRegistry[K][number]>();
  const unnamed: Array<PluginRegistry[K][number]> = [];
  const addEntries = (entries: PluginRegistry[K]) => {
    for (const entry of entries) {
      const provider = entry.provider as { id?: string };
      if (!provider.id) {
        unnamed.push(entry);
        continue;
      }
      if (!merged.has(provider.id)) {
        merged.set(provider.id, entry);
      }
    }
  };

  addEntries(left);
  addEntries(right);
  return [...merged.values(), ...unnamed] as PluginRegistry[K];
}

// Only the speech, realtime and media-understanding capabilities ever derived requested
// provider ids from config; the survivors resolve every registered provider.
function collectRequestedCapabilityProviderIds(_params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
}): Set<string> | undefined {
  return undefined;
}

function nonEmptyRequestedProviders(requested: Set<string> | undefined): Set<string> | undefined {
  return requested && requested.size > 0 ? requested : undefined;
}

function removeActiveProviderIds(requested: Set<string>, entries: readonly unknown[]): void {
  for (const entry of entries as Array<{ provider: { id?: unknown; aliases?: unknown } }>) {
    const provider = entry.provider as { id?: unknown; aliases?: unknown };
    if (typeof provider.id === "string") {
      requested.delete(provider.id.toLowerCase());
    }
    if (Array.isArray(provider.aliases)) {
      for (const alias of provider.aliases) {
        if (typeof alias === "string") {
          requested.delete(alias.toLowerCase());
        }
      }
    }
  }
}

function resolveRequestedCapabilityPluginIds(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
  requested?: Set<string>;
}): CapabilityPluginResolution | undefined {
  if (!params.requested || params.requested.size === 0) {
    return undefined;
  }
  const runtimePluginIds = new Set<string>();
  const bundledCompatPluginIds = new Set<string>();
  for (const providerId of params.requested) {
    const resolution = resolveCapabilityPluginIds({
      key: params.key,
      cfg: params.cfg,
      providerId,
    });
    for (const pluginId of resolution.runtimePluginIds) {
      runtimePluginIds.add(pluginId);
    }
    for (const pluginId of resolution.bundledCompatPluginIds) {
      bundledCompatPluginIds.add(pluginId);
    }
  }
  return runtimePluginIds.size > 0
    ? {
        runtimePluginIds: uniqueSorted(runtimePluginIds),
        bundledCompatPluginIds: uniqueSorted(bundledCompatPluginIds),
      }
    : undefined;
}

function loadCapabilityProviderEntries<K extends CapabilityProviderRegistryKey>(params: {
  key: K;
  bundledCompatPluginIds: string[];
  loadOptions: PluginLoadOptions;
  requested?: Set<string>;
}): PluginRegistry[K] {
  const loadedRegistry = getLoadedRuntimePluginRegistry({
    env: params.loadOptions.env,
    loadOptions: params.loadOptions,
    workspaceDir: params.loadOptions.workspaceDir,
    requiredPluginIds: params.loadOptions.onlyPluginIds,
  });
  const loadedEntries = loadedRegistry?.[params.key] ?? [];
  const coldRegistry = loadedRegistry
    ? undefined
    : resolveRuntimePluginRegistry(params.loadOptions);
  const coldEntries = coldRegistry?.[params.key] ?? [];
  const entries =
    loadedEntries.length > 0 && coldEntries.length > 0
      ? mergeCapabilityProviderEntries(loadedEntries, coldEntries)
      : loadedEntries.length > 0
        ? loadedEntries
        : coldEntries;
  const missingRequested =
    params.requested && params.requested.size > 0 ? new Set(params.requested) : undefined;
  if (missingRequested) {
    removeActiveProviderIds(missingRequested, entries);
  }
  if (entries.length > 0 && (!missingRequested || missingRequested.size === 0)) {
    return entries;
  }
  if (params.bundledCompatPluginIds.length === 0) {
    return entries;
  }
  const captured = loadBundledCapabilityRuntimeRegistry({
    pluginIds: params.bundledCompatPluginIds,
    env: process.env,
    pluginSdkResolution: params.loadOptions.pluginSdkResolution,
  })[params.key] as PluginRegistry[K];
  return entries.length > 0 ? mergeCapabilityProviderEntries(entries, captured) : captured;
}

export function resolvePluginCapabilityProvider<K extends CapabilityProviderRegistryKey>(params: {
  key: K;
  providerId: string;
  cfg?: OpenClawConfig;
}): CapabilityProviderForKey<K> | undefined {
  if (shouldSkipCapabilityResolution(params)) {
    return undefined;
  }

  const activeRegistry = getLoadedRuntimePluginRegistry();
  const activeProvider = findProviderById(activeRegistry?.[params.key] ?? [], params.providerId);
  if (activeProvider) {
    return activeProvider;
  }

  const pluginIds = resolveCapabilityPluginIds({
    key: params.key,
    cfg: params.cfg,
    providerId: params.providerId,
  });
  if (pluginIds.runtimePluginIds.length === 0) {
    return undefined;
  }

  const compatConfig = resolveCapabilityProviderConfig({
    key: params.key,
    cfg: params.cfg,
    pluginIds: pluginIds.bundledCompatPluginIds,
  });
  const loadOptions = createCapabilityProviderFallbackLoadOptions({
    compatConfig,
    pluginIds: pluginIds.runtimePluginIds,
  });
  const loadedProviders = resolveConfigScopedRuntimeCacheValue({
    cache: capabilityProviderSnapshotCache,
    config: params.cfg,
    key: resolveCapabilityProviderSnapshotCacheKey({ key: params.key, loadOptions }),
    load: () =>
      loadCapabilityProviderEntries({
        key: params.key,
        bundledCompatPluginIds: pluginIds.bundledCompatPluginIds,
        loadOptions,
        requested: new Set([params.providerId.toLowerCase()]),
      }) as CapabilityProviderEntries,
  }) as PluginRegistry[K];
  return findProviderById(loadedProviders, params.providerId);
}

function resolveCachedCapabilityProviderEntries<K extends CapabilityProviderRegistryKey>(params: {
  key: K;
  cfg?: OpenClawConfig;
  bundledCompatPluginIds: string[];
  loadOptions: PluginLoadOptions;
  requested?: Set<string>;
}): PluginRegistry[K] {
  return resolveConfigScopedRuntimeCacheValue({
    cache: capabilityProviderSnapshotCache,
    config: params.cfg,
    key: resolveCapabilityProviderSnapshotCacheKey({
      key: params.key,
      loadOptions: params.loadOptions,
    }),
    load: () =>
      loadCapabilityProviderEntries({
        key: params.key,
        bundledCompatPluginIds: params.bundledCompatPluginIds,
        loadOptions: params.loadOptions,
        requested: params.requested,
      }) as CapabilityProviderEntries,
  }) as PluginRegistry[K];
}

export function resolvePluginCapabilityProviders<K extends CapabilityProviderRegistryKey>(params: {
  key: K;
  cfg?: OpenClawConfig;
}): CapabilityProviderForKey<K>[] {
  if (shouldSkipCapabilityResolution(params)) {
    return [];
  }

  const activeRegistry = getLoadedRuntimePluginRegistry();
  const activeProviders = activeRegistry?.[params.key] ?? [];
  const missingRequestedProviders =
    activeProviders.length > 0
      ? nonEmptyRequestedProviders(
          collectRequestedCapabilityProviderIds({
            key: params.key,
            cfg: params.cfg,
          }),
        )
      : undefined;
  if (activeProviders.length > 0 && params.key !== "memoryEmbeddingProviders") {
    if (!missingRequestedProviders) {
      return activeProviders.map((entry) => entry.provider) as CapabilityProviderForKey<K>[];
    }
    if (missingRequestedProviders) {
      removeActiveProviderIds(missingRequestedProviders, activeProviders);
      if (missingRequestedProviders.size === 0) {
        return activeProviders.map((entry) => entry.provider) as CapabilityProviderForKey<K>[];
      }
    }
  }
  const requestedProviders =
    missingRequestedProviders ??
    (activeProviders.length === 0
      ? nonEmptyRequestedProviders(
          collectRequestedCapabilityProviderIds({ key: params.key, cfg: params.cfg }),
        )
      : undefined);
  // Only speech and realtime ever scoped the plugin load to requested provider ids.
  const requestedProviderLoadScope = undefined;
  const requestedPluginIds = resolveRequestedCapabilityPluginIds({
    key: params.key,
    cfg: params.cfg,
    requested: requestedProviderLoadScope,
  });
  const requestedProviderFilter = requestedProviders ?? undefined;
  const pluginIds =
    requestedPluginIds ??
    resolveCapabilityPluginIds({
      key: params.key,
      cfg: params.cfg,
    });
  const compatConfig = resolveCapabilityProviderConfig({
    key: params.key,
    cfg: params.cfg,
    pluginIds: pluginIds.bundledCompatPluginIds,
  });
  const loadOptions = createCapabilityProviderFallbackLoadOptions({
    compatConfig,
    pluginIds: pluginIds.runtimePluginIds,
  });
  const loadedProviders = resolveCachedCapabilityProviderEntries({
    key: params.key,
    cfg: params.cfg,
    bundledCompatPluginIds: pluginIds.bundledCompatPluginIds,
    loadOptions,
    requested: requestedProviderFilter,
  });
  // The requested-config filter only narrowed the speech, realtime and media-understanding
  // capabilities; for everything that survives it returned the loaded set unchanged.
  return mergeCapabilityProviders(activeProviders, loadedProviders);
}
