// Reads the submissions the configured OpenReview account is an author of, and their PDFs.
//
// Authenticated, unlike `reference-scan.ts`'s public reader: almost every one of these papers is
// under blind review and invisible anonymously. What comes back is restricted manuscript content.
// The PDF itself never leaves the host and is never handed to an upload-style scanner such as
// GPTZero. Two local consumers read it: the CheckIfExist extraction, which sends only citation
// strings out, and -- when an operator opts in with ADMINBOT_ICLR_INTEGRITY_CHECKS=1 -- the ICLR
// integrity watch, which sends the extracted main text of an ICLR submission under review to
// Pangram for an AI-text score (see workflows/papers/iclr-integrity-watch.ts).
//
// Plain API2 HTTP rather than `openreview-py`, for the reasons given in `openreview-notes.ts`.

import type {
  OpenReviewSubmission,
  OpenReviewSubmissionReader,
} from "../contracts/openreview-citation-checks.js";

const BASE_URL = "https://api2.openreview.net";
const LOGIN_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 60_000;
const PDF_TIMEOUT_MS = 120_000;
const PAGE_SIZE = 1000;
// A PI's full history is a few hundred notes; the cap stops a bad query from paging forever.
const MAX_NOTES = 10_000;
// Camera-ready papers with appendices run larger than the manual checker's 20 MB upload cap.
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
// Nothing left to protect from a desk rejection.
const SETTLED_VENUE = /(?:^|\/)(?:Withdrawn|Desk_Rejected)(?:_Submission)?$/u;

export type OpenReviewSubmissionReaderOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof globalThis.fetch;
  baseUrl?: string;
};

/** Undefined when no credentials are configured, so the route can answer 503 with the names. */
export function createOpenReviewSubmissionReader(
  options: OpenReviewSubmissionReaderOptions = {},
): OpenReviewSubmissionReader | undefined {
  const env = options.env ?? process.env;
  const username = env.OPENREVIEW_USERNAME?.trim();
  const password = env.OPENREVIEW_PASSWORD?.trim();
  if (!username || !password) {
    return undefined;
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? BASE_URL;
  let session: Promise<{ token: string; profileId: string }> | undefined;

  const login = async () => {
    const response = await fetchImpl(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: username, password }),
      redirect: "error",
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `OpenReview rejected the login (${response.status}) — check OPENREVIEW_USERNAME/PASSWORD`,
      );
    }
    const body = (await response.json()) as {
      token?: unknown;
      user?: { profile?: { id?: unknown } };
    };
    const profileId = body.user?.profile?.id;
    if (typeof body.token !== "string" || !body.token || typeof profileId !== "string") {
      throw new Error("OpenReview login returned no token or profile");
    }
    return { token: body.token, profileId };
  };

  const current = () => {
    session ??= login().catch((error: unknown) => {
      session = undefined;
      throw error;
    });
    return session;
  };

  // A backfill sweep runs for hours; an expired token is renewed once rather than failing it.
  const authorized = async (url: string, timeoutMs: number): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const { token } = await current();
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if ((response.status === 401 || response.status === 403) && attempt === 0) {
        await response.body?.cancel().catch(() => undefined);
        session = undefined;
        continue;
      }
      return response;
    }
  };

  return {
    profileId: async () => (await current()).profileId,

    async listSubmissions() {
      const { profileId } = await current();
      const submissions: OpenReviewSubmission[] = [];
      for (let offset = 0; offset < MAX_NOTES; offset += PAGE_SIZE) {
        const query = new URLSearchParams({
          "content.authorids": profileId,
          limit: String(PAGE_SIZE),
          offset: String(offset),
        });
        const response = await authorized(`${baseUrl}/notes?${query}`, PAGE_TIMEOUT_MS);
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`OpenReview returned ${response.status} listing submissions`);
        }
        const body = JSON.parse(
          Buffer.from(await boundedBody(response, MAX_JSON_BYTES)).toString("utf8"),
        ) as { notes?: unknown };
        const notes = Array.isArray(body.notes) ? body.notes : [];
        for (const note of notes) {
          const submission = toSubmission(note);
          if (submission) {
            submissions.push(submission);
          }
        }
        if (notes.length < PAGE_SIZE) {
          break;
        }
      }
      return submissions;
    },

    async readPdf(submissionId) {
      if (!/^[A-Za-z0-9_-]{4,128}$/u.test(submissionId)) {
        throw new Error("Expected an OpenReview submission ID");
      }
      // Always the fixed API2 endpoint, never a URL taken from a note's metadata.
      const response = await authorized(
        `${baseUrl}/pdf?id=${encodeURIComponent(submissionId)}`,
        PDF_TIMEOUT_MS,
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`OpenReview returned ${response.status} for the PDF`);
      }
      const bytes = await boundedBody(response, MAX_PDF_BYTES);
      if (Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") {
        throw new Error("OpenReview did not return a PDF");
      }
      return bytes;
    },
  };
}

/** A root submission with a PDF that can still be desk rejected, or undefined. */
export function toSubmission(note: unknown): OpenReviewSubmission | undefined {
  if (!note || typeof note !== "object") {
    return undefined;
  }
  const record = note as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  // Replies (reviews, comments, rebuttals) carry the author ids of the forum too.
  if (!id || (record.forum !== undefined && record.forum !== id) || record.replyto) {
    return undefined;
  }
  const content = (record.content ?? {}) as Record<string, unknown>;
  const pdfPath = value(content.pdf);
  const title = value(content.title);
  const venueId = value(content.venueid) ?? "";
  if (!pdfPath || !title || SETTLED_VENUE.test(venueId)) {
    return undefined;
  }
  const authorIds = values(content.authorids).map((entry) => entry.trim());
  return {
    id,
    title,
    venue_id: venueId,
    pdf_path: pdfPath,
    modified_at: typeof record.tmdate === "number" ? record.tmdate : 0,
    ...(authorIds.length ? { author_ids: authorIds } : {}),
  };
}

function values(field: unknown): string[] {
  const raw = field && typeof field === "object" ? (field as { value?: unknown }).value : undefined;
  return Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    : [];
}

function value(field: unknown): string | undefined {
  const raw = field && typeof field === "object" ? (field as { value?: unknown }).value : undefined;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) {
    throw new Error("OpenReview returned an empty response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) {
        break;
      }
      size += chunk.length;
      if (size > limit) {
        throw new Error("OpenReview response exceeds the size limit");
      }
      chunks.push(chunk);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}
