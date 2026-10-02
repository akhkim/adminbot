/**
 * Whether the "doc prep of all the questions" link on a call request is one Zhijing can open.
 *
 * This exists because of what the call sheet actually holds. The column is the reason the calls
 * work -- she reads the questions at a trip break and phones the person -- and yet the rows that
 * fail it fail in three quite different ways: some say `TODO`, some carry a real Google Doc that
 * was never shared past its author, and some carry a link to a document that no longer exists.
 * Those want three different messages back to the member, so they are three different verdicts
 * here rather than one boolean.
 *
 * Two halves, split so the useful one needs no network. `parseDocPrepLink` is pure: it decides
 * whether a string is even a Google document reference and pulls the id out of it.
 * `checkDocPrepLink` adds the only question a parser cannot answer -- can a stranger open it --
 * by asking Google, through an injected probe so the decision table is testable without a socket.
 *
 * Nothing here writes anywhere. A verdict is an input to the sheet push in
 * `call-request-sheet.ts`, which is where the approval gate lives.
 */

/** What the link turned out to be. Only `ok` is safe to put in front of Zhijing. */
export type DocPrepLinkVerdict =
  /** A Google document that an unauthenticated reader can open. */
  | { status: "ok"; document_id: string; url: string }
  /** No link given at all. */
  | { status: "missing" }
  /** A stand-in the member left themselves -- `TODO`, `tbd`, `-`. */
  | { status: "placeholder"; raw: string }
  /** Not a URL, or not one worth following. */
  | { status: "malformed"; raw: string; reason: string }
  /** A URL, but not a Google document reference. */
  | { status: "not_a_doc"; raw: string; reason: string }
  /** Google says there is no such document. */
  | { status: "not_found"; document_id: string; url: string }
  /** The document exists but is not readable without an account Google recognizes. */
  | { status: "restricted"; document_id: string; url: string }
  /** The probe itself failed, so nothing was learned either way. */
  | { status: "unreachable"; document_id: string; url: string; reason: string };

/**
 * Strings members write in the column instead of a link.
 *
 * Matched case-insensitively against the whole trimmed cell, never against a substring: a document
 * legitimately titled "TODO list for the call" must not be mistaken for an empty promise.
 */
const PLACEHOLDERS = new Set(["todo", "to do", "tbd", "n/a", "na", "none", "-", "--", "pending"]);

/** A Drive file id. Google's are 25-60ish of these; the bound is loose on purpose. */
const DOCUMENT_ID = /^[A-Za-z0-9_-]{12,}$/u;

const DOCS_PATH = /^\/(document|spreadsheets|presentation|forms)\/d\/([A-Za-z0-9_-]+)/u;
const DRIVE_FILE_PATH = /^\/file\/d\/([A-Za-z0-9_-]+)/u;

export type DocPrepLinkParse =
  | { ok: true; document_id: string; url: string }
  | { ok: false; status: "missing" }
  | { ok: false; status: "placeholder"; raw: string }
  | { ok: false; status: "malformed"; raw: string; reason: string }
  | { ok: false; status: "not_a_doc"; raw: string; reason: string };

/**
 * The document id behind a pasted link, or the reason there isn't one.
 *
 * Pure and offline. The canonical URL it returns is deliberately stripped back to
 * `/document/d/<id>/edit`: the pasted forms carry `?usp=sharing`, `?tab=t.0` and `#0de1bd`
 * fragments that identify the sharer's own session rather than the document, and probing those is
 * both noisier and, in the fragment's case, meaningless -- a fragment never reaches the server.
 */
export function parseDocPrepLink(raw: unknown): DocPrepLinkParse {
  if (typeof raw !== "string") {
    return { ok: false, status: "missing" };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, status: "missing" };
  }
  if (PLACEHOLDERS.has(trimmed.toLowerCase())) {
    return { ok: false, status: "placeholder", raw: trimmed };
  }

  let url: URL;
  try {
    // A bare id is accepted because it is what someone pastes out of another link's address bar,
    // and refusing it would send them away to reconstruct a URL we are about to rebuild anyway.
    url = new URL(
      DOCUMENT_ID.test(trimmed) && !trimmed.includes("/")
        ? `https://docs.google.com/document/d/${trimmed}/edit`
        : trimmed,
    );
  } catch {
    return {
      ok: false,
      status: "malformed",
      raw: trimmed,
      reason: "not a URL",
    };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      status: "malformed",
      raw: trimmed,
      reason: `${url.protocol} is not http(s)`,
    };
  }

  const host = url.hostname.toLowerCase();
  if (host === "docs.google.com") {
    const match = DOCS_PATH.exec(url.pathname);
    if (match) {
      return canonical(match[2] ?? "", match[1] ?? "document", trimmed);
    }
    return {
      ok: false,
      status: "not_a_doc",
      raw: trimmed,
      reason: "no /d/<id> in the path",
    };
  }
  if (host === "drive.google.com") {
    const file = DRIVE_FILE_PATH.exec(url.pathname);
    if (file) {
      return canonical(file[1] ?? "", "file", trimmed);
    }
    // `drive.google.com/open?id=` is what the older share dialog produced.
    const id = url.searchParams.get("id") ?? "";
    if (id) {
      return canonical(id, "file", trimmed);
    }
    // A folder is a common mistake worth naming: it looks shared but holds nothing to read.
    if (url.pathname.startsWith("/drive/folders/")) {
      return {
        ok: false,
        status: "not_a_doc",
        raw: trimmed,
        reason: "that is a folder, not a document",
      };
    }
    return {
      ok: false,
      status: "not_a_doc",
      raw: trimmed,
      reason: "no file id in the link",
    };
  }
  return {
    ok: false,
    status: "not_a_doc",
    raw: trimmed,
    reason: `${host} is not Google Docs or Drive`,
  };
}

