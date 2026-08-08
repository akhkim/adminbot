import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    coverage: {
      include: [
        "adapters/**/*.ts",
        "apps/**/*.ts",
        "connectors/**/*.ts",
        "packages/**/*.ts",
        "workflows/**/*.ts",
      ],
    },
    include: [
      "adapters/**/*.test.ts",
      "apps/**/*.test.ts",
      "connectors/**/*.test.ts",
      "packages/**/*.test.ts",
      "workflows/**/*.test.ts",
    ],
    mockReset: true,
    restoreMocks: true,
  },
});
