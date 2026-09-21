import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalModelCapacity } from "./local-model-capacity.js";

afterEach(() => vi.useRealTimers());
function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("local model capacity", () => {
  it("cancels extraction immediately, then retries after every foreground request finishes and two idle seconds", async () => {
    vi.useFakeTimers();
    const capacity = new LocalModelCapacity();
    let firstSignal: AbortSignal | undefined;
    const request = vi.fn((signal?: AbortSignal) => {
      if (request.mock.calls.length > 1) {
        return Promise.resolve("schedule");
      }
      firstSignal = signal;
      return new Promise<string>((_, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
    });
    const extraction = capacity.run(true, undefined, request);
    const first = deferred();
    const second = deferred();
    const chat = capacity.run(false, undefined, () => first.promise);
    const answer = capacity.run(false, undefined, () => second.promise);
    expect(firstSignal?.aborted).toBe(true);
    first.resolve("chat");
    await chat;
    await vi.advanceTimersByTimeAsync(3000);
    expect(request).toHaveBeenCalledTimes(1);
    second.resolve("answer");
    await answer;
    await vi.advanceTimersByTimeAsync(1999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(101);
    expect(await extraction).toBe("schedule");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("serializes background work without blocking foreground work", async () => {
    vi.useFakeTimers();
    const capacity = new LocalModelCapacity();
    const first = deferred();
    const initial = capacity.run(true, undefined, () => first.promise);
    const request = vi.fn(async () => "second");
    const next = capacity.run(true, undefined, request);
    expect(request).not.toHaveBeenCalled();
    first.resolve("first");
    await initial;
    await vi.advanceTimersByTimeAsync(100);
    expect(await next).toBe("second");
  });

  it("honors cancellation while waiting and does not send a deferred request", async () => {
    const capacity = new LocalModelCapacity();
    const foreground = deferred();
    const chat = capacity.run(false, undefined, () => foreground.promise);
    const abort = new AbortController();
    const request = vi.fn(async () => "unused");
    const extraction = capacity.run(true, abort.signal, request);
    abort.abort();
    await expect(extraction).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    foreground.resolve("done");
    await chat;
  });

  it("does not restart a running extraction after caller cancellation", async () => {
    const capacity = new LocalModelCapacity();
    const abort = new AbortController();
    const request = vi.fn(
      (signal?: AbortSignal) =>
        new Promise<string>((_, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        }),
    );
    const extraction = capacity.run(true, abort.signal, request);
    abort.abort();
    await expect(extraction).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    expect(await capacity.run(true, undefined, async () => "next")).toBe("next");
  });

  it("releases foreground capacity after errors", async () => {
    vi.useFakeTimers();
    const capacity = new LocalModelCapacity();
    await expect(
      capacity.run(false, undefined, async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    const extraction = capacity.run(true, undefined, async () => "next");
    await vi.advanceTimersByTimeAsync(2100);
    expect(await extraction).toBe("next");
  });

  it("does not retry model failures or retain a failed background slot", async () => {
    const capacity = new LocalModelCapacity();
    const request = vi.fn(async () => {
      throw new Error("model failed");
    });
    await expect(capacity.run(true, undefined, request)).rejects.toThrow("model failed");
    expect(request).toHaveBeenCalledTimes(1);
    expect(await capacity.run(true, undefined, async () => "next")).toBe("next");
  });
});
