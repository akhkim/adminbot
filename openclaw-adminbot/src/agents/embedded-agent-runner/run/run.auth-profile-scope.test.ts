// Characterization coverage for the auth-profile scoping helpers extracted from run.ts.
import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "../../auth/auth-profiles.js";
import {
  createEmptyAuthProfileStore,
  createScopedAuthProfileStore,
  resolveAttemptDispatchApiKey,
  resolveAuthProfileStateProvider,
} from "./run.auth-profile-scope.js";

const store = (value: unknown): AuthProfileStore => value as AuthProfileStore;

const fullStore = () =>
  store({
    version: 2,
    profiles: {
      "anthropic:a": { provider: "anthropic" },
      "openai:b": { provider: "openai" },
    },
    runtimeExternalProfileIds: ["anthropic:a", "openai:b"],
    runtimePersistedProfileIds: ["openai:b"],
  });

describe("resolveAttemptDispatchApiKey", () => {
  it("suppresses the api key whenever a runtime auth state is in play", () => {
    expect(
      resolveAttemptDispatchApiKey({
        apiKeyInfo: { apiKey: "sk-test" } as never,
        runtimeAuthState: {} as never,
      }),
    ).toBeUndefined();
  });

  it("returns the resolved api key when there is no runtime auth state", () => {
    expect(
      resolveAttemptDispatchApiKey({
        apiKeyInfo: { apiKey: "sk-test" } as never,
        runtimeAuthState: null,
      }),
    ).toBe("sk-test");
    expect(
      resolveAttemptDispatchApiKey({ apiKeyInfo: null, runtimeAuthState: null }),
    ).toBeUndefined();
  });
});

describe("createScopedAuthProfileStore", () => {
  it("keeps only the scoped profiles and preserves the store version", () => {
    const scoped = createScopedAuthProfileStore(fullStore(), "openai:b");
    expect(Object.keys(scoped.profiles ?? {})).toEqual(["openai:b"]);
    expect(scoped.version).toBe(2);
  });

  it("drops runtime id-list entries whose profile the scope removed", () => {
    const scoped = createScopedAuthProfileStore(fullStore(), ["openai:b"]);
    expect(scoped.runtimeExternalProfileIds).toEqual(["openai:b"]);
    expect(scoped.runtimePersistedProfileIds).toEqual(["openai:b"]);
  });

  it("omits an empty runtime id list rather than emitting an empty array", () => {
    const scoped = createScopedAuthProfileStore(fullStore(), ["anthropic:a"]);
    expect(scoped.runtimeExternalProfileIds).toEqual(["anthropic:a"]);
    expect(scoped).not.toHaveProperty("runtimePersistedProfileIds");
  });

  it("carries the authoritative flag through, keeping the external list present when set", () => {
    const scoped = createScopedAuthProfileStore(
      store({
        version: 1,
        profiles: { "anthropic:a": { provider: "anthropic" } },
        runtimeExternalProfileIdsAuthoritative: true,
      }),
      "anthropic:a",
    );
    expect(scoped.runtimeExternalProfileIdsAuthoritative).toBe(true);
    expect(scoped.runtimeExternalProfileIds).toEqual([]);
  });

  it("ignores blank ids and unknown ids, collapsing an empty scope to an empty store", () => {
    expect(createScopedAuthProfileStore(fullStore(), ["  ", undefined as never])).toEqual(
      createEmptyAuthProfileStore(),
    );
    expect(createScopedAuthProfileStore(fullStore(), "missing:profile")).toEqual(
      createEmptyAuthProfileStore(),
    );
    expect(createScopedAuthProfileStore(fullStore(), undefined)).toEqual(
      createEmptyAuthProfileStore(),
    );
  });

  it("resets the version to 1 when the scope collapses to empty", () => {
    expect(createScopedAuthProfileStore(fullStore(), undefined).version).toBe(1);
  });
});

describe("resolveAuthProfileStateProvider", () => {
  it("prefers the provider recorded on the profile", () => {
    expect(resolveAuthProfileStateProvider(fullStore(), "openai:b", "fallback")).toBe("openai");
  });

  it("falls back to the id prefix when the profile records no provider", () => {
    expect(
      resolveAuthProfileStateProvider(
        store({ version: 1, profiles: { "openai:b": { provider: "  " } } }),
        "openai:b",
        "fallback",
      ),
    ).toBe("openai");
  });

  it("uses the fallback provider when neither the profile nor the id supplies one", () => {
    expect(resolveAuthProfileStateProvider(createEmptyAuthProfileStore(), ":x", "fallback")).toBe(
      "fallback",
    );
  });
});
