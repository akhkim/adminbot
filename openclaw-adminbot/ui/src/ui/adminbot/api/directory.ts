// AdminBot client: Slack channel names, the channel-naming sweep, and the CV digest.
//
// Mirrors the service's api/routes/directory.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import { authedJson, type AuthResult, mapErrorResponse } from "../auth/session.ts";

/**
 * The workspace's open public channel names, for the project form's "already exists" check.
 *
 * A 503 is a configured-off deployment and is reported as its own kind, because the form has to
 * say "the check is unavailable" rather than "no channel matches" -- telling somebody their
 * correct alias is wrong is the one outcome this must never produce.
 */
export async function fetchSlackChannelNames(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<{ channels: string[] }> | { ok: false; kind: "unconfigured" }> {
  const result = await authedJson(baseUrl, "/slack/channels", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (result.response.status === 503) {
    return { ok: false, kind: "unconfigured" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body as { channels: string[] } };
}

/** Rebuilds every configured conference index (POST /venue-papers/index). Admin only. */
/**
 * Runs the Slack channel-naming sweep (POST /slack/channel-naming/sweep/run).
 *
 * Files a rename proposal for every channel still non-compliant 48 hours after its owner was
 * reminded. It renames nothing itself -- the proposals wait on the Actions tab -- which is why
 * this is safe to offer as a button an admin can press whenever they are tidying up.
 */
export async function runChannelNamingSweep(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(
    baseUrl,
    "/slack/channel-naming/sweep/run",
    "POST",
    sessionToken,
    {},
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    const message = (result.body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return { ok: false, kind: "auth-failed", message: message.trim() };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

/**
 * Runs the CV digest job (POST /cv/publish-digest): scan every linked CV, then rewrite the CV
 * Updates doc from the whole change ledger.
 *
 * Privileged server-side like the scan it wraps. 503 comes back when the service has no document
 * configured, which is a deployment gap rather than a permission problem, so it is mapped through
 * the same error path and shown with the service's own message.
 */
export async function publishCvDigest(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(baseUrl, "/cv/publish-digest", "POST", sessionToken, {});
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    // 502 (Google refused the write) and 503 (no document configured) both carry a sentence the
    // operator needs -- a missing env var, a locked gog keyring -- and mapErrorResponse only
    // preserves messages on 400. Lifted here so the button can say what actually went wrong.
    const message = (result.body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return { ok: false, kind: "auth-failed", message: message.trim() };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}
