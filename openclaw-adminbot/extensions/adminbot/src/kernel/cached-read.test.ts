import { describe, expect, it } from "vitest";
import { createCachedRead, mapWithLimit } from "./cached-read.js";

/** A load whose every call is answered by hand, so a test decides when and with what. */
function manualLoad<T>() {
  const calls: { resolve: (value: T) => void; reject: (error: Error) => void }[] = [];
  const load = () =>
    new Promise<T>((resolve, reject) => {
      calls.push({ resolve, reject });
    });
  return { load, calls };
}

/** Lets a refresh that was just answered finish putting its value away. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createCachedRead", () => {
  it("answers from the kept value while it is fresh", async () => {
    let clock = 0;
    let loads = 0;
    const cached = createCachedRead(async () => ++loads, { freshMs: 100, now: () => clock });
    expect(await cached.read()).toBe(1);
    clock = 99;
    expect(await cached.read()).toBe(1);
    clock = 100;
    expect(await cached.read()).toBe(2);
  });

  it("shares one load between callers that arrive while it is under way", async () => {
    const { load, calls } = manualLoad<string>();
    const cached = createCachedRead(load, { freshMs: 100, now: () => 0 });
    const first = cached.read();
    const second = cached.read();
    expect(calls).toHaveLength(1);
    calls[0]!.resolve("names");
    expect(await Promise.all([first, second])).toEqual(["names", "names"]);
  });

  it("hands back a stale value at once and refreshes behind it", async () => {
    let clock = 0;
    const { load, calls } = manualLoad<string>();
    const cached = createCachedRead(load, { freshMs: 100, staleMs: 1000, now: () => clock });
    const first = cached.read();
    calls[0]!.resolve("old");
    await first;

    clock = 500;
    expect(await cached.read()).toBe("old");
    // A second stale read joins the refresh already running instead of starting another.
    expect(await cached.read()).toBe("old");
    expect(calls).toHaveLength(2);
    calls[1]!.resolve("new");
    await settle();
    expect(await cached.read()).toBe("new");
    expect(calls).toHaveLength(2);
  });

  it("waits for a new value once the old one is past the stale window", async () => {
    let clock = 0;
    let loads = 0;
    const cached = createCachedRead(async () => ++loads, {
      freshMs: 100,
      staleMs: 1000,
      now: () => clock,
    });
    await cached.read();
    clock = 1100;
    expect(await cached.read()).toBe(2);
  });

  it("does not keep a failure, and keeps serving the old value when a refresh fails", async () => {
    let clock = 0;
    const { load, calls } = manualLoad<string>();
    const cached = createCachedRead(load, { freshMs: 100, staleMs: 1000, now: () => clock });

    const failed = cached.read();
    calls[0]!.reject(new Error("slack said no"));
    await expect(failed).rejects.toThrow("slack said no");
    const retried = cached.read();
    expect(calls).toHaveLength(2);
    calls[1]!.resolve("old");
    expect(await retried).toBe("old");

    clock = 500;
    expect(await cached.read()).toBe("old");
    calls[2]!.reject(new Error("slack said no"));
    await settle();
    expect(await cached.read()).toBe("old");
    expect(calls).toHaveLength(4);
  });

  it("skips values `keep` turns down", async () => {
    let loads = 0;
    const cached = createCachedRead(async () => (++loads === 1 ? [] : ["form"]), {
      freshMs: 100,
      keep: (forms) => forms.length > 0,
      now: () => 0,
    });
    expect(await cached.read()).toEqual([]);
    expect(await cached.read()).toEqual(["form"]);
    expect(await cached.read()).toEqual(["form"]);
    expect(loads).toBe(2);
  });

  it("forgets the value on invalidate, including one a read in flight is about to bring", async () => {
    const { load, calls } = manualLoad<string>();
    const cached = createCachedRead(load, { freshMs: 100, now: () => 0 });
    const before = cached.read();
    cached.invalidate();
    calls[0]!.resolve("before the write");
    expect(await before).toBe("before the write");

    const after = cached.read();
    expect(calls).toHaveLength(2);
    calls[1]!.resolve("after the write");
    expect(await after).toBe("after the write");
    expect(await cached.read()).toBe("after the write");
    expect(calls).toHaveLength(2);
  });
});

describe("mapWithLimit", () => {
  it("keeps the order of the input and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const results = await mapWithLimit([30, 5, 20, 1, 10], 2, async (ms, index) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running -= 1;
      return `${index}:${ms}`;
    });
    expect(results).toEqual(["0:30", "1:5", "2:20", "3:1", "4:10"]);
    expect(peak).toBe(2);
  });

  it("answers an empty list without calling the task", async () => {
    expect(await mapWithLimit([], 3, async () => 1)).toEqual([]);
  });
});
