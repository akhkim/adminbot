// One logged-in OpenReview API2 session for the service's long-lived readers.
//
// The readers live as long as the service, and an OpenReview token does not: it expires, and the
// API answers 401/403 from then on. The account's email and password do not change, so an expired
// token is never a reason to stop. It is dropped and the session logs in again with the same
// credentials, once per request.
//
// A failed login is told apart by why it failed, because the two need opposite handling:
//   - OpenReview refused the email/password (400/401/403 from /login): logging in again will not
//     help, and somebody has to fix the env file. `credentialsRejected` is true.
//   - OpenReview did not answer (network error, timeout, 429, 5xx): a few retries with a pause,
//     then a `credentialsRejected: false` error. The credentials are not blamed for an outage.
// Before this, a 429 or a 502 from /login came back as "OpenReview rejected the login -- check
// OPENREVIEW_USERNAME/PASSWORD", which sent people looking for a credential problem that was not
// there.

import { setTimeout as delay } from "node:timers/promises";
import { OpenReviewLoginError } from "../contracts/openreview-citation-checks.js";

const BASE_URL = "https://api2.openreview.net";
const LOGIN_TIMEOUT_MS = 20_000;
// Three tries over about ten seconds: enough to ride out a dropped connection or a brief 5xx, short
// enough that a sweep that is going to fail does so before the next scheduled start.
const LOGIN_RETRY_DELAYS_MS = [2_000, 8_000];
const CREDENTIAL_REJECTION_STATUSES = new Set([400, 401, 403]);

export type OpenReviewSessionOptions = {
  username: string;
  password: string;
  fetchImpl?: typeof globalThis.fetch;
  baseUrl?: string;
  /** Pause before each login retry. Tests pass zeros. */
  loginRetryDelaysMs?: readonly number[];
  /** Passed through to every request; the submissions reader refuses redirects. */
  redirect?: RequestRedirect;
};

export type OpenReviewSession = {
  /** The profile the credentials belong to, logging in first if needed. */
  profileId(): Promise<string>;
  /**
   * A bearer-authenticated GET. A 401/403 drops the token, logs in afresh and retries once; a
   * second 401/403 after a fresh login is returned to the caller, because it is then about the
   * resource (a PDF this account may not read), not about the session.
   */
  get(url: string, timeoutMs: number): Promise<Response>;
};

export function createOpenReviewSession(options: OpenReviewSessionOptions): OpenReviewSession {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? BASE_URL;
  const retryDelays = options.loginRetryDelaysMs ?? LOGIN_RETRY_DELAYS_MS;
  let session: Promise<{ token: string; profileId?: string }> | undefined;

  const loginOnce = async (): Promise<{ token: string; profileId?: string }> => {
    for (let attempt = 0; ; attempt++) {
      let failure: string;
      try {
        const response = await fetchImpl(`${baseUrl}/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: options.username, password: options.password }),
          ...(options.redirect ? { redirect: options.redirect } : {}),
          signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
        });
        if (response.ok) {
          const body = (await response.json()) as {
            token?: unknown;
            user?: { profile?: { id?: unknown } };
          };
          if (typeof body.token !== "string" || !body.token) {
            throw new OpenReviewLoginError("OpenReview login returned no token", false);
          }
          const profileId = body.user?.profile?.id;
          return {
            token: body.token,
            ...(typeof profileId === "string" && profileId ? { profileId } : {}),
          };
        }
        await response.body?.cancel().catch(() => undefined);
        if (CREDENTIAL_REJECTION_STATUSES.has(response.status)) {
          throw new OpenReviewLoginError(
            `OpenReview rejected the login (${response.status}): OPENREVIEW_USERNAME / OPENREVIEW_PASSWORD are wrong or the account is locked`,
            true,
            response.status,
          );
        }
        failure = `HTTP ${response.status}`;
      } catch (error) {
        if (error instanceof OpenReviewLoginError) {
          throw error;
        }
        failure = error instanceof Error ? error.name : "network error";
      }
      const pause = retryDelays[attempt];
      if (pause === undefined) {
        throw new OpenReviewLoginError(
          `OpenReview login did not succeed after ${attempt + 1} tries (${failure}); the credentials were not refused, so this is retried on the next run`,
          false,
        );
      }
      await delay(pause);
    }
  };

  const current = () => {
    session ??= loginOnce().catch((error: unknown) => {
      session = undefined;
      throw error;
    });
    return session;
  };

  return {
    async profileId() {
      const { profileId } = await current();
      if (!profileId) {
        throw new OpenReviewLoginError("OpenReview login returned no profile", false);
      }
      return profileId;
    },

    async get(url, timeoutMs) {
      for (let attempt = 0; ; attempt++) {
        const pending = current();
        const { token } = await pending;
        const response = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${token}` },
          ...(options.redirect ? { redirect: options.redirect } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if ((response.status === 401 || response.status === 403) && attempt === 0) {
          await response.body?.cancel().catch(() => undefined);
          // Only drop the session this request used: a concurrent request may already have
          // replaced it, and dropping that one would log in twice for one expiry.
          if (session === pending) {
            session = undefined;
          }
          continue;
        }
        return response;
      }
    },
  };
}