function canonical(id: string, kind: string, raw: string): DocPrepLinkParse {
  if (!DOCUMENT_ID.test(id)) {
    return {
      ok: false,
      status: "malformed",
      raw,
      reason: "document id is too short to be real",
    };
  }
  const url =
    kind === "file"
      ? `https://drive.google.com/file/d/${id}/view`
      : `https://docs.google.com/${kind}/d/${id}/edit`;
  return { ok: true, document_id: id, url };
}

/**
 * Asks Google for the document without credentials and reports the HTTP status.
 *
 * Unauthenticated on purpose, and this is the whole point of the check. The bot's own Google
 * account can very well read a document Zhijing cannot, so probing as the bot would answer a
 * question nobody asked. A signed-out reader is the closest available stand-in for "she opens the
 * link on her phone at an airport", and a document that answers 200 to that will open for her.
 */
export type DocPrepProbe = (url: string) => Promise<number>;

/** How long a probe may take before the request is treated as telling us nothing. */
export const DOC_PREP_PROBE_TIMEOUT_MS = 10_000;

export const fetchDocPrepProbe: DocPrepProbe = async (url) => {
  const response = await fetch(url, {
    method: "GET",
    // Manual, so a bounce to accounts.google.com is read as "restricted" instead of being followed
    // to a login page that would answer 200 and look like success.
    redirect: "manual",
    headers: { accept: "text/html" },
    signal: AbortSignal.timeout(DOC_PREP_PROBE_TIMEOUT_MS),
  });
  return response.status;
};

/**
 * The verdict for one link.
 *
 * Status mapping, in the order the cases actually occur:
 *   200      the document is link-readable -- the only pushable answer
 *   401/403  it exists and is restricted; Zhijing may still have been shared it directly, which is
 *            why this is held for a human rather than called invalid
 *   404/410  no such document
 *   3xx      a bounce, which for a signed-out reader means a sign-in wall
 *   anything else, or a thrown probe: unreachable, which is explicitly not a failed document
 */
export async function checkDocPrepLink(
  raw: unknown,
  probe: DocPrepProbe = fetchDocPrepProbe,
): Promise<DocPrepLinkVerdict> {
  const parsed = parseDocPrepLink(raw);
  if (!parsed.ok) {
    return parsed.status === "missing"
      ? { status: "missing" }
      : parsed.status === "placeholder"
        ? { status: "placeholder", raw: parsed.raw }
        : { status: parsed.status, raw: parsed.raw, reason: parsed.reason };
  }

  const { document_id, url } = parsed;
  let status: number;
  try {
    status = await probe(url);
  } catch (error) {
    return {
      status: "unreachable",
      document_id,
      url,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (status === 200) {
    return { status: "ok", document_id, url };
  }
  if (status === 401 || status === 403) {
    return { status: "restricted", document_id, url };
  }
  if (status === 404 || status === 410) {
    return { status: "not_found", document_id, url };
  }
  if (status >= 300 && status < 400) {
    return { status: "restricted", document_id, url };
  }
  return { status: "unreachable", document_id, url, reason: `HTTP ${status}` };
}

/** Only a document a signed-out reader can open goes to the sheet unattended. */
export function isPushableDocPrep(verdict: DocPrepLinkVerdict): boolean {
  return verdict.status === "ok";
}

/**
 * What to tell the member, in the words they need to act on.
 *
 * Written for the person who has to fix it rather than for a log: "share it" and "check the link"
 * are different actions, and a message that says only "invalid" makes them guess which.
 */
export function explainDocPrepVerdict(verdict: DocPrepLinkVerdict): string {
  switch (verdict.status) {
    case "ok":
      return "Doc prep link opens for anyone with the link.";
    case "missing":
      return "No doc prep link yet. Zhijing reads this before she calls, so the call cannot be queued without it.";
    case "placeholder":
      return `The doc prep column still says "${verdict.raw}". Replace it with a link to the questions.`;
    case "malformed":
      return `That doc prep link is not a usable URL (${verdict.reason}).`;
    case "not_a_doc":
      return `That doc prep link is not a Google Doc (${verdict.reason}).`;
    case "not_found":
      return "That doc prep document does not exist any more — check the link.";
    case "restricted":
      return "That doc prep document is not shared. Set it to anyone-with-the-link can view, or confirm you shared it with Zhijing directly.";
    case "unreachable":
      return `Could not reach that doc prep document to check it (${verdict.reason}); it has not been queued.`;
  }
}
