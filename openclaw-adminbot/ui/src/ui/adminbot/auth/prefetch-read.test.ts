// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import { forgetSessionReads } from "./read-cache.ts";
import {
  authedJson,
  clearStoredMemberSession,
  prefetchAuthedRead,
  saveStoredMemberSession,
} from "./session.ts";

const BASE = "http://127.0.0.1:8787";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// The read path awaits the offline store before and after the request; give it real turns.
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function bodyOf(result: Awaited<ReturnType<typeof authedJson>>): Promise<unknown> {
  if ("unreachable" in result) {
    throw new Error("unreachable");
  }
  return result.body;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("location", { hostname: "127.0.0.1" } as Location);
  forgetSessionReads();
});

afterEach(() => {
  forgetSessionReads();
  vi.unstubAllGlobals();
});

describe("prefetchAuthedRead", () => {
  it("lets the loader that asks while it is in flight share the one request", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { member: { id: "ada" } }));
    vi.stubGlobal("fetch", fetchMock);
    prefetchAuthedRead(BASE, "/lab/members/self", "tok");
    const result = await authedJson(BASE, "/lab/members/self", "GET", "tok");
    expect(await bodyOf(result)).toEqual({ member: { id: "ada" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("answers the next loader once from the finished prefetch, then goes back to the service", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { member: { id: "ada" } }));
    vi.stubGlobal("fetch", fetchMock);
    prefetchAuthedRead(BASE, "/lab/members/self", "tok");
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const first = await authedJson(BASE, "/lab/members/self", "GET", "tok");
    expect(await bodyOf(first)).toEqual({ member: { id: "ada" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await authedJson(BASE, "/lab/members/self", "GET", "tok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never keeps a refusal: the loader's own request reports the real state", async () => {
    for (const status of [401, 403, 500]) {
      forgetSessionReads();
      const fetchMock = vi.fn(async () => jsonResponse(status, { error: { message: "no" } }));
      vi.stubGlobal("fetch", fetchMock);
      prefetchAuthedRead(BASE, "/lab/members/self", "tok");
      await settle();
      const result = await authedJson(BASE, "/lab/members/self", "GET", "tok");
      expect("unreachable" in result ? 0 : result.response.status).toBe(status);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("shows a permission change even right after a successful prefetch was used", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(200, { member: { id: "ada" } }))
      .mockResolvedValue(jsonResponse(403, { error: { message: "forbidden" } }));
    vi.stubGlobal("fetch", fetchMock);
    prefetchAuthedRead(BASE, "/lab/members/self", "tok");
    await settle();
    await authedJson(BASE, "/lab/members/self", "GET", "tok");
    const next = await authedJson(BASE, "/lab/members/self", "GET", "tok");
    expect("unreachable" in next ? 0 : next.response.status).toBe(403);
  });

  it("is not used by another session", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { member: { id: "ada" } }));
    vi.stubGlobal("fetch", fetchMock);
    prefetchAuthedRead(BASE, "/lab/members/self", "ada-token");
    await settle();
    await authedJson(BASE, "/lab/members/self", "GET", "bob-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is dropped by a write", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { member: { id: "ada" } }));
    vi.stubGlobal("fetch", fetchMock);
    prefetchAuthedRead(BASE, "/lab/members/self", "tok");
    await settle();
    await authedJson(BASE, "/lab/members/self", "PUT", "tok", { name: "Ada" });
    await authedJson(BASE, "/lab/members/self", "GET", "tok");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("is dropped when a write lands while the prefetch is still in flight", async () => {
    let release: (response: Response) => void = () => undefined;
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)))
      .mockImplementation(async () => jsonResponse(200, { member: { id: "ada", name: "New" } }));
    vi.stubGlobal("fetch", fetchMock);
    prefetchAuthedRead(BASE, "/lab/members/self", "tok");
    await settle();
    await authedJson(BASE, "/lab/members/self", "PUT", "tok", { name: "New" });
    release(jsonResponse(200, { member: { id: "ada", name: "Old" } }));
    await settle();
    const result = await authedJson(BASE, "/lab/members/self", "GET", "tok");
    expect(await bodyOf(result)).toEqual({ member: { id: "ada", name: "New" } });
  });

  it("is dropped on sign-out and on a change of session", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { member: { id: "ada" } }));
    vi.stubGlobal("fetch", fetchMock);
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "2999-01-01T00:00:00Z" });
    prefetchAuthedRead(BASE, "/lab/members/self", "tok");
    await settle();
    clearStoredMemberSession();
    await authedJson(BASE, "/lab/members/self", "GET", "tok");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    prefetchAuthedRead(BASE, "/lab/members/self", "tok");
    await settle();
    saveStoredMemberSession({ sessionToken: "other", expiresAt: "2999-01-01T00:00:00Z" });
    await authedJson(BASE, "/lab/members/self", "GET", "tok");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("survives the reset that resuming a session performs when renewed", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { member: { id: "ada" } }));
    vi.stubGlobal("fetch", fetchMock);
    const read = prefetchAuthedRead(BASE, "/lab/members/self", "tok");
    await settle();
    forgetSessionReads();
    read.renew();
    const result = await authedJson(BASE, "/lab/members/self", "GET", "tok");
    expect(await bodyOf(result)).toEqual({ member: { id: "ada" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives the loader its own copy of the body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { member: { id: "ada" } }));
    vi.stubGlobal("fetch", fetchMock);
    prefetchAuthedRead(BASE, "/lab/members/self", "tok");
    const joined = await authedJson(BASE, "/lab/members/self", "GET", "tok");
    ((await bodyOf(joined)) as { member: { id: string } }).member.id = "edited";
    await settle();
    const next = await authedJson(BASE, "/lab/members/self", "GET", "tok");
    expect(await bodyOf(next)).toEqual({ member: { id: "ada" } });
  });
});
