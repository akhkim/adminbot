// Characterization coverage for the cheap pure seam of the policy-preflight fragment.
// collectAttemptExplicitToolAllowlistSources and
// loadAttemptSessionEntryAfterQuotaMaintenance need config/session-store harnesses and
// stay covered through the full runner instead.
import { describe, expect, it } from "vitest";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import { pluginMetadataSnapshotCoversProvider } from "./attempt.policy-preflight.js";

const snapshot = (plugins: unknown[]): PluginMetadataSnapshot =>
  ({ manifestRegistry: { plugins } }) as unknown as PluginMetadataSnapshot;

describe("pluginMetadataSnapshotCoversProvider", () => {
  it("matches a provider a plugin declares directly", () => {
    expect(
      pluginMetadataSnapshotCoversProvider(snapshot([{ providers: ["openai"] }]), "openai"),
    ).toBe(true);
  });

  it("matches through the model catalog's providers and aliases", () => {
    const catalogSnapshot = snapshot([
      { providers: [], modelCatalog: { providers: { anthropic: {} }, aliases: { claude: {} } } },
    ]);

    expect(pluginMetadataSnapshotCoversProvider(catalogSnapshot, "anthropic")).toBe(true);
    expect(pluginMetadataSnapshotCoversProvider(catalogSnapshot, "claude")).toBe(true);
    expect(pluginMetadataSnapshotCoversProvider(catalogSnapshot, "openai")).toBe(false);
  });

  it("is false for a missing snapshot or a provider that normalizes to nothing", () => {
    expect(pluginMetadataSnapshotCoversProvider(undefined, "openai")).toBe(false);
    expect(pluginMetadataSnapshotCoversProvider(snapshot([{ providers: ["openai"] }]), "")).toBe(
      false,
    );
  });

  it("tolerates a plugin with no model catalog", () => {
    expect(pluginMetadataSnapshotCoversProvider(snapshot([{ providers: [] }]), "openai")).toBe(
      false,
    );
  });
});
