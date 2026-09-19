// Reads a venue's *accepted* papers out of OpenReview.
//
// Plain HTTP against API2 rather than through `openreview-py`, which every other OpenReview path
// in this repo shells out to. Two reasons: this needs nothing the library adds (no profiles, no
// invitations, no edit construction — one paginated note query), and the installed library is
// currently unimportable on this box (`editdistance.bycython`), which would make a members-facing
// tool depend on a broken dependency for no benefit.
//
// "Accepted" is expressed by the query, not by filtering afterwards. Once a venue releases
// decisions, an accepted submission's `venueid` becomes the venue group id while everything else
// keeps a rejected/withdrawn/submitted id, so asking for `content.venueid=<venue>` *is* asking for
// the accept list. A venue that has not released decisions simply answers with nothing, which is
// the honest answer rather than a list of papers that are not in yet.

import {
  adminBotOpenReviewForumId,
  type AdminBotArtifactProbe,
} from "../contracts/paper-artifact-links.js";

const BASE_URL = "https://api2.openreview.net";
const LOGIN_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 60_000;
// API2 refuses anything larger and silently truncates rather than erroring.
const PAGE_SIZE = 1000;
// A venue with more accepted papers than this is far outside anything real (ICLR 2025, the largest
// the lab tracks, is ~3.7k); the cap is what stops a wrong venue id from paging forever.
const MAX_PAPERS = 20_000;

export type OpenReviewPaper = {
  id: string;
  title: string;
  abstract: string;
  keywords: string[];
  /** The track as the venue words it — "ICLR 2025 Oral", "ACL 2025 Findings". */
  venue: string;
  pdf_url?: string;
  forum_url: string;
};

export type OpenReviewNotesReader = (venueId: string) => Promise<OpenReviewPaper[]>;

export type OpenReviewNotesOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof globalThis.fetch;
};

/**
 * Builds a reader, or returns undefined when no credentials are configured.
 *
 * Undefined rather than a reader that always throws: the route checks for it and answers 503 with
 * the variable names, which is a deployment gap an operator can fix, not a runtime failure a
 * member should see.
 */
export function createOpenReviewNotesReader(
  options: OpenReviewNotesOptions = {},
): OpenReviewNotesReader | undefined {
  const env = options.env ?? process.env;
  const username = env.OPENREVIEW_USERNAME?.trim();
  const password = env.OPENREVIEW_PASSWORD?.trim();
  if (!username || !password) {
    return undefined;
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  // One token per reader, reused across the venues of a single index run. Not cached beyond that:
  // the run is minutes long and a token outlives it comfortably, so there is nothing to refresh.
  let token: string | undefined;

  const login = async (): Promise<string> => {
    const response = await fetchImpl(`${BASE_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: username, password }),
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `OpenReview rejected the login (${response.status}) — check OPENREVIEW_USERNAME/PASSWORD`,
      );
    }
    const body = (await response.json()) as { token?: unknown };
    if (typeof body.token !== "string" || !body.token) {
      throw new Error("OpenReview login returned no token");
    }
    return body.token;
  };

  return async (venueId: string) => {
    const venue = venueId.trim();
    if (!venue) {
      throw new Error("a venue id is required");
    }
    token ??= await login();
    const papers: OpenReviewPaper[] = [];
    for (let offset = 0; offset < MAX_PAPERS; offset += PAGE_SIZE) {
      const query = new URLSearchParams({
        "content.venueid": venue,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      const response = await fetchImpl(`${BASE_URL}/notes?${query}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`OpenReview returned ${response.status} for ${venue}`);
      }
      const body = (await response.json()) as { notes?: unknown };
      const notes = Array.isArray(body.notes) ? body.notes : [];
      for (const note of notes) {
        const paper = toPaper(note);
        if (paper) {
          papers.push(paper);
        }
      }
      // A short page is the last page. Checked against the requested size rather than against a
      // reported total, because API2's `count` is frequently absent on this query.
      if (notes.length < PAGE_SIZE) {
        break;
      }
    }
    return papers;
  };
}

/**
 * One API2 note as a paper, or undefined for anything without a title.
 *
 * API2 wraps every content field as `{ value }`, and a field the venue did not collect is simply
 * missing — so every read goes through `valueOf` rather than indexing twice and hoping.
 */
