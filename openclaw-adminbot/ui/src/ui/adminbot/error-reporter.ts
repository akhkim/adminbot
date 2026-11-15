// Tells AdminBot when the Control UI breaks for somebody.
//
// Three things are reported, from every signed-in member on every page: an exception nobody
// caught, a promise rejection nobody handled, and an AdminBot request that failed on the service's
// side (a 5xx) or never got an answer. A 4xx is not reported: "sign in again", "that field is
// required" and "admins only" are the service working, and they would bury the real failures.
//
// The rules this file exists to keep:
//   - It never throws and never rejects. A reporter that can break the page is worse than none.
//   - It never reports its own failures, and its own request never passes through the observer,
//     so a broken report route cannot feed itself.
//   - It sends only what describes the failure: a message, the error's name, a trimmed stack, the
//     page path, the build, the user agent, and for a request its method, route path and status.
//     No request or response body, no headers, no query string, no form contents; `scrub` also
//     strips anything token- or address-shaped that an error message happened to quote.
//   - It is cheap: one report per distinct problem per page load, a handful a minute, a few dozen
//     per page load at most.
//
// Who the report is from, and when, is decided by the service: the member comes from the session
// and the time from its own clock, so neither can be claimed by a page.

export type ErrorReportKind = "error" | "unhandled_rejection" | "api";

export type ErrorReportPayload = {
  kind: ErrorReportKind;
  message: string;
  name?: string;
  stack?: string;
  page?: string;
  build?: string;
  user_agent?: string;
  api_method?: string;
  api_path?: string;
  api_status?: number;
};

export type ErrorReporterDeps = {
  /** The page's real fetch, captured before anything wraps it. */
  fetch: typeof fetch;
  /** The signed-in member's wire, or null when nobody is signed in (nothing is sent then). */
  session: () => { token: string; baseUrl: string } | null;
  /** The current page path. */
  page: () => string;
  build?: string;
  userAgent?: string;
  now?: () => number;
};

export type ErrorReporter = {
  reportError(kind: "error" | "unhandled_rejection", thrown: unknown): void;
  /** A fetch that behaves exactly like the one given, and notes AdminBot requests that fail. */
  wrapFetch(original: typeof fetch): typeof fetch;
  /** Tries again to send reports that could not be delivered. */
  flush(): void;
};

export const ERROR_REPORT_PATH = "/ui/errors";
/** Reports per minute, and per page load. A page in a crash loop says so once, not a thousand times. */
export const ERROR_REPORTS_PER_MINUTE = 5;
export const ERROR_REPORTS_PER_SESSION = 30;
/** Undelivered reports kept for a retry. Small: a browser that is offline learns little new. */
export const ERROR_REPORT_QUEUE_MAX = 10;

const MESSAGE_MAX = 500;
const STACK_MAX = 4000;
const STACK_LINES = 12;

/**
 * Strips what an error string must not carry off the device.
 *
 * The same rules the service applies again on arrival (contracts/error-log.ts): query strings and
 * fragments, bearer tokens, email addresses, and long opaque runs. Doing it here as well means the
 * secret never leaves the browser in the first place.
 */
