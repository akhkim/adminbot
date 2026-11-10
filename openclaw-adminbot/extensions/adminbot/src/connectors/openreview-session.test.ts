import { describe, expect, it, vi } from "vitest";
import { OpenReviewLoginError } from "../contracts/openreview-citation-checks.js";
import { createOpenReviewSession } from "./openreview-session.js";

// Synthetic credentials; every request goes to the mocked fetch below, never to OpenReview.
const credentials = { username: "synthetic@example.test", password: "synthetic-password" };
const BASE = "https://openreview.invalid";
const noWait = [0, 0];

type Step = number | "throw";

/**
 * A fake API2. `logins` scripts the /login answers in order (a status, or a network error); the
 * last entry repeats. A token is accepted only while it is the newest one issued, so an earlier
 * token behaves as expired.
 */
function fakeOpenReview(logins: Step[] = [200], options: { forbiddenPath?: string } = {}) {
  let issued = 0;
  let loginCalls = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/login") {
      const step = logins[Math.min(loginCalls, logins.length - 1)];
      loginCalls++;
      if (step === "throw") {
        throw new TypeError("fetch failed");
      }
      if (step !== 200) {
        return new Response("no", { status: step });
      }
      issued++;
      return Response.json({
        token: `token-${issued}`,
        user: { profile: { id: "~Synthetic_Author1" } },
      });
    }
    if (options.forbiddenPath === url.pathname) {
      return new Response("forbidden", { status: 403 });
    }
    const auth = new Headers(init?.headers).get("Authorization");
    if (auth !== `Bearer token-${issued}`) {
      return new Response("token expired", { status: 401 });
    }
    return Response.json({ ok: true });
  });
  return {
    fetchImpl,
    loginCalls: () => loginCalls,
    expireToken: () => {
      issued++;
    },
  };
}

function session(fake: ReturnType<typeof fakeOpenReview>) {
  return createOpenReviewSession({
    ...credentials,
    baseUrl: BASE,
    fetchImpl: fake.fetchImpl,
    loginRetryDelaysMs: noWait,
  });
}

describe("OpenReview session", () => {
  it("logs in once and reuses the token", async () => {
    const fake = fakeOpenReview();
    const openreview = session(fake);
    expect((await openreview.get(`${BASE}/notes`, 1000)).status).toBe(200);
    expect((await openreview.get(`${BASE}/notes`, 1000)).status).toBe(200);
    expect(await openreview.profileId()).toBe("~Synthetic_Author1");
    expect(fake.loginCalls()).toBe(1);
  });

  it("logs in again with the stored credentials when the token expires, and succeeds", async () => {
    const fake = fakeOpenReview();
    const openreview = session(fake);
    await openreview.get(`${BASE}/notes`, 1000);
    fake.expireToken();
    const response = await openreview.get(`${BASE}/notes`, 1000);
    expect(response.status).toBe(200);
    expect(fake.loginCalls()).toBe(2);
  });

  it("logs in once, not once per request, when concurrent requests all see the expiry", async () => {
    const fake = fakeOpenReview();
    const openreview = session(fake);
    await openreview.get(`${BASE}/notes`, 1000);
    fake.expireToken();
    const responses = await Promise.all([1, 2, 3].map(() => openreview.get(`${BASE}/notes`, 1000)));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(fake.loginCalls()).toBe(2);
  });

  it("flags a refused password as rejected credentials, without retrying or echoing them", async () => {
    for (const status of [400, 401, 403]) {
      const fake = fakeOpenReview([status]);
      const error = await session(fake)
        .get(`${BASE}/notes`, 1000)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OpenReviewLoginError);
      expect(error).toMatchObject({ credentialsRejected: true, status });
      expect(String(error)).not.toContain(credentials.password);
      expect(String(error)).not.toContain(credentials.username);
      expect(fake.loginCalls()).toBe(1);
    }
  });

  it("retries a login OpenReview did not answer, then succeeds", async () => {
    const fake = fakeOpenReview(["throw", 503, 200]);
    const response = await session(fake).get(`${BASE}/notes`, 1000);
    expect(response.status).toBe(200);
    expect(fake.loginCalls()).toBe(3);
  });

  it("does not blame the credentials when OpenReview stays unreachable", async () => {
    const fake = fakeOpenReview([429]);
    const openreview = session(fake);
    const error = await openreview.profileId().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenReviewLoginError);
    expect(error).toMatchObject({ credentialsRejected: false });
    expect(fake.loginCalls()).toBe(3);
    // A failed login is not cached: the next call tries again.
    await openreview.profileId().catch(() => undefined);
    expect(fake.loginCalls()).toBe(6);
  });

  it("returns a 403 that survives a fresh login to the caller, as the resource's problem", async () => {
    const fake = fakeOpenReview([200], { forbiddenPath: "/pdf" });
    const openreview = session(fake);
    const response = await openreview.get(`${BASE}/pdf?id=hidden`, 1000);
    expect(response.status).toBe(403);
    // One renewal, then the answer stands; the session itself still works.
    expect(fake.loginCalls()).toBe(2);
    expect((await openreview.get(`${BASE}/notes`, 1000)).status).toBe(200);
  });
});