export function toPaper(note: unknown): OpenReviewPaper | undefined {
  if (!note || typeof note !== "object") {
    return undefined;
  }
  const record = note as { id?: unknown; content?: unknown };
  const id = typeof record.id === "string" ? record.id : "";
  const content = (record.content ?? {}) as Record<string, unknown>;
  const title = stringValue(content.title);
  if (!id || !title) {
    return undefined;
  }
  const pdf = stringValue(content.pdf);
  return {
    id,
    title,
    abstract: stringValue(content.abstract) ?? "",
    keywords: listValue(content.keywords),
    venue: stringValue(content.venue) ?? "",
    // The stored `pdf` is a site-relative path ("/pdf/abc123.pdf"), not a URL.
    ...(pdf ? { pdf_url: pdf.startsWith("http") ? pdf : `https://openreview.net${pdf}` } : {}),
    forum_url: `https://openreview.net/forum?id=${encodeURIComponent(id)}`,
  };
}

function stringValue(field: unknown): string | undefined {
  if (!field || typeof field !== "object") {
    return undefined;
  }
  const value = (field as { value?: unknown }).value;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function listValue(field: unknown): string[] {
  if (!field || typeof field !== "object") {
    return [];
  }
  const value = (field as { value?: unknown }).value;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) =>
    typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
  );
}

/**
 * Asks OpenReview whether one forum is really there, and what it is called.
 *
 * Anonymous, like the accepted-papers read above, and that is what decides the answer it is
 * allowed to give. A submission under blind review is invisible to a reader who is not on its
 * committee, so "we cannot see it" and "there is no such paper" are the same HTTP answer -- and
 * reading that as absence would invalidate the evidence of every paper the lab currently has in
 * review. This probe therefore **never** reports `missing`: it confirms what it can see and says
 * "could not tell" about everything else.
 *
 * That still catches the thing worth catching, because the check that matters here is positive:
 * a forum that answers with a title the lab can compare against the paper on file.
 */
export function createOpenReviewForumProbe(
  options: { fetchImpl?: typeof globalThis.fetch; baseUrl?: string } = {},
): AdminBotArtifactProbe {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? BASE_URL;
  return async (forumId) => {
    if (!/^[A-Za-z0-9_-]{4,64}$/u.test(forumId)) {
      return { status: "unreadable", reason: "not an OpenReview id" };
    }
    try {
      const response = await fetchImpl(
        `${baseUrl}/notes?id=${encodeURIComponent(forumId)}&limit=1`,
        { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) },
      );
      if (!response.ok) {
        return { status: "unreadable", reason: `OpenReview answered ${response.status}` };
      }
      const body = (await response.json()) as { notes?: Array<Record<string, unknown>> };
      const note = body.notes?.find((entry) => entry.id === forumId);
      if (!note || note.replyto || (note.forum && note.forum !== forumId)) {
        return {
          status: "unreadable",
          reason: "OpenReview showed no note — a blind submission looks the same as none",
        };
      }
      const content = (note.content ?? {}) as Record<string, unknown>;
      const titleField = content.title as { value?: unknown } | string | undefined;
      const title =
        typeof titleField === "string"
          ? titleField
          : typeof titleField?.value === "string"
            ? titleField.value
            : undefined;
      if (!title?.trim()) {
        return { status: "unreadable", reason: "OpenReview did not expose the submission title" };
      }
      // ARR publishes this explicit link when readers may see it. A renamed title alone
      // says nothing about submission history; absent metadata remains unknown.
      const previousField = content.previous_url as { value?: unknown } | string | undefined;
      const previousUrl = typeof previousField === "string" ? previousField : previousField?.value;
      const previousId =
        typeof previousUrl === "string" ? adminBotOpenReviewForumId(previousUrl) : undefined;
      return {
        status: "found",
        title: title.trim().slice(0, 2000),
        ...(previousId && previousId !== forumId ? { previous_submission_id: previousId } : {}),
      };
    } catch (error) {
      return { status: "unreadable", reason: (error as Error).message.slice(0, 200) };
    }
  };
}
