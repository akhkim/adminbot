// Mocks plugin-backed provider usage runtime for tests.
import { vi } from "vitest";

const resolveProviderUsageSnapshotWithPluginMock = vi.hoisted(() =>
  vi.fn<
    typeof import("../../plugins/providers/provider-runtime.js").resolveProviderUsageSnapshotWithPlugin
  >(async () => null),
);

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
}));

vi.mock("../../plugins/providers/provider-runtime.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../plugins/providers/provider-runtime.js")
  >("../../plugins/providers/provider-runtime.js");
  return {
    ...actual,
    resolveProviderUsageSnapshotWithPlugin: resolveProviderUsageSnapshotWithPluginMock,
  };
});

/** Resets the plugin-backed provider usage mock to the default no-snapshot behavior. */
export function resetProviderUsageSnapshotWithPluginMock() {
  resolveProviderUsageSnapshotWithPluginMock.mockReset();
  resolveProviderUsageSnapshotWithPluginMock.mockResolvedValue(null);
}

export function getProviderUsageSnapshotWithPluginMock() {
  return resolveProviderUsageSnapshotWithPluginMock;
}
