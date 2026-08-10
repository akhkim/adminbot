/**
 * Runtime SDK subpath for config snapshot and config cache access.
 */
export {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  selectApplicableRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../config/runtime/runtime-snapshot.js";
export {
  clearConfigCache,
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
} from "../config/io/io.js";
export type { OpenClawConfig } from "../config/types/types.js";
