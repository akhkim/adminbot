/**
 * Run stage: auth-profile scoping.
 *
 * A run may only use the auth profiles it was scoped to, so the shared store is
 * narrowed to that set before it reaches the attempt — including the runtime
 * external/persisted id lists, which must not name a profile the scoped copy
 * dropped. An empty scope collapses to an empty store rather than the full one.
 */
import type { AuthProfileStore } from "../../auth/auth-profiles.js";
import type { ResolvedProviderAuth } from "../../auth/model-auth.js";
import type { RuntimeAuthState } from "./helpers.js";

export type ApiKeyInfo = ResolvedProviderAuth;

export function resolveAttemptDispatchApiKey(params: {
  apiKeyInfo: ApiKeyInfo | null;
  runtimeAuthState: RuntimeAuthState | null;
}): string | undefined {
  if (params.runtimeAuthState) {
    return undefined;
  }
  return params.apiKeyInfo?.apiKey;
}

export function createEmptyAuthProfileStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {},
  };
}

export function createScopedAuthProfileStore(
  store: AuthProfileStore,
  profileIds: string | undefined | string[],
): AuthProfileStore {
  const profiles = store.profiles ?? {};
  const normalizedProfileIds = (Array.isArray(profileIds) ? profileIds : [profileIds])
    .map((profileId) => profileId?.trim())
    .filter((profileId): profileId is string => Boolean(profileId));
  const scopedProfiles = Object.fromEntries(
    normalizedProfileIds.flatMap((profileId) => {
      const credential = profiles[profileId];
      return credential ? [[profileId, credential] as const] : [];
    }),
  );
  const scopedRuntimeExternalProfileIds = (store.runtimeExternalProfileIds ?? []).filter(
    (profileId) => scopedProfiles[profileId],
  );
  const scopedRuntimePersistedProfileIds = (store.runtimePersistedProfileIds ?? []).filter(
    (profileId) => scopedProfiles[profileId],
  );
  return Object.keys(scopedProfiles).length > 0
    ? {
        version: store.version,
        profiles: scopedProfiles,
        ...(scopedRuntimePersistedProfileIds.length > 0
          ? { runtimePersistedProfileIds: scopedRuntimePersistedProfileIds }
          : {}),
        ...(scopedRuntimeExternalProfileIds.length > 0 ||
        store.runtimeExternalProfileIdsAuthoritative === true
          ? { runtimeExternalProfileIds: scopedRuntimeExternalProfileIds }
          : {}),
        ...(store.runtimeExternalProfileIdsAuthoritative === true
          ? { runtimeExternalProfileIdsAuthoritative: true }
          : {}),
      }
    : createEmptyAuthProfileStore();
}

export function resolveAuthProfileStateProvider(
  store: AuthProfileStore,
  profileId: string,
  fallbackProvider: string,
): string {
  const profileProvider = store.profiles?.[profileId]?.provider?.trim();
  if (profileProvider) {
    return profileProvider;
  }
  const idProvider = profileId.split(":", 1)[0]?.trim();
  return idProvider || fallbackProvider;
}
