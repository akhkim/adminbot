// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { memberAuthHeaders } from "../adminbot/api/device-clock.ts";
import { forgetSessionReads } from "../adminbot/auth/read-cache.ts";
import { authedJson, fetchMemberSession } from "../adminbot/auth/session.ts";
import { buildBootReadPlan } from "./boot-read-plan.ts";
import { BOOT_READS_STORAGE_KEY, forgetBootResponses, takeBootResponse } from "./boot-reads.ts";

const BASE = "https://adminbot.example.test";
const here = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(path.resolve(here, "../../../index.html"), "utf8");

function bootReadScript(): string {
  const scripts = [...indexHtml.matchAll(/<script>([^]*?)<\/script>/g)].map((m) => m[1]);
  const script = scripts.find((source) => source.includes(BOOT_READS_STORAGE_KEY));
  if (!script) {
    throw new Error("ui/index.html has no boot-read script");
  }
  return script;
}

type Sent = { url: string; init: RequestInit };

// Runs the inline script the way the browser would, with its globals stubbed.
function runBootReadScript(storage: Storage, pathname: string): { sent: Sent[]; reads: unknown } {
  const sent: Sent[] = [];
  const window: Record<string, unknown> = {};
  const head = { appendChild: vi.fn() };
  runInNewContext(bootReadScript(), {
    window,
    localStorage: storage,
    location: { pathname },
    document: { head, createElement: () => ({}) },
    fetch: (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
    AbortSignal,
    Intl,
    Date,
    JSON,
    String,
  });
  return { sent, reads: window.__adminbotBootReads };
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

let storage: Storage;

beforeEach(() => {
  storage = createStorageMock();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("location", { hostname: "127.0.0.1" } as Location);
  forgetSessionReads();
});

afterEach(() => {
  forgetBootResponses();
  delete (globalThis as { __adminbotBootReads?: unknown }).__adminbotBootReads;
  vi.unstubAllGlobals();
});

function storeSession(token = "tok", expiresAt = "2999-01-01T00:00:00Z"): void {
  storage.setItem(
    "openclaw.adminbot.session.v1",
    JSON.stringify({ sessionToken: token, expiresAt }),
  );
}

function storePlan(): void {
  storage.setItem(BOOT_READS_STORAGE_KEY, JSON.stringify(buildBootReadPlan(BASE, "")));
}

describe("buildBootReadPlan", () => {
  it("lists each page's first read under its route, and the profile for every route", () => {
    const plan = buildBootReadPlan(BASE, "/ui");
    expect(plan.always).toEqual(["/lab/members/self"]);
    expect(plan.routes["/ui/lab-projects"]).toEqual(["/lab/projects"]);
    expect(plan.routes["/ui/members"]).toEqual([
      "/lab/members/roster?limit=50&offset=0",
      "/lab/members/requests",
      "/papers",
    ]);
    // The retired ARR path opens Lab Members, so a cold load there starts the same reads.
    expect(plan.routes["/ui/arr-eligible-reviewers"]).toEqual(plan.routes["/ui/members"]);
    expect(JSON.stringify(plan)).not.toContain("tok");
  });
});

describe("the inline boot-read script", () => {
  it("sends the session check, the profile and the route's read with the app's own headers", () => {
    storeSession();
    storePlan();
    const { sent } = runBootReadScript(storage, "/lab-projects/");
    expect(sent.map((s) => s.url)).toEqual([
      `${BASE}/auth/session`,
      `${BASE}/lab/members/self`,
      `${BASE}/lab/projects`,
    ]);
    // Same header set as authedJsonOnce / fetchMemberSession, so the cached preflight applies.
    const auth = memberAuthHeaders("tok");
    expect(headersOf(sent[0].init)).toEqual({ Accept: "application/json", ...auth });
    expect(headersOf(sent[2].init)).toEqual({
      "Content-Type": "application/json",
      Accept: "application/json",
      ...auth,
    });
    expect(sent.every((s) => s.init.credentials === "omit")).toBe(true);
  });

  it("sends nothing without a session, with an expired one, or without a plan", () => {
    storePlan();
    expect(runBootReadScript(storage, "/lab-projects").sent).toEqual([]);
    storeSession("tok", "2000-01-01T00:00:00Z");
    expect(runBootReadScript(storage, "/lab-projects").sent).toEqual([]);
    storage.removeItem(BOOT_READS_STORAGE_KEY);
    storeSession();
    expect(runBootReadScript(storage, "/lab-projects").sent).toEqual([]);
  });
});

describe("taking boot responses", () => {
  function plant(url: string, token: string, at = Date.now()): Promise<Response> {
    const response = Promise.resolve(
      new Response(JSON.stringify({ projects: [1] }), { status: 200 }),
    );
    const g = globalThis as { __adminbotBootReads?: Record<string, unknown> };
    g.__adminbotBootReads ??= {};
    g.__adminbotBootReads[url] = { token, at, response };
    return response;
  }

  it("hands a response over once, only for the same token and only while young", () => {
    const response = plant(`${BASE}/lab/projects`, "tok");
    expect(takeBootResponse(`${BASE}/lab/projects`, "other")).toBeUndefined();
    plant(`${BASE}/lab/projects`, "tok");
    expect(takeBootResponse(`${BASE}/lab/projects`, "tok")).toBeDefined();
    expect(takeBootResponse(`${BASE}/lab/projects`, "tok")).toBeUndefined();
    void response;
    plant(`${BASE}/badges`, "tok", Date.now() - 60_000);
    expect(takeBootResponse(`${BASE}/badges`, "tok")).toBeUndefined();
  });

  it("lets the page's loader use the boot response instead of sending the GET again", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    plant(`${BASE}/lab/projects`, "tok");
    const result = await authedJson(BASE, "/lab/projects", "GET", "tok");
    expect("unreachable" in result ? null : result.body).toEqual({ projects: [1] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets the session check use the boot response too", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const g = globalThis as { __adminbotBootReads?: Record<string, unknown> };
    g.__adminbotBootReads = {
      [`${BASE}/auth/session`]: {
        token: "tok",
        at: Date.now(),
        response: Promise.resolve(
          new Response(
            JSON.stringify({ member: { id: "ada" }, expires_at: "2999-01-01T00:00:00Z" }),
          ),
        ),
      },
    };
    await fetchMemberSession("tok", BASE);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
