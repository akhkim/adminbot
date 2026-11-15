import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentWarmEpoch,
  forgetReadsInFlight,
  forgetSessionReads,
  keepWarmRead,
  sharedRead,
  takeWarmRead,
} from "./read-cache.ts";

beforeEach(() => {
  vi.useFakeTimers();
  forgetSessionReads();
});

afterEach(() => {
  forgetSessionReads();
  vi.useRealTimers();
});

describe("sharedRead", () => {
  it("lets a second loader join a read that is still on its way", async () => {
    const start = vi.fn(async () => "rows");
    const first = sharedRead("tok", "/lab/members", start);
    const second = sharedRead("tok", "/lab/members", start);
    expect(start).toHaveBeenCalledTimes(1);
    await expect(Promise.all([first, second])).resolves.toEqual(["rows", "rows"]);
  });

  // A stalled connection (a laptop waking, a dropped network) can leave a request pending for
  // minutes. Joining it would hold every later reload of that page hostage to it.
  it("does not let a stalled read capture the reloads that come after it", async () => {
    sharedRead("tok", "/opportunities", () => new Promise<string>(() => {}));
    vi.advanceTimersByTime(60_000);
    const fresh = vi.fn(async () => "rows");
    await expect(sharedRead("tok", "/opportunities", fresh)).resolves.toBe("rows");
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("keeps sessions apart", () => {
    const start = vi.fn(async () => "rows");
    void sharedRead("ada", "/lab/members", start);
    void sharedRead("bob", "/lab/members", start);
    expect(start).toHaveBeenCalledTimes(2);
  });
});

describe("warm reads", () => {
  it("hands a prefetched read to one loader, once", () => {
    keepWarmRead("tok", "/lab/members/self", { id: "ada" }, currentWarmEpoch());
    expect(takeWarmRead("tok", "/lab/members/self")).toEqual({ id: "ada" });
    expect(takeWarmRead("tok", "/lab/members/self")).toBeUndefined();
  });

  it("stops offering a prefetched read after a few seconds", () => {
    keepWarmRead("tok", "/lab/members/self", { id: "ada" }, currentWarmEpoch());
    vi.advanceTimersByTime(5_001);
    expect(takeWarmRead("tok", "/lab/members/self")).toBeUndefined();
  });

  it("never crosses sessions", () => {
    keepWarmRead("ada", "/lab/members/self", { id: "ada" }, currentWarmEpoch());
    expect(takeWarmRead("bob", "/lab/members/self")).toBeUndefined();
    expect(takeWarmRead(null, "/lab/members/self")).toBeUndefined();
  });

  it("is dropped by a write, including one that lands while the prefetch is in flight", () => {
    keepWarmRead("tok", "/papers", { papers: [] }, currentWarmEpoch());
    forgetReadsInFlight();
    expect(takeWarmRead("tok", "/papers")).toBeUndefined();

    const startedBeforeWrite = currentWarmEpoch();
    forgetReadsInFlight();
    keepWarmRead("tok", "/papers", { papers: [] }, startedBeforeWrite);
    expect(takeWarmRead("tok", "/papers")).toBeUndefined();
  });

  it("is dropped on sign-out or a change of session", () => {
    const epoch = currentWarmEpoch();
    keepWarmRead("tok", "/lab/members/self", { id: "ada" }, epoch);
    forgetSessionReads();
    expect(takeWarmRead("tok", "/lab/members/self")).toBeUndefined();
    keepWarmRead("tok", "/lab/members/self", { id: "ada" }, epoch);
    expect(takeWarmRead("tok", "/lab/members/self")).toBeUndefined();
  });
});
