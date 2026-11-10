import { describe, expect, it } from "vitest";
import {
  classifyMailSendFailure,
  isRetryableMailSendFailure,
  MailSendFailedError,
  sendMailWithRetry,
} from "./mail-send-failure.js";

const exit = (stderr: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error("Command failed: gog gmail send --body <synthetic>"), {
    code: 1,
    stderr,
    ...extra,
  });

describe("classifyMailSendFailure", () => {
  it.each([
    ["Google API error (403 rateLimitExceeded)", "rate_limited"],
    ["HTTP 429 Too Many Requests", "rate_limited"],
    ["dial tcp: lookup gmail.googleapis.com: no such host", "unreachable"],
    ["connect: connection refused", "unreachable"],
    ['oauth2: "invalid_grant" "Token has been expired or revoked."', "credentials"],
    ["Google API error (401 UNAUTHENTICATED)", "credentials"],
    ["Request had insufficient authentication scopes.", "credentials"],
    ["Google API error (500 backendError)", "ambiguous"],
    ["read: connection reset by peer", "ambiguous"],
    ["Google API error (400 invalidArgument): Invalid To header", "rejected"],
    // The daily quota is not a burst: retrying it only burns the rest of the day faster.
    ["Google API error (403 quotaExceeded)", "rejected"],
  ])("%s -> %s", (stderr, kind) => {
    expect(classifyMailSendFailure(exit(stderr))).toBe(kind);
  });

  it("treats an expired token as credentials even when the fetch also looks like a network error", () => {
    expect(
      classifyMailSendFailure(exit("oauth2: cannot fetch token: dial tcp ...: invalid_grant")),
    ).toBe("credentials");
  });

  it("calls a process killed by its timeout ambiguous, never retryable", () => {
    const killed = exit("", { code: null, killed: true, signal: "SIGTERM" });
    expect(classifyMailSendFailure(killed)).toBe("ambiguous");
    expect(isRetryableMailSendFailure(killed)).toBe(false);
  });

  it("reads a missing binary and a wrapped cause", () => {
    expect(classifyMailSendFailure(Object.assign(new Error("spawn gog"), { code: "ENOENT" }))).toBe(
      "connector_missing",
    );
    const wrapped = new Error("gog gmail send failed", { cause: exit("no such host") });
    expect(classifyMailSendFailure(wrapped)).toBe("unreachable");
  });

  it("ignores words in the email body that execFile echoes in its message", () => {
    const failure = Object.assign(
      new Error("Command failed: gog gmail send --body Sorry for the timeout, 401 reasons"),
      { code: 1, stderr: "Google API error (400 invalidArgument)" },
    );
    expect(classifyMailSendFailure(failure)).toBe("rejected");
  });
});

describe("sendMailWithRetry", () => {
  it("retries a transient failure with growing backoff and reports the tries it took", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const attempts = await sendMailWithRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw exit("rateLimitExceeded");
        }
      },
      { maxAttempts: 3, jitterMs: 0, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("stops at once on credentials and says why", async () => {
    let calls = 0;
    const failure = await sendMailWithRetry(
      async () => {
        calls += 1;
        throw exit("invalid_grant");
      },
      { maxAttempts: 3, sleep: async () => {} },
    ).catch((error: unknown) => error);
    expect(calls).toBe(1);
    expect(failure).toBeInstanceOf(MailSendFailedError);
    expect(failure).toMatchObject({ attempts: 1, kind: "credentials" });
  });

  it("gives up after the budget with the last kind", async () => {
    let calls = 0;
    const failure = await sendMailWithRetry(
      async () => {
        calls += 1;
        throw exit("no such host");
      },
      { maxAttempts: 3, sleep: async () => {} },
    ).catch((error: unknown) => error);
    expect(calls).toBe(3);
    expect(failure).toMatchObject({ attempts: 3, kind: "unreachable" });
  });
});
