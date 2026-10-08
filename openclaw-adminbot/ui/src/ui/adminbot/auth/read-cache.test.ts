import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetSessionReads, sharedRead } from "./read-cache.ts";

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
