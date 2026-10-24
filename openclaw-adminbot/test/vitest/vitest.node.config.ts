// Node lane: everything outside the Control UI.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export default createScopedVitestConfig(
  [
    "src/**/*.test.ts",
    "extensions/**/*.test.ts",
    "packages/**/*.test.ts",
    "test/scripts/**/*.test.ts",
  ],
  {
    name: "node",
    // The CLI package tests with node:test (`pnpm --filter @adminbot/cli test`, run by the
    // AdminBot API workflow). Vitest would import those files and find no suite.
    exclude: [
      "**/*.browser.test.ts",
      "**/*.e2e.test.ts",
      "**/*.live.test.ts",
      "extensions/adminbot/cli/**",
    ],
    environment: "node",
    isolate: false,
  },
);
