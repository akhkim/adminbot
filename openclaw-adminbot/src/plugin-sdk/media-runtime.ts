/**
 * Media runtime surface for bundled plugins.
 *
 * Narrowed after the deep clean: this used to be a broad barrel over the whole
 * of `src/media`, most of which no longer exists. It now re-exports only what
 * the surviving bundled plugins reach for — remote media fetch/save for Slack,
 * QR rendering for device pairing.
 */

export type { FetchLike } from "../media/fetch.js";
export { readRemoteMediaBuffer, saveRemoteMedia } from "../media/fetch.js";
export type { SavedMedia } from "../media/store.js";
export { saveMediaBuffer } from "../media/store.js";
export {
  formatQrPngDataUrl,
  renderQrPngBase64,
  renderQrPngDataUrl,
  writeQrPngTempFile,
} from "../media/qr-image.js";
