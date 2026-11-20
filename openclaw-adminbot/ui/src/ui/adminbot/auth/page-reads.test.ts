// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import {
  isPrefetchableReadPath,
  prefetchTabDataNow,
  resetPageDataPrefetchForTest,
} from "../../loading/page-data-prefetch.ts";
import { loadSettings } from "../../storage.ts";
import { defaultMailingListRange } from "../controllers/mailing-list.ts";
import {
  ADMINBOT_PAGE_READS,
  registerAdminBotPageReads,
  resetAdminBotPageReadsForTest,
} from "./page-reads.ts";
import { forgetSessionReads } from "./read-cache.ts";
import {
  authedJson,
  clearStoredMemberSession,
  resolveAdminBotBaseUrl,
  saveStoredMemberSession,
} from "./session.ts";

// The address the app itself resolves, so the page read and the loader ask for the same URL.
const base = () => resolveAdminBotBaseUrl(loadSettings());

function tagged(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ETag: '"v1"' },
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("location", { hostname: "127.0.0.1", protocol: "http:" } as Location);
  forgetSessionReads();
  registerAdminBotPageReads();
});

afterEach(() => {
  clearStoredMemberSession();
  forgetSessionReads();
  resetPageDataPrefetchForTest();
  resetAdminBotPageReadsForTest();
  vi.unstubAllGlobals();
});

describe("AdminBot page reads", () => {
  it("lists only reads that are light for the service", () => {
    for (const read of ADMINBOT_PAGE_READS) {
      expect(isPrefetchableReadPath(read.path()), read.tab).toBe(true);
    }
  });

  it("asks for nothing when nobody is signed in", () => {
    const fetchMock = vi.fn(async () => tagged({ projects: [] }));
    vi.stubGlobal("fetch", fetchMock);
    prefetchTabDataNow("adminbotLabProjects");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts the page's read so the page's own loader shares that one request", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "2999-01-01T00:00:00Z" });
    const fetchMock = vi.fn(async () => tagged({ projects: [{ id: "p1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    prefetchTabDataNow("adminbotLabProjects");
    const result = await authedJson(base(), "/lab/projects", "GET", "tok");
    expect("unreachable" in result ? null : result.body).toEqual({ projects: [{ id: "p1" }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${base()}/lab/projects`);
  });

  it("starts every read My Desk makes, so none of them waits on another", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "2999-01-01T00:00:00Z" });
    const fetchMock = vi.fn(async () => tagged({}));
    vi.stubGlobal("fetch", fetchMock);

    prefetchTabDataNow("adminbotProfessor");
    const paths = [
      "/members/profile-overview?view=desk",
      "/nudges/escalated",
      "/papers/pi-review",
      "/papers",
    ];
    expect(fetchMock.mock.calls.map((call) => String(call[0])).toSorted()).toEqual(
      paths.map((path) => `${base()}${path}`).toSorted(),
    );
    await Promise.all(paths.map((path) => authedJson(base(), path, "GET", "tok")));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not ask again for a page that keeps what it loaded for the session", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "2999-01-01T00:00:00Z" });
    const fetchMock = vi.fn(async () => tagged({ badges: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await authedJson(base(), "/badges", "GET", "tok");
    await authedJson(base(), "/badges/nominations?status=pending", "GET", "tok");
    await settle();
    prefetchTabDataNow("adminbotBadges", Date.now() + 60_000);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("starts the Papers page's paper list, slot overview and queues together", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "2999-01-01T00:00:00Z" });
    const fetchMock = vi.fn(async () => tagged({}));
    vi.stubGlobal("fetch", fetchMock);

    prefetchTabDataNow("adminbotPapers");
    const paths = [
      "/papers",
      "/papers/slot-overview",
      "/proposals/pending?view=summary&limit=25",
      "/papers/nudges?limit=25",
      "/papers/conference-rosters",
    ];
    expect(fetchMock.mock.calls.map((call) => String(call[0])).toSorted()).toEqual(
      paths.map((path) => `${base()}${path}`).toSorted(),
    );
    await Promise.all(paths.map((path) => authedJson(base(), path, "GET", "tok")));
    expect(fetchMock).toHaveBeenCalledTimes(paths.length);
  });

  it("asks for the mailing list's default range exactly as the page does", () => {
    const read = ADMINBOT_PAGE_READS.find((r) => r.tab === "adminbotMailingList");
    const { from, to } = defaultMailingListRange();
    expect(read?.path()).toBe(`/papers/mailing-list?from=${from}&to=${to}`);
  });
});
