// The Drive file a link names, and nothing else about it.
//
// Every Google artifact the lab keeps arrives as a URL somebody pasted out of their browser --
// a Doc, a folder, a PDF, a slide deck -- and all of those carry the same id in one of two places.
// Pulling it out is the whole of what this file does, and it is the same boundary
// `contracts/overleaf.ts` draws for Overleaf projects: what is safe to hand a connector is an
// **id**, checked against a closed charset, not an address a member typed.
//
// Nothing here fetches. Shape only, exactly as the slot validator promises.

/** Drive ids are base64url-ish and long. Short enough to reject a path segment that is not one. */
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/u;

const DRIVE_HOSTS = ["drive.google.com", "docs.google.com"];

/**
 * The file id a Google link names, or nothing when it names none.
 *
 * Both share forms: `/…/d/<id>/…`, which covers Docs, Sheets, Slides, `/file/d/` and
 * `/drive/folders/` alike once the folder form is read the same way, and the older `?id=<id>`.
 */
export function adminBotDriveFileId(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (!DRIVE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
    return undefined;
  }
  const fromPath =
    /\/d\/([A-Za-z0-9_-]+)/u.exec(url.pathname)?.[1] ??
    /\/folders\/([A-Za-z0-9_-]+)/u.exec(url.pathname)?.[1];
  const candidate = fromPath ?? url.searchParams.get("id") ?? "";
  return DRIVE_ID.test(candidate) ? candidate : undefined;
}

/**
 * What a probe can say about a file.
 *
 * Three answers rather than two, and the third is load-bearing. `missing` is Google saying the
 * file is not there, which is a contradiction of the evidence and should be acted on. `unreadable`
 * is everything else -- no account configured, a network that blinked, a file shared with a person
 * but not with the lab's own account -- and must never be treated as "the artifact does not
 * exist", because the commonest cause is a sharing setting rather than a wrong link.
 */
export type AdminBotDriveProbeResult =
  | { status: "found"; name?: string; trashed?: boolean }
  | { status: "missing" }
  | { status: "unreadable"; reason: string };

/** Asks Google whether one file is there. Injected, so a deployment with no Google is simply quiet. */
export type AdminBotDriveProbe = (fileId: string) => Promise<AdminBotDriveProbeResult>;
