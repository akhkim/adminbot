// Reads installed plugin manifests through index-owned paths.
import fs from "node:fs";
import type { PluginManifestRecord } from "../manifest/manifest-registry.js";
import type { InstalledPluginIndexRecord } from "./installed-plugin-index-types.js";

type ManifestBackedRecord = Pick<
  PluginManifestRecord | InstalledPluginIndexRecord,
  "bundleFormat" | "format" | "manifestPath"
>;

/** True when a Claude bundle record omits its optional manifest file. */
export function hasOptionalMissingPluginManifestFile(record: ManifestBackedRecord): boolean {
  return (
    record.format === "bundle" &&
    record.bundleFormat === "claude" &&
    !fs.existsSync(record.manifestPath)
  );
}