export function scrub(value: string): string {
  return (
    value
      // The lookahead leaves a stack frame's trailing :line:column in place.
      .replace(
        /([a-z][a-z0-9+.-]*:\/\/[^\s?#)'"]+)[?#][^\s)'"]*?(?=(?::\d+){0,2}(?:[\s)'"]|$))/giu,
        "$1",
      )
      .replace(/(?<=[\w/.-])\?[\w%.~+-]+=[^\s)'"]*?(?=(?::\d+){0,2}(?:[\s)'"]|$))/gu, "")
      .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/gu, "[email]")
      .replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]")
  );
}

function pathOnly(value: string): string {
  return scrub(value.split(/[?#]/u)[0] ?? "").slice(0, 200);
}

function trimStack(stack: unknown): string | undefined {
  if (typeof stack !== "string" || !stack.trim()) {
    return undefined;
  }
  return scrub(stack.split("\n").slice(0, STACK_LINES).join("\n")).slice(0, STACK_MAX);
}

function describe(thrown: unknown): { message: string; name?: string; stack?: string } {
  if (thrown instanceof Error) {
    const stack = trimStack(thrown.stack);
    return {
      message: scrub(thrown.message || thrown.name || "Error").slice(0, MESSAGE_MAX),
      ...(thrown.name ? { name: thrown.name.slice(0, 80) } : {}),
      ...(stack ? { stack } : {}),
    };
  }
  if (typeof thrown === "string") {
    return { message: scrub(thrown || "Unknown error").slice(0, MESSAGE_MAX) };
  }
  // A rejected object is described by its message if it has one and by its type otherwise. It is
  // never serialized: a rejected fetch wrapper or form model can hold exactly what must not be sent.
  const message = (thrown as { message?: unknown } | null)?.message;
  return {
    message:
      typeof message === "string" && message
        ? scrub(message).slice(0, MESSAGE_MAX)
        : `Non-error value thrown (${thrown === null ? "null" : typeof thrown})`,
  };
}

function requestTarget(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): { url: string; method: string } | null {
  try {
    if (typeof input === "string") {
      return { url: input, method: (init?.method ?? "GET").toUpperCase() };
    }
    if (input instanceof URL) {
      return { url: input.href, method: (init?.method ?? "GET").toUpperCase() };
    }
    return { url: input.url, method: (init?.method ?? input.method ?? "GET").toUpperCase() };
  } catch {
    return null;
  }
}

export function createErrorReporter(deps: ErrorReporterDeps): ErrorReporter {
  const now = deps.now ?? (() => Date.now());
  const seen = new Set<string>();
  const queue: ErrorReportPayload[] = [];
  let sentThisSession = 0;
  let minuteStartedAt = 0;
  let sentThisMinute = 0;
  let sending = false;

  /** Whether the budget allows another report, spending one if so. */
  function spend(): boolean {
    if (sentThisSession >= ERROR_REPORTS_PER_SESSION) {
      return false;
    }
    const at = now();
    if (at - minuteStartedAt >= 60_000) {
      minuteStartedAt = at;
      sentThisMinute = 0;
    }
    if (sentThisMinute >= ERROR_REPORTS_PER_MINUTE) {
      return false;
    }
    sentThisMinute += 1;
    sentThisSession += 1;
    return true;
  }

  function submit(report: Omit<ErrorReportPayload, "page" | "build" | "user_agent">): void {
    // Nobody signed in means nobody to report as, and the route would answer 401.
    if (!deps.session()) {
      return;
    }
    const key = [
      report.kind,
      report.name ?? "",
      report.message,
      report.stack?.split("\n")[1] ?? "",
      report.api_method ?? "",
      report.api_path ?? "",
      report.api_status ?? "",
    ].join("|");
    if (seen.has(key)) {
      return;
    }
    // Remembered before the budget is checked: a problem dropped for being over budget stays
    // dropped, instead of trickling out one a minute for the rest of the page's life.
    if (seen.size < 500) {
      seen.add(key);
    }
    if (!spend()) {
      return;
    }
    if (queue.length >= ERROR_REPORT_QUEUE_MAX) {
      queue.shift();
    }
    queue.push({
      ...report,
      page: pathOnly(deps.page()),
      ...(deps.build ? { build: deps.build.slice(0, 80) } : {}),
      ...(deps.userAgent ? { user_agent: deps.userAgent.slice(0, 300) } : {}),
    });
    void drain();
  }

  async function drain(): Promise<void> {
    if (sending) {
      return;
    }
    sending = true;
    try {
      while (queue.length > 0) {
        const wire = deps.session();
        if (!wire) {
          // Signed out since: these belong to a session that is over.
          queue.length = 0;
          return;
        }
        try {
          // `deps.fetch` is the unwrapped fetch, so this request is invisible to `wrapFetch` and
          // its failure can never become a report. keepalive lets it outlive a closing tab.
          // sendBeacon is not used because it cannot carry the Authorization header.
          await deps.fetch(`${wire.baseUrl}${ERROR_REPORT_PATH}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${wire.token}` },
            body: JSON.stringify(queue[0]),
            keepalive: true,
            credentials: "omit",
          });
        } catch {
          // No answer at all: keep what is queued for `flush`, and stop trying for now.
          return;
        }
        // Any answer ends it, refusals included. A report the service turned down is not retried.
        queue.shift();
      }
    } catch {
      // Never out of here.
    } finally {
      sending = false;
    }
  }

  function observe(
    target: { url: string; method: string },
    outcome: { status: number } | { error: unknown },
  ): void {
    const wire = deps.session();
    if (!wire) {
      return;
    }
    const prefix = `${wire.baseUrl}/`;
    if (!target.url.startsWith(prefix)) {
      return;
    }
    const path = pathOnly(target.url.slice(wire.baseUrl.length));
    if (path === ERROR_REPORT_PATH) {
      return;
    }
    if ("status" in outcome) {
      if (outcome.status < 500) {
        return;
      }
      submit({
        kind: "api",
        message: `${target.method} ${path} answered ${outcome.status}`,
        api_method: target.method,
        api_path: path,
        api_status: outcome.status,
      });
      return;
    }
    // A request the page itself cancelled (a tab switch, a superseded search) is not a failure.
    const name = (outcome.error as { name?: unknown } | null)?.name;
    if (name === "AbortError" || name === "TimeoutError") {
      return;
    }
    submit({
      kind: "api",
      message: `${target.method} ${path} got no answer`,
      ...(typeof name === "string" && name ? { name: name.slice(0, 80) } : {}),
      api_method: target.method,
      api_path: path,
      api_status: 0,
    });
  }

  return {
    reportError(kind, thrown) {
      try {
        submit({ kind, ...describe(thrown) });
      } catch {
        // Never out of here.
      }
    },
    wrapFetch(original) {
      return function reportingFetch(this: unknown, input, init) {
        // The caller gets the original promise, untouched: same value, same rejection, same
        // timing. The observer hangs off a separate branch that swallows its own errors.
        const result = original.call(this, input, init);
        try {
          const target = requestTarget(input, init);
          if (target) {
            result.then(
              (response) => {
                try {
                  observe(target, { status: response.status });
                } catch {
                  // Never out of here.
                }
              },
              (error: unknown) => {
                try {
                  observe(target, { error });
                } catch {
                  // Never out of here.
                }
              },
            );
          }
        } catch {
          // Never out of here.
        }
        return result;
      } as typeof fetch;
    },
    flush() {
      void drain();
    },
  };
}
