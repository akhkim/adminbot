import { createHash } from "node:crypto";

/**
 * Uploaded profile photos, served by content address.
 *
 * A photo uploaded in the console is stored on the member as a base64 data URL, up to ~700KB. Sent
 * inline it rides along in every roster, member map and conference list -- megabytes per page,
 * re-downloaded on every visit. On the wire it becomes `/avatars/<sha256 of the data URL>` instead:
 * the address changes whenever the photo does, so the photo can be cached forever.
 *
 * The hash is of a photo the caller was already sent, so serving it unauthenticated reveals
 * nothing the JSON did not -- the same footing as the Slack avatar URLs most members have.
 */

const RASTER = /^data:(image\/(?:png|jpeg|webp|gif));base64,/u;
const PATH = /\/avatars\/([0-9a-f]{64})$/u;
const MAX_ENTRIES = 2000;

// Keyed by the data URL itself. Members are cached objects (persistence/sqlite.lab-members.ts), so
// the same string instance comes back each time and V8 hashes it once rather than per lookup.
const pathByDataUrl = new Map<string, string>();
const dataUrlByHash = new Map<string, string>();

/** `JSON.stringify` replacer: inline raster `avatar_url`s go out as their `/avatars/` path. */
export function avatarJsonReplacer(key: string, value: unknown): unknown {
  if (key !== "avatar_url" || typeof value !== "string" || !RASTER.test(value)) {
    return value;
  }
  let path = pathByDataUrl.get(value);
  if (!path) {
    const hash = createHash("sha256").update(value).digest("hex");
    if (pathByDataUrl.size >= MAX_ENTRIES) {
      pathByDataUrl.clear();
      dataUrlByHash.clear();
    }
    path = `/avatars/${hash}`;
    pathByDataUrl.set(value, path);
    dataUrlByHash.set(hash, value);
  }
  return path;
}

/**
 * `JSON.parse` reviver: an `avatar_url` a client echoes back becomes the stored photo again.
 *
 * One this process cannot resolve is dropped rather than kept: saving it would store a link to a
 * photo that no longer exists, while a missing field leaves the member's photo as it was.
 */
export function avatarJsonReviver(key: string, value: unknown): unknown {
  if (key !== "avatar_url" || typeof value !== "string") {
    return value;
  }
  const hash = PATH.exec(value)?.[1];
  return hash ? dataUrlByHash.get(hash) : value;
}

export type Avatar = { contentType: string; bytes: Buffer };

/** The photo behind a hash, scanning the members for one this process has not sent yet. */
export function findAvatar(
  hash: string,
  members: () => Iterable<{ avatar_url?: string }>,
): Avatar | undefined {
  if (!/^[0-9a-f]{64}$/u.test(hash)) {
    return undefined;
  }
  if (!dataUrlByHash.has(hash)) {
    // Registers every photo, not just the match: each is hashed once per process, so a stream of
    // made-up hashes costs map lookups rather than re-hashing megabytes per request.
    for (const { avatar_url: candidate } of members()) {
      avatarJsonReplacer("avatar_url", candidate);
    }
  }
  const dataUrl = dataUrlByHash.get(hash);
  const match = dataUrl ? RASTER.exec(dataUrl) : null;
  if (!dataUrl || !match) {
    return undefined;
  }
  return {
    contentType: match[1],
    bytes: Buffer.from(dataUrl.slice(match[0].length), "base64"),
  };
}
