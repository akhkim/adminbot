/**
 * Runtime SDK type surface for plugin-scoped keyed state stores.
 */
export { configureSqliteConnectionPragmas } from "../infra/state/sqlite-wal.js";
export type {
  OpenKeyedStoreOptions,
  PluginStateEntry,
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "../plugin-state/plugin-state-store.js";
