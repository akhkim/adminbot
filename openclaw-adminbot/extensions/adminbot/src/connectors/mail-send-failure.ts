import { setTimeout as delay } from "node:timers/promises";

/**
 * Why a mail send (a `gog gmail send`, or anything else that shells out to gog) failed, sorted by
 * what is safe to do next.
 *
 * - `rate_limited`: Google's per-user burst limit. The request was refused before anything was
 *   sent, so another try a moment later is safe and usually clears it.
 * - `unreachable`: the request never reached Google (DNS, connection refused, network down). No
 *   mail can have gone out, so retrying is safe.
 * - `credentials`: the OAuth token is expired or revoked, or the account lacks the scope. Retrying
 *   cannot fix it; a person has to re-run `gog auth add` on the host.
 * - `connector_missing`: the gog binary is not on the service PATH. Also needs a person.
 * - `ambiguous`: the request may have reached Google and the outcome is unknown (timeout, reset
 *   mid-request, a 5xx). Gmail has no idempotency key, so retrying risks sending the mail twice.
 *   Never retried automatically.
 * - `rejected`: anything else (a bad address, a malformed request). Retrying gives the same answer.
 */
export type MailSendFailureKind =
  | "rate_limited"
  | "unreachable"
  | "credentials"
  | "connector_missing"
  | "ambiguous"
  | "rejected";

const CREDENTIALS_PATTERN =
  /invalid_grant|token (?:has been )?(?:expired|revoked)|expired or revoked|unauthorized_client|invalid_client|\b401\b|unauthenticated|invalid credentials|insufficient (?:authentication )?(?:scopes?|permissions?)|ACCESS_TOKEN_SCOPE_INSUFFICIENT|gog auth add|no (?:oauth )?token (?:found|for)|not authenticated/iu;
const CONNECTOR_MISSING_PATTERN = /executable was not found|command not found/iu;
const RATE_LIMIT_PATTERN = /userRateLimitExceeded|rateLimitExceeded|\b429\b/u;
const UNREACHABLE_PATTERN =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|no such host|connection refused|network is unreachable|temporary failure in name resolution|dial tcp/iu;
const AMBIGUOUS_PATTERN =
  /ETIMEDOUT|ECONNRESET|EPIPE|timed out|timeout|unexpected EOF|connection reset|broken pipe|\b50[0234]\b|backendError|internal error/iu;

type FailureLike = {
  message?: unknown;
  stderr?: unknown;
  code?: unknown;
  killed?: unknown;
  signal?: unknown;
  cause?: unknown;
};

/** Every string an error (and its `cause` chain) carries that could name the failure. */
function failureText(error: unknown): { text: string; codes: string[]; killed: boolean } {
  const parts: string[] = [];
  const codes: string[] = [];
  let killed = false;
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current) && seen.size < 8) {
    seen.add(current);
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    const failure = current as FailureLike;
    // A raw execFile error's message is "Command failed: gog ... --body <the whole email>", so a
    // word like "timeout" in the email body would misclassify it. When stderr is there it is what
    // gog actually said; read that instead of the message.
    if (typeof failure.stderr === "string") {
      parts.push(failure.stderr);
    } else if (typeof failure.message === "string") {
      parts.push(failure.message);
    }
    if (typeof failure.code === "string") {
      codes.push(failure.code);
    }
    if (failure.killed === true || typeof failure.signal === "string") {
      killed = true;
    }
    current = failure.cause;
  }
  return { text: parts.join(" "), codes, killed };
}

export function classifyMailSendFailure(error: unknown): MailSendFailureKind {
  const { text, codes, killed } = failureText(error);
  // The binary itself is missing: nothing ran, but no retry will make it appear.
  if (codes.includes("ENOENT") || CONNECTOR_MISSING_PATTERN.test(text)) {
    return "connector_missing";
  }
  // Credentials before everything else: an expired token often also mentions a token fetch or a
  // network word, and retrying it only repeats the same refusal.
  if (CREDENTIALS_PATTERN.test(text)) {
    return "credentials";
  }
  if (RATE_LIMIT_PATTERN.test(text)) {
    return "rate_limited";
  }
  // A process killed by execFile's timeout may have handed the message to Google already.
  if (killed || codes.includes("ETIMEDOUT") || codes.includes("ECONNRESET")) {
    return "ambiguous";
  }
  if (codes.some((code) => UNREACHABLE_PATTERN.test(code)) || UNREACHABLE_PATTERN.test(text)) {
    return "unreachable";
  }
  if (AMBIGUOUS_PATTERN.test(text)) {
    return "ambiguous";
  }
  return "rejected";
}

/** Only failures where nothing can have been sent are retried; see MailSendFailureKind. */
export function isRetryableMailSendFailure(error: unknown): boolean {
  const kind = classifyMailSendFailure(error);
  return kind === "rate_limited" || kind === "unreachable";
}

/** A failure a person has to fix on the host; surfaced to admins rather than retried. */
export function needsOperatorForMailFailure(kind: MailSendFailureKind): boolean {
  return kind === "credentials" || kind === "connector_missing";
}

/**
 * A gog error that proves the request never reached Google, so nothing can have been sent.
 *
 * Anything else on a failed send is ambiguous -- the mail may have gone out -- and callers that
 * would repeat a message on retry treat it as sent rather than risk mailing the same thing twice.
 */
export function gogFailedBeforeSending(message: string): boolean {
  if (!/\bgog\b/u.test(message)) {
    return false;
  }
  const kind = classifyMailSendFailure(message);
  return needsOperatorForMailFailure(kind) || kind === "unreachable" || kind === "rate_limited";
}

export type MailRetryOptions = {
  /** Total tries, including the first. */
  maxAttempts: number;
  baseDelayMs?: number;
  jitterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

/**
 * Error thrown when a mail send gives up, carrying how many tries were made and why it stopped so
 * the caller can audit both without re-deriving them.
 */
export class MailSendFailedError extends Error {
  readonly attempts: number;
  readonly kind: MailSendFailureKind;
  constructor(cause: unknown, attempts: number, kind: MailSendFailureKind) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "MailSendFailedError";
    this.attempts = attempts;
    this.kind = kind;
  }
}

/**
 * Runs `send`, retrying only failures where nothing can have gone out (rate limits, unreachable
 * network), with exponential backoff and jitter. Credential, ambiguous and rejected failures stop
 * at once: the first needs a person, the second could double-send, the third would fail the same
 * way. Resolves with the number of tries it took; rejects with a MailSendFailedError.
 */
export async function sendMailWithRetry(
  send: () => Promise<void>,
  options: MailRetryOptions,
): Promise<number> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts));
  const baseDelayMs = options.baseDelayMs ?? 500;
  const jitterMs = options.jitterMs ?? 250;
  const sleep = options.sleep ?? ((ms: number) => delay(ms).then(() => undefined));
  const random = options.random ?? Math.random;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await send();
      return attempt;
    } catch (error) {
      const kind = classifyMailSendFailure(error);
      const retryable = kind === "rate_limited" || kind === "unreachable";
      if (!retryable || attempt >= maxAttempts) {
        throw new MailSendFailedError(error, attempt, kind);
      }
      await sleep(baseDelayMs * 2 ** (attempt - 1) + Math.floor(random() * jitterMs));
    }
  }
}
