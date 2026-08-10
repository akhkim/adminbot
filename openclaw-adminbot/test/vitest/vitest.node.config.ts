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
    exclude: ["**/*.browser.test.ts", "**/*.e2e.test.ts", "**/*.live.test.ts"],
    environment: "node",
    isolate: false,
  },
);
