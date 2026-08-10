/**
 * Knip configuration for OpenClaw root and bundled plugin dependency hygiene.
 */
const BUNDLED_PLUGIN_ROOT_DIR = "extensions";

const rootEntries = [
  "openclaw.mjs!",
  "src/index.ts!",
  "src/entry.ts!",
  "src/cli/daemon-cli/daemon-cli.ts!",
  "src/agents/tools/code-mode.worker.ts!",
  "src/agents/auth/model-provider-auth.worker.ts!",
  "src/infra/state/kysely-node-sqlite.ts!",
  "src/infra/warning-filter.ts!",
  "src/infra/command-explainer/index.ts!",
  "src/hooks/bundled/*/handler.ts!",
  "src/hooks/llm-slug-generator.ts!",
  "src/plugin-sdk/*.ts!",
] as const;

const bundledPluginEntries = [
  "*.ts!",
  "index.ts!",
  "setup-entry.ts!",
  "{api,contract-api,helper-api,runtime-api,light-runtime-api,update-offset-runtime-api,channel-plugin-api,provider-plugin-api,setup-api}.ts!",
  "subagent-hooks-api.ts!",
  "src/{api,runtime-api,light-runtime-api,update-offset-runtime-api,channel-plugin-api,provider-plugin-api,doctor-contract,setup-surface,mcp-serve}.ts!",
  "src/subagent-hooks-api.ts!",
] as const;

// Runtime dependencies the surviving bundled plugins resolve dynamically, so
// Knip's static pass cannot see them. Only packages that a surviving plugin
// manifest actually declares belong here.
const bundledPluginIgnoredRuntimeDependencies = ["json5", "openclaw"] as const;

// Root dependencies that only bundled plugins reach, via dynamic import or
// host injection. Every entry must exist in the root manifest.
const rootBundledPluginRuntimeDependencies = [
  "@anthropic-ai/sdk",
  "@google/genai",
  "@grammyjs/runner",
  "@grammyjs/transformer-throttler",
  "@homebridge/ciao",
  "@mozilla/readability",
  "grammy",
  "linkedom",
  "minimatch",
  "node-edge-tts",
  "clawpdf",
] as const;

const config = {
  ignoreFiles: [
    "scripts/**",
    "packages/*/dist/**",
    "**/__tests__/**",
    "src/test-utils/**",
    "**/test-helpers/**",
    "**/test-fixtures/**",
    "**/test-support/**",
    "**/live-*.ts",
    "**/test-*.ts",
    "**/vitest*.{ts,mjs}",
    "**/*test-helpers.ts",
    "**/*test-fixtures.ts",
    "**/*test-harness.ts",
    "**/*test-utils.ts",
    "**/*test-support.ts",
    "**/*test-shared.ts",
    "**/*mocks.ts",
    "**/*.e2e-mocks.ts",
    "**/*.e2e-*.ts",
    "**/*.fixture-test-support.ts",
    "**/*.harness.ts",
    "**/*.job-fixtures.ts",
    "**/*.mock-harness.ts",
    "**/*.menu-test-support.ts",
    "**/*.suite-helpers.ts",
    "**/*.test-setup.ts",
    "**/job-fixtures.ts",
    "**/*test-mocks.ts",
    "**/*test-runtime*.ts",
    "**/*.mock-setup.ts",
    "**/*.cases.ts",
    "**/*.e2e-harness.ts",
    "**/*.fixture.ts",
    "**/*.fixtures.ts",
    "**/*.mocks.ts",
    "**/*.mocks.shared.ts",
    "**/*.route-test-support.ts",
    "**/*.shared-test.ts",
    "**/*.suite.ts",
    "**/*.test-runtime.ts",
    "**/*.testkit.ts",
    "**/*.test-fixtures.ts",
    "**/*.test-harness.ts",
    "**/*.test-helper.ts",
    "**/*.test-helpers.ts",
    "**/*.test-mocks.ts",
    "**/*.test-utils.ts",
    "test/helpers/live-image-probe.ts",
    "src/secrets/credential-matrix.ts",
    "src/gateway/live-tool-probe-utils.ts",
    "src/gateway/server/server.auth.shared.ts",
    "src/shared/text/assistant-visible-text.ts",
  ],
  ignore: ["packages/*/dist/**"],
  workspaces: {
    ".": {
      entry: rootEntries,
      ignoreDependencies: [
        "@openclaw/*",
        "file-type",
        "playwright-core",
        "sqlite-vec",
        "tree-sitter-bash",
        ...rootBundledPluginRuntimeDependencies,
      ],
      project: [
        "src/**/*.ts!",
        "scripts/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "*.config.{js,mjs,cjs,ts,mts,cts}!",
        "*.mjs!",
      ],
    },
    ui: {
      entry: [
        "index.html!",
        "src/main.ts!",
        "src/ui/browser-redact.ts!",
        "vite.config.ts!",
        "vitest*.ts!",
      ],
      // Workboard lazy-loads Three.js at runtime; Knip's dependency pass misses it.
      ignoreDependencies: ["three"],
      project: ["src/**/*.{ts,tsx}!"],
    },
    "packages/agent-core": {
      entry: ["src/index.ts!", "src/*.ts!", "src/harness/**/*.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/gateway-client": {
      entry: ["src/index.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/gateway-protocol": {
      entry: ["src/index.ts!", "src/schema.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/net-policy": {
      entry: ["src/index.ts!", "src/ip.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/markdown-core": {
      entry: ["src/*.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/media-core": {
      entry: ["src/*.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/acp-core": {
      entry: ["src/*.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/terminal-core": {
      entry: ["src/*.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/*": {
      entry: ["src/index.ts!", "src/*.ts!"],
      project: ["src/**/*.ts!"],
    },
    [`${BUNDLED_PLUGIN_ROOT_DIR}/*`]: {
      // Bundled plugins often load their public surface via string specifiers in
      // `index.ts` contracts, so Knip needs these convention-based entry files.
      entry: bundledPluginEntries,
      project: ["index.ts!", "src/**/*.{js,mjs,ts}!"],
      ignoreDependencies: bundledPluginIgnoredRuntimeDependencies,
    },
  },
} as const;

export default config;
