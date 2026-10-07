// The two public artifacts a paper ends up with, and the ids their links carry.
//
// The same boundary `contracts/drive-links.ts` and `contracts/overleaf.ts` draw, for the same
// reason: what a checker may be handed is an **id** matched against a closed charset, never an
// address a member typed. Nothing here fetches.
//
// Both probes return the artifact's title when they can see one, because the useful question about
// an arXiv link is not only "does this id exist" -- almost any id does -- but "is it this paper".

/** arXiv's modern id (2601.00001, optionally versioned) and the pre-2007 archive form. */
const ARXIV_NEW = /^\d{4}\.\d{4,5}(v\d+)?$/u;
const ARXIV_OLD = /^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/u;

/** OpenReview ids are opaque and short; the charset is what keeps one safe in a query string. */
const OPENREVIEW_ID = /^[A-Za-z0-9_-]{4,64}$/u;

/** Whether a bare string is an arXiv id in either of arXiv's own two shapes. */
export function isAdminBotArxivId(value: string): boolean {
  return ARXIV_NEW.test(value) || ARXIV_OLD.test(value);
}

/**
 * The arXiv id a link names, version and all, or nothing when it names none.
 *
 * `/abs/`, `/pdf/` and the bare `arxiv.org/2601.00001` form, because all three get pasted. The
 * version suffix is kept: "which version did the lab post" is a real question, and dropping it
 * would make two different PDFs answer to one record.
 */
export function adminBotArxivId(raw: string): string | undefined {
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
  if (host !== "arxiv.org" && !host.endsWith(".arxiv.org")) {
    return undefined;
  }
  const path = url.pathname
    .replace(/^\/(abs|pdf)\//u, "/")
    .replace(/^\//u, "")
    .replace(/\.pdf$/u, "");
  return isAdminBotArxivId(path) ? path : undefined;
}

/** The OpenReview forum a submission link names. Other venues have no id shape to read. */
export function adminBotOpenReviewForumId(raw: string): string | undefined {
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
  if (host !== "openreview.net" && !host.endsWith(".openreview.net")) {
    return undefined;
  }
  const id = url.searchParams.get("id") ?? "";
  return OPENREVIEW_ID.test(id) ? id : undefined;
}

/**
 * What a public-record probe can say.
 *
 * The same three answers the Drive probe gives, and the same rule about which of them is evidence:
 * only `missing` is the outside world saying the artifact is not there. `unreadable` covers every
 * way the lab can fail to ask, and -- for OpenReview especially -- every way the answer can be
 * withheld: a submission under blind review is invisible to an anonymous reader, and reading that
 * as "no such paper" would invalidate the evidence of every paper still in review.
 */
export type OpenReviewIdentityReview = {
  status: "checked" | "limited" | "unavailable" | "insufficient";
  examined: number;
  abstract_excerpt: string;
  candidates: Array<{
    id: string;
    title: string;
    abstract_excerpt: string;
    shared_authors: string[];
    abstract_overlap: number;
    created_at: string;
  }>;
};

export type AdminBotArtifactProbeResult =
  | {
      status: "found";
      title?: string;
      previous_submission_id?: string;
      identity_review?: OpenReviewIdentityReview;
    }
  | { status: "missing" }
  | { status: "unreadable"; reason: string };

export type AdminBotArtifactProbe = (id: string) => Promise<AdminBotArtifactProbeResult>;

/**
 * Whether two titles are the same paper, allowing for the ways people retitle.
 *
 * Compared on words rather than characters: arXiv normalizes punctuation, LaTeX leaks braces and
 * `\\emph`, and a colon becomes a dash somewhere between the draft and the listing. What this is
 * looking for is the mistake worth catching -- a link to somebody else's paper -- so it asks
 * whether most of the shorter title's words appear in the longer one, which a renamed paper
 * survives and a wrong link does not.
 */
export function adminBotTitlesLookLikeTheSamePaper(left: string, right: string): boolean {
  const words = (value: string) =>
    value
      .toLowerCase()
      .replaceAll(/[^a-z0-9\s]/gu, " ")
      .split(/\s+/u)
      .filter((word) => word.length > 2);
  const [a, b] = [words(left), words(right)];
  if (a.length === 0 || b.length === 0) {
    return true;
  }
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const haystack = new Set(longer);
  const shared = shorter.filter((word) => haystack.has(word)).length;
  return shared / shorter.length >= 0.6;
}
