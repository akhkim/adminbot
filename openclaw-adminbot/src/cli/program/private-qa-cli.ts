// Private QA CLI loader, enabled only from source checkouts and explicit env opt-in.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";

const SOURCE_CHECKOUT_MARKER_RELATIVE_PATHS = [".git", "pnpm-workspace.yaml"] as const;

// Computed lazily (not at module scope) so merely importing this file never runs `path.join`.
// This module is reachable from the Control UI bundle via tool-display -> logging/config ->
// cli/argv -> subcli-descriptors, where `node:path` is stubbed for the browser: a top-level call
// here used to throw the moment the module was evaluated, before isPrivateQaCliEnabled ever ran,
// which aborted the whole bundle and left `openclaw-app` unregistered.
function privateQaDistRelativePath(): string {
  return path.join("dist", "plugin-sdk", "qa-lab.js");
}

/**
 * Return true when private QA CLI routes should be exposed.
 *
 * `subcli-descriptors.ts` calls this with no argument at module scope
 * (`SUB_CLI_DESCRIPTORS = filterPrivateQaItems(...)`), and that module is reachable from the
 * Control UI bundle -- `process` does not exist in a browser, so the default parameter must not
 * dereference it unconditionally, or importing this file at all throws "process is not defined"
 * before any real caller ever runs.
 */
export function isPrivateQaCliEnabled(
  env: NodeJS.ProcessEnv = typeof process === "undefined" ? {} : process.env,
): boolean {
  return env.OPENCLAW_ENABLE_PRIVATE_QA_CLI === "1";
}

function resolvePrivateQaSourceModuleSpecifier(params?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
  resolvePackageRootSync?: typeof resolveOpenClawPackageRootSync;
  existsSync?: typeof fs.existsSync;
}): string | null {
  const env = params?.env ?? process.env;
  if (!isPrivateQaCliEnabled(env)) {
    return null;
  }
  const resolvePackageRootSync = params?.resolvePackageRootSync ?? resolveOpenClawPackageRootSync;
  const packageRoot = resolvePackageRootSync({
    argv1: params?.argv1 ?? process.argv[1],
    cwd: params?.cwd ?? process.cwd(),
    moduleUrl: params?.moduleUrl ?? import.meta.url,
  });
  if (!packageRoot) {
    return null;
  }
  const existsSync = params?.existsSync ?? fs.existsSync;
  const sourceModulePath = path.join(packageRoot, privateQaDistRelativePath());
  const hasSourceCheckoutMarker = SOURCE_CHECKOUT_MARKER_RELATIVE_PATHS.some((relativePath) =>
    existsSync(path.join(packageRoot, relativePath)),
  );
  if (
    !hasSourceCheckoutMarker ||
    !existsSync(path.join(packageRoot, "src")) ||
    !existsSync(sourceModulePath)
  ) {
    return null;
  }
  return pathToFileURL(sourceModulePath).href;
}

async function dynamicImportPrivateQaCliModule(
  specifier: string,
): Promise<Record<string, unknown>> {
  return (await import(specifier)) as Record<string, unknown>;
}

/** Load the private QA module from a source checkout or throw a user-facing availability error. */
export function loadPrivateQaCliModule(params?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
  resolvePackageRootSync?: typeof resolveOpenClawPackageRootSync;
  existsSync?: typeof fs.existsSync;
  importModule?: (specifier: string) => Promise<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  const specifier = resolvePrivateQaSourceModuleSpecifier(params);
  if (!specifier) {
    throw new Error("Private QA CLI is only available from an OpenClaw source checkout.");
  }
  return (params?.importModule ?? dynamicImportPrivateQaCliModule)(specifier);
}
