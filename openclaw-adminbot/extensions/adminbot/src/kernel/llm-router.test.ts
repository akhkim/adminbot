import { describe, expect, it } from "vitest";
import { createLlmLoadRouter, parseLlmNodes } from "./llm-router.js";

describe("createLlmLoadRouter", () => {
  it("caps local slots at eight and queues the ninth", async () => {
    const router = createLlmLoadRouter({ maxLocal: 8, maxPublic: 100 });
    const leases = await Promise.all(Array.from({ length: 8 }, () => router.acquire("local")));
    expect(router.status().local_active).toBe(8);
    let granted = false;
    const waiting = router.acquire("local").then((lease) => {
      granted = true;
      lease.release();
    });
    await Promise.resolve();
    expect(granted).toBe(false);
    expect(router.status().queued).toBe(1);
    leases[0]!.release();
    await waiting;
    expect(granted).toBe(true);
    expect(router.status().queued).toBe(0);
    for (const lease of leases.slice(1)) {
      lease.release();
    }
  });

  it("queues public work while local is full and wakes it on local release", async () => {
    const router = createLlmLoadRouter({ maxLocal: 1, maxPublic: 2 });
    const local = await router.acquire("local");
    const waiting = router.acquire("public");
    expect(router.status()).toMatchObject({ local_active: 1, public_active: 0, queued: 1 });
    local.release();
    (await waiting).release();
    expect(router.status().queued).toBe(0);
  });

  it("keeps public FIFO order and removes cancelled waiters", async () => {
    const router = createLlmLoadRouter({ maxPublic: 1 });
    const first = await router.acquire("public");
    const controller = new AbortController();
    const cancelled = router.acquire("public", controller.signal);
    const rejection = expect(cancelled).rejects.toThrow("cancelled");
    const second = router.acquire("public");
    controller.abort();
    await rejection;
    expect(router.status().queued).toBe(1);
    first.release();
    (await second).release();
    expect(router.status().public_active).toBe(0);
  });

  it("cannot configure above the shared hard caps", () => {
    expect(createLlmLoadRouter({ maxPublic: 500, maxLocal: 30 }).status()).toMatchObject({
      max_public: 100,
      max_local: 8,
    });
  });

  it("releases a lease only once", async () => {
    const router = createLlmLoadRouter({ maxLocal: 1, maxPublic: 1 });
    const first = await router.acquire("local");
    const secondPromise = router.acquire("local");
    let thirdGranted = false;
    const thirdPromise = router.acquire("local").then((lease) => {
      thirdGranted = true;
      return lease;
    });

    first.release();
    const second = await secondPromise;
    first.release();
    await Promise.resolve();
    expect(thirdGranted).toBe(false);
    expect(router.status()).toMatchObject({ local_active: 1, queued: 1 });

    second.release();
    (await thirdPromise).release();
  });
});

describe("parseLlmNodes", () => {
  it("parses aurora maple and conserto3 rows", () => {
    expect(
      parseLlmNodes(
        "aurora|http://127.0.0.1:8000/v1|RTX6000,maple|http://maple:8000/v1|RTX6000,conserto3|http://conserto3:8000/v1|H100",
      ),
    ).toEqual([
      { id: "aurora", baseUrl: "http://127.0.0.1:8000/v1", gpu: "RTX6000" },
      { id: "maple", baseUrl: "http://maple:8000/v1", gpu: "RTX6000" },
      { id: "conserto3", baseUrl: "http://conserto3:8000/v1", gpu: "H100" },
    ]);
  });
});
