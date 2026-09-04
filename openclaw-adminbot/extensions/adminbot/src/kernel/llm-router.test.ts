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

  it("lets public work proceed while local is full", async () => {
    const router = createLlmLoadRouter({ maxLocal: 1, maxPublic: 2 });
    const local = await router.acquire("local");
    const publicLease = await router.acquire("public");
    expect(router.status()).toMatchObject({
      local_active: 1,
      public_active: 1,
      queued: 0,
    });
    local.release();
    publicLease.release();
  });

  it("drains each pool independently without letting newcomers jump its FIFO", async () => {
    const router = createLlmLoadRouter({ maxLocal: 1, maxPublic: 1 });
    const local = await router.acquire("local");
    const publicLease = await router.acquire("public");
    let localGranted = false;
    const waitingLocal = router.acquire("local").then((lease) => {
      localGranted = true;
      lease.release();
    });
    const waitingPublic = router.acquire("public");

    publicLease.release();
    const nextPublic = await waitingPublic;
    expect(localGranted).toBe(false);
    let newcomerGranted = false;
    const newcomer = router.acquire("public").then((lease) => {
      newcomerGranted = true;
      return lease;
    });
    await Promise.resolve();
    expect(newcomerGranted).toBe(false);

    nextPublic.release();
    (await newcomer).release();
    local.release();
    await waitingLocal;
  });

  it("removes an aborted waiter without stranding work in the other pool", async () => {
    const router = createLlmLoadRouter({ maxLocal: 1, maxPublic: 1 });
    const local = await router.acquire("local");
    const publicLease = await router.acquire("public");
    const controller = new AbortController();
    const blockedLocal = router.acquire("local", controller.signal);
    const waitingPublic = router.acquire("public");

    publicLease.release();
    const nextPublic = await waitingPublic;
    controller.abort();

    await expect(blockedLocal).rejects.toThrow("cancelled");
    expect(router.status().queued).toBe(0);
    nextPublic.release();
    local.release();
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
