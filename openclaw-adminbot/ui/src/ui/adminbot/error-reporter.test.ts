// What the browser tells AdminBot about its own failures, and what it never does.
import { describe, expect, it, vi } from "vitest";
import {
  createErrorReporter,
  ERROR_REPORT_QUEUE_MAX,
  ERROR_REPORTS_PER_MINUTE,
  ERROR_REPORTS_PER_SESSION,
  scrub,
  type ErrorReportPayload,
} from "./error-reporter.ts";

const BASE = "https://lab.example:8443";

type Sent = { url: string; init: RequestInit; body: ErrorReportPayload };

function harness(options: { signedIn?: boolean; reportStatus?: number } = {}) {
  const sent: Sent[] = [];
  let clock = Date.UTC(2026, 0, 1);
  let signedIn = options.signedIn ?? true;
  let offline = false;
  // Stands in for the page's real fetch: the reporter's own requests arrive here.
  const reportFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (offline) {
      throw new TypeError("Failed to fetch");
    }
    sent.push({
      url: String(input),
      init: init ?? {},
      body: JSON.parse(String(init?.body)) as ErrorReportPayload,
    });
    return new Response("{}", { status: options.reportStatus ?? 200 });
  });
  const reporter = createErrorReporter({
    fetch: reportFetch as unknown as typeof fetch,
    session: () => (signedIn ? { token: "session-token", baseUrl: BASE } : null),
    page: () => "/papers?draft=my-secret-title#section",
    build: "build-123",
    userAgent: "TestBrowser/1.0",
    now: () => clock,
  });
  return {
    reporter,
    sent,
    reportFetch,
    advance: (ms: number) => {
      clock += ms;
    },
    setSignedIn: (value: boolean) => {
      signedIn = value;
    },
    setOffline: (value: boolean) => {
      offline = value;
    },
  };
}

/** Lets the reporter's own promise chains run to completion. */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

describe("the browser error reporter", () => {
  it("reports an uncaught error with where it happened and nothing about the query string", async () => {
    const { reporter, sent } = harness();
    reporter.reportError("error", new TypeError("x is undefined"));
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`${BASE}/ui/errors`);
    expect(sent[0]?.init).toMatchObject({ method: "POST", keepalive: true, credentials: "omit" });
    expect(sent[0]?.body).toMatchObject({
      kind: "error",
      name: "TypeError",
      message: "x is undefined",
      page: "/papers",
      build: "build-123",
      user_agent: "TestBrowser/1.0",
    });
    expect(sent[0]?.body.stack).toContain("TypeError");
    expect(JSON.stringify(sent[0]?.body)).not.toContain("my-secret-title");
    // Who it is from is the service's call: the body names nobody.
    expect(JSON.stringify(sent[0]?.body)).not.toContain("session-token");
  });

  it("strips query strings, tokens and addresses out of messages and stacks", async () => {
    const { reporter, sent } = harness();
    const error = new Error(
      "GET https://lab.example/papers?invite=abc123&q=hidden failed for ada@cs.toronto.edu (Bearer aaa.bbb.ccc)",
    );
    error.stack = `Error: boom\n    at load (https://lab.example/assets/app.js?v=77aa:1:2)\n    at ${"k".repeat(40)}`;
    reporter.reportError("unhandled_rejection", error);
    await settle();

    const body = JSON.stringify(sent[0]?.body);
    for (const leaked of ["abc123", "hidden", "ada@", "aaa.bbb.ccc", "v=77aa", "k".repeat(40)]) {
      expect(body).not.toContain(leaked);
    }
    expect(sent[0]?.body.stack).toContain("https://lab.example/assets/app.js:1:2");
    expect(scrub("/lab/members?email=a@b.co")).toBe("/lab/members");
  });

  it("describes a rejected non-error without serializing it", async () => {
    const { reporter, sent } = harness();
    reporter.reportError("unhandled_rejection", { password: "hunter2", form: { ssn: "1" } });
    reporter.reportError("unhandled_rejection", "plain string reason");
    await settle();

    expect(sent.map((entry) => entry.body.message)).toEqual([
      "Non-error value thrown (object)",
      "plain string reason",
    ]);
    expect(JSON.stringify(sent)).not.toContain("hunter2");
  });

  it("sends one report for the same error however often it repeats", async () => {
    const { reporter, sent } = harness();
    const error = new Error("render loop");
    for (let index = 0; index < 200; index += 1) {
      reporter.reportError("error", error);
    }
    await settle();
    expect(sent).toHaveLength(1);
  });

  it("caps reports per minute and per page load", async () => {
    const { reporter, sent, advance } = harness();
    for (let index = 0; index < 20; index += 1) {
      reporter.reportError("error", new Error(`first minute ${"x".repeat(index)}`));
    }
    await settle();
    expect(sent).toHaveLength(ERROR_REPORTS_PER_MINUTE);

    for (let minute = 0; minute < 20; minute += 1) {
      advance(60_000);
      for (let index = 0; index < 20; index += 1) {
        reporter.reportError("error", new Error(`minute ${minute} ${"y".repeat(index)}`));
      }
      await settle();
    }
    expect(sent).toHaveLength(ERROR_REPORTS_PER_SESSION);
  });

  it("sends nothing when nobody is signed in", async () => {
    const { reporter, sent, reportFetch } = harness({ signedIn: false });
    reporter.reportError("error", new Error("signed out"));
    await settle();
    expect(sent).toEqual([]);
    expect(reportFetch).not.toHaveBeenCalled();
  });

  it("never throws, whatever it is handed and whatever the send does", async () => {
    const reporter = createErrorReporter({
      fetch: (() => {
        throw new Error("fetch itself is broken");
      }) as unknown as typeof fetch,
      session: () => ({ token: "t", baseUrl: BASE }),
      page: () => {
        throw new Error("no location");
      },
    });
    const hostile = {
      get message(): string {
        throw new Error("getter trap");
      },
    };
    expect(() => {
      reporter.reportError("error", hostile);
      reporter.reportError("error", undefined);
      reporter.reportError("error", null);
      reporter.reportError("error", new Error("fine"));
      reporter.flush();
    }).not.toThrow();
    await settle();
  });
});

