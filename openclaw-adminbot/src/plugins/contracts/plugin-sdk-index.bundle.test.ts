// Plugin SDK bundle index tests cover bundled SDK export inventory and packaging.
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildPluginSdkEntrySources, pluginSdkEntrypoints } from "../../plugin-sdk/entrypoints.js";
import { createSuiteTempRootTracker } from "../test-helpers/fs-fixtures.js";

const require = createRequire(import.meta.url);
const tsdownModuleUrl = pathToFileURL(require.resolve("tsdown")).href;
const bundledRepresentativeEntrypoints = ["memory-core"] as const;
const bundleTempRootTracker = createSuiteTempRootTracker(
  "openclaw-plugin-sdk-build",
  path.join(process.cwd(), "node_modules", ".cache"),
);
const bundledCoverageEntrySources = buildPluginSdkEntrySources(bundledRepresentativeEntrypoints);

async function expectBuiltJsFile(outDir: string, entry: string): Promise<void> {
  const stat = await fs.stat(path.join(outDir, `${entry}.js`));
  expect(stat.isFile()).toBe(true);
  expect(stat.size).toBeGreaterThan(0);
}

describe("plugin-sdk bundled exports", () => {
  afterAll(() => {
    bundleTempRootTracker.cleanup();
  });

  it("emits importable bundled subpath entries", { timeout: 120_000 }, async () => {
    const bundleTempRoot = bundleTempRootTracker.ensureSuiteTempRoot();
    const outDir = path.join(bundleTempRoot, "bundle");
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.mkdir(outDir, { recursive: true });

    const { build } = await import(tsdownModuleUrl);
    await build({
      clean: false,
      config: false,
      dts: false,
      // Full plugin-sdk coverage belongs to `pnpm build`, package contract
      // guardrails, and `plugin-sdk-subpaths.test.ts`. This file only keeps the
      // expensive bundler path honest across representative entrypoint families.
      entry: bundledCoverageEntrySources,
      env: { NODE_ENV: "production" },
      fixedExtension: false,
      logLevel: "error",
      outDir,
      platform: "node",
    });

    expect(pluginSdkEntrypoints.length).toBeGreaterThan(bundledRepresentativeEntrypoints.length);
    await Promise.all(
      bundledRepresentativeEntrypoints.map(async (entry) => {
        await expectBuiltJsFile(outDir, entry);
      }),
    );

    // Export list and package-specifier coverage already live in
    // plugin-sdk-package-contract-guardrails.test.ts and plugin-sdk-subpaths.test.ts. Keep this file
    // focused on the expensive part: can tsdown emit working bundle artifacts?
    const importResults = await Promise.all(
      bundledRepresentativeEntrypoints.map(async (entry) => [
        entry,
        typeof (await import(pathToFileURL(path.join(outDir, `${entry}.js`)).href)),
      ]),
    );
    expect(Object.fromEntries(importResults)).toEqual(
      Object.fromEntries(bundledRepresentativeEntrypoints.map((entry) => [entry, "object"])),
    );
  });
});
