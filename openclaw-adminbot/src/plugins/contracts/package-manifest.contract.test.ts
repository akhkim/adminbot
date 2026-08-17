// Package manifest contract tests cover plugin package manifest requirements.
import { describePackageManifestContract } from "openclaw/plugin-sdk/plugin-test-contracts";

type PackageManifestContractParams = Parameters<typeof describePackageManifestContract>[0];

// Only bundled plugins that ship a `package.json` belong here, and only those
// with something for the contract to assert: a runtime dependency that must stay
// out of the root manifest, or a declared `openclaw.install.minHostVersion`. A
// plugin with neither registers an empty suite, which Vitest reports as a
// failure. The deep clean removed the ~130 upstream plugins this list used to
// cover; `typebox`, `zod`, `chokidar` and `json5` are shared root dependencies
// by design, so they are not plugin-local.
const packageManifestContractTests: PackageManifestContractParams[] = [
  { pluginId: "brave", minHostVersionBaseline: "2026.4.10" },
  {
    pluginId: "slack",
    pluginLocalRuntimeDeps: ["@slack/bolt", "@slack/types", "@slack/web-api"],
    minHostVersionBaseline: "2026.5.28",
  },
];

for (const params of packageManifestContractTests) {
  describePackageManifestContract(params);
}
