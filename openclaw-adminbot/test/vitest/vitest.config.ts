// Root Vitest config.
//
// Upstream sharded its suite across ~60 named lanes because it ran them as separate CI jobs.
// AdminBot has no CI and runs tests locally, so the whole suite is two projects: a node lane for
// everything under src/, extensions/ and packages/, and a jsdom lane for the Control UI.
//
// Use `pnpm test <path>` to scope a run; the lanes narrow their include patterns from the CLI
// argument, so a single-file run does not load the rest of the suite.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { jsdomOptimizedDeps } from "./vitest.shared.config.ts";

export {
  resolveDefaultVitestPool,
  resolveLocalVitestMaxWorkers,
  resolveLocalVitestScheduling,
} from "./vitest.shared.config.ts";

export const rootVitestProjects = [
  "test/vitest/vitest.node.config.ts",
  "test/vitest/vitest.ui.config.ts",
];

export default createScopedVitestConfig(
  [
    "src/**/*.test.ts",
    "extensions/**/*.test.ts",
    "packages/**/*.test.ts",
    "test/scripts/**/*.test.ts",
    "ui/src/**/*.test.ts",
  ],
  {
    name: "openclaw",
    // Browser-only specs need jsdom; they run in the ui lane instead.
    exclude: ["**/*.browser.test.ts", "**/*.e2e.test.ts", "**/*.live.test.ts"],
    deps: jsdomOptimizedDeps,
    environment: "node",
    isolate: false,
  },
);