describe("failed AdminBot requests", () => {
  function wrapped(
    respond: (url: string) => Promise<Response>,
    options: Parameters<typeof harness>[0] = {},
  ) {
    const h = harness(options);
    const original = vi.fn((input: RequestInfo | URL) => respond(String(input)));
    const fetched = h.reporter.wrapFetch(original as unknown as typeof fetch);
    return { ...h, original, fetched };
  }

  it("reports a 5xx with method, route path and status, and leaves the response alone", async () => {
    const response = new Response('{"secret":"body"}', { status: 503 });
    const { fetched, sent } = wrapped(async () => response);
    const result = await fetched(`${BASE}/papers/42?search=private`, {
      method: "put",
      headers: { Authorization: "Bearer session-token" },
      body: JSON.stringify({ title: "Unpublished result" }),
    });
    await settle();

    expect(result).toBe(response);
    expect(result.bodyUsed).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({
      kind: "api",
      api_method: "PUT",
      api_path: "/papers/42",
      api_status: 503,
      message: "PUT /papers/42 answered 503",
    });
    const body = JSON.stringify(sent[0]?.body);
    for (const leaked of ["private", "Unpublished", "secret", "session-token"]) {
      expect(body).not.toContain(leaked);
    }
  });

  it("does not report a 4xx or a success", async () => {
    const statuses = [200, 204, 400, 401, 403, 404, 409, 429];
    const { fetched, sent } = wrapped(
      async (url) => new Response(null, { status: Number(url.split("/").at(-1)) }),
    );
    for (const status of statuses) {
      await fetched(`${BASE}/status/${status}`);
    }
    await settle();
    expect(sent).toEqual([]);
  });

  it("reports a request that got no answer, and hands the caller the same rejection", async () => {
    const failure = new TypeError("Failed to fetch");
    const { fetched, sent } = wrapped(async () => {
      throw failure;
    });
    await expect(fetched(`${BASE}/rooms`)).rejects.toBe(failure);
    await settle();
    expect(sent[0]?.body).toMatchObject({
      kind: "api",
      api_method: "GET",
      api_path: "/rooms",
      api_status: 0,
    });
  });

  it("ignores a request the page cancelled", async () => {
    const { fetched, sent } = wrapped(async () => {
      throw new DOMException("The user aborted a request.", "AbortError");
    });
    await expect(fetched(`${BASE}/rooms`)).rejects.toThrow();
    await settle();
    expect(sent).toEqual([]);
  });

  it("ignores requests to anywhere that is not AdminBot", async () => {
    const { fetched, sent } = wrapped(async () => new Response(null, { status: 500 }));
    await fetched("https://api.elsewhere.example/v1/thing");
    await fetched(`${BASE}.evil.example/papers`);
    await settle();
    expect(sent).toEqual([]);
  });

  it("never reports a failure of the report route, even when it is called through the wrapper", async () => {
    const { fetched, sent, reportFetch } = wrapped(async () => new Response(null, { status: 500 }));
    await fetched(`${BASE}/ui/errors`, { method: "POST" });
    await fetched(`${BASE}/ui/errors?x=1`, { method: "POST" });
    await settle();
    expect(sent).toEqual([]);
    expect(reportFetch).not.toHaveBeenCalled();
  });

  it("does not loop when the report route itself is failing", async () => {
    // The service is down: every request 500s, including the reports about that.
    const { fetched, sent, reportFetch, original } = wrapped(
      async () => new Response(null, { status: 500 }),
      { reportStatus: 500 },
    );
    await fetched(`${BASE}/papers`);
    await fetched(`${BASE}/rooms`);
    await settle();

    // Two failures, two reports, each tried once; the refusals produced no reports of their own,
    // and the reports never went through the observed fetch.
    expect(sent.map((entry) => entry.body.api_path)).toEqual(["/papers", "/rooms"]);
    expect(reportFetch).toHaveBeenCalledTimes(2);
    expect(original).toHaveBeenCalledTimes(2);
  });

  it("holds a few undelivered reports while offline and sends them once, later", async () => {
    const { reporter, sent, reportFetch, setOffline, advance } = wrapped(
      async () => new Response(null, { status: 200 }),
    );
    setOffline(true);
    for (let minute = 0; minute < 4; minute += 1) {
      for (let index = 0; index < ERROR_REPORTS_PER_MINUTE; index += 1) {
        reporter.reportError("error", new Error(`offline ${minute} ${"z".repeat(index)}`));
      }
      advance(60_000);
      await settle();
    }
    expect(sent).toEqual([]);

    setOffline(false);
    const attempts = reportFetch.mock.calls.length;
    reporter.flush();
    await settle();
    expect(sent).toHaveLength(ERROR_REPORT_QUEUE_MAX);
    expect(reportFetch.mock.calls.length).toBe(attempts + ERROR_REPORT_QUEUE_MAX);
    reporter.flush();
    await settle();
    expect(sent).toHaveLength(ERROR_REPORT_QUEUE_MAX);
  });
});
