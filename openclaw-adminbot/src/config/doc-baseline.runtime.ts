// Collects runtime data needed to generate config documentation baselines.
import { collectBundledChannelConfigs as collectBundledChannelConfigsImpl } from "../plugins/install/bundled-channel-config-metadata.js";
import { loadPluginManifestRegistry as loadPluginManifestRegistryImpl } from "../plugins/manifest/manifest-registry.js";
import {
  collectChannelSchemaMetadata as collectChannelSchemaMetadataImpl,
  collectPluginSchemaMetadata as collectPluginSchemaMetadataImpl,
} from "./channel/channel-config-metadata.js";
import { buildConfigSchema as buildConfigSchemaImpl } from "./schema/schema.js";

/** Runtime facade used by docs baseline generation to keep imports narrow. */
export const loadPluginManifestRegistry = loadPluginManifestRegistryImpl;
export const collectBundledChannelConfigs = collectBundledChannelConfigsImpl;
export const collectChannelSchemaMetadata = collectChannelSchemaMetadataImpl;
export const collectPluginSchemaMetadata = collectPluginSchemaMetadataImpl;
export const buildConfigSchema = buildConfigSchemaImpl;
