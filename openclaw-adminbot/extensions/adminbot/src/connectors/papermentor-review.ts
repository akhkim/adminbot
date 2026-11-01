// Asks the lab's Overleaf to run a PaperMentor review: the one request AdminBot makes to it.
//
// The endpoint is the fork's `POST /internal/papermentor/review`, behind a shared secret rather
// than anybody's session -- the review needs no account, only the project, and the author's edit
// share link is how the project is named. The link is a credential, so it goes only to the origin
// this deployment configured: the instance that minted it. Nothing here follows a URL a member
// typed.
//
// The request returns as soon as the review has started. The review itself finishes minutes later,
// lands in the fork's cache, and reaches AdminBot through the ordinary collector.
import { resolveAdminBotLabOverleafHost } from "../contracts/overleaf.js";
import { ADMINBOT_PAPERMENTOR_SERVICE_TOKEN_ENV } from "../contracts/papermentor.js";
import type { PaperMentorReviewTarget } from "../workflows/papers/papermentor-auto-review.js";

export type PaperMentorReviewRequestStatus =
  /** The review is running. */
  | "started"
  /** One is already running for this project. */
  | "running"
  /** One was asked for in the last day; the fork asks no more often than that, whatever came of it. */
  | "recent"
  /** The fork is running as many automated reviews as it will. Ask again next pass. */
  | "busy"
  /** No project on the lab's Overleaf answers to that link: it was regenerated, or sharing is off. */
  | "not_found"
  /** The fork refused the request itself: not a share link, or not something it can review. */
  | "rejected"
  /** Not reached, not authorized, or not enabled. A deployment problem rather than a paper's. */
  | "failed";

export type PaperMentorReviewRequestOutcome = {
  status: PaperMentorReviewRequestStatus;
  /** The project the fork resolved the link to, whenever it got that far. */
  project_id?: string;
  message?: string;
};

export type PaperMentorReviewRequester = (
  target: PaperMentorReviewTarget,
  options?: { venue?: string },
) => Promise<PaperMentorReviewRequestOutcome>;

const PROJECT_ID = /^[0-9a-f]{24}$/u;

export function createPaperMentorReviewRequester(options: {
  origin: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): PaperMentorReviewRequester {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `${options.origin.replace(/\/+$/u, "")}/internal/papermentor/review`;
  return async (target, request = {}) => {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...target, ...(request.venue ? { venue: request.venue } : {}) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      return { status: "failed", message: (error as Error).message };
    }
    const body = (await response.json().catch(() => ({}))) as {
      project_id?: unknown;
      status?: unknown;
      error?: unknown;
    };
    // Only a real project id is carried back: the service writes it onto the paper.
    const projectId =
      typeof body.project_id === "string" && PROJECT_ID.test(body.project_id)
        ? { project_id: body.project_id }
        : {};
    const message = typeof body.error === "string" ? { message: body.error.slice(0, 300) } : {};
    switch (response.status) {
      case 202:
        return { status: "started", ...projectId };
      case 409:
        return { status: body.status === "running" ? "running" : "recent", ...projectId };
      case 429:
        return { status: "busy", ...projectId };
      case 404:
        return { status: "not_found", ...message };
      case 400:
        return { status: "rejected", ...message };
      default:
        return {
          status: "failed",
          message: `HTTP ${response.status}${message.message ? ` ${message.message}` : ""}`,
        };
    }
  };
}

/**
 * The requester this deployment is configured for, or nothing when it is not.
 *
 * Off until the shared secret is set on both sides, which is the whole switch: a deployment
 * without it runs the review step exactly as before, with authors pressing the button.
 */
export function paperMentorReviewRequesterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PaperMentorReviewRequester | undefined {
  const token = env[ADMINBOT_PAPERMENTOR_SERVICE_TOKEN_ENV]?.trim();
  if (!token) {
    return undefined;
  }
  return createPaperMentorReviewRequester({ origin: paperMentorOrigin(env), token });
}

/**
 * Where the lab's Overleaf answers. `ADMINBOT_OVERLEAF_URL` as given when it is a full origin --
 * which is how a test instance on another port is reached -- and https on the lab's host otherwise.
 */
function paperMentorOrigin(env: NodeJS.ProcessEnv): string {
  const configured = env.ADMINBOT_OVERLEAF_URL?.trim() ?? "";
  if (/^https?:\/\//iu.test(configured)) {
    try {
      return new URL(configured).origin;
    } catch {
      // Fall through to the lab's host, which is what an unparseable value resolves to elsewhere.
    }
  }
  return `https://${resolveAdminBotLabOverleafHost(env)}`;
}
