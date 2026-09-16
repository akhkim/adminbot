import { describe, expect, it, vi } from "vitest";
import { inferenceTestConfig } from "../inference/config.test-support.js";
import { createInferenceGate, runGated, type InferenceFetch } from "../inference/gate.js";
import { createAdminBotPrivacyBroker } from "../privacy/broker.js";
import { TaskRuntime } from "./runtime.js";

function setup(failFinal = false, malformedFinal = false) {
  let classified = 0,
    generated = 0;
  const fetchImpl: InferenceFetch = async (_url, init) => {
    const body = JSON.parse(init.body ?? "{}");
    const classification = Boolean(body.response_format);
    if (classification) {
      classified++;
    } else {
      generated++;
      if (failFinal && generated === 1) {
        throw new Error("connection interrupted");
      }
    }
    const content = classification
      ? JSON.stringify({
          classification: "private",
          sanitized_task: "Write about Ada",
          replacements: [],
        })
      : malformedFinal
        ? ""
        : "Synthetic answer";
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
    };
  };
  const gate = createInferenceGate({ config: inferenceTestConfig(), fetchImpl, env: {} });
  const broker = createAdminBotPrivacyBroker(undefined, { gate, env: {} });
  const runtime = new TaskRuntime({ db: gate.database, maxRunning: 1 });
  runtime.register("privacy", 1, (input, ctx) =>
    broker.handle(input as Parameters<typeof broker.handle>[0], ctx.signal, { owner: ctx.owner }),
  );
  return { runtime, gate, counts: () => ({ classified, generated }) };
}
const input = { task: "Write about Ada", privacy: "private", sensitive_terms: ["Ada"] };

describe("workflow checkpoint integration", () => {
  it("shed then wait completes the original privacy task, not only classification", async () => {
    const { runtime, gate, counts } = setup();
    let release!: () => void;
    runtime.register(
      "hold",
      1,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = runtime.submit({ owner: "a", kind: "hold", input: null });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const submitted = runtime.submit({ owner: "a", kind: "privacy", input, key: "privacy-key" });
    expect(submitted.status).toBe("shed");
    const waited = runtime.wait(submitted.id, "a")!;
    release();
    await first.promise;
    const result = await waited.promise;
    expect(result?.status).toBe("completed");
    expect(result?.result).toEqual({ route: "local", output: "Synthetic answer" });
    expect(counts()).toEqual({ classified: 1, generated: 1 });
    expect(
      runtime.submit({ owner: "a", kind: "privacy", input, key: "privacy-key" }).result,
    ).toEqual(result?.result);
    await runtime.shutdown();
    await gate.shutdown();
    gate.database.close();
  });
  it("an explicit retry reuses classification and gives the uncertain model call a new attempt", async () => {
    const { runtime, gate, counts } = setup(true);
    const submitted = runtime.submit({ owner: "a", kind: "privacy", input });
    expect((await submitted.promise)?.status).toBe("needs_retry");
    const retried = runtime.retry(submitted.id, "a")!;
    expect((await retried.promise)?.result).toEqual({ route: "local", output: "Synthetic answer" });
    expect(counts()).toEqual({ classified: 1, generated: 2 });
    await runtime.shutdown();
    await gate.shutdown();
    gate.database.close();
  });
  it("does not call malformed final model output a completed application task", async () => {
    const { runtime, gate } = setup(false, true);
    const submitted = runtime.submit({ owner: "a", kind: "privacy", input });
    const result = await submitted.promise;
    expect(result?.status).toBe("failed");
    expect(result?.result).toBeUndefined();
    await runtime.shutdown();
    await gate.shutdown();
    gate.database.close();
  });
});

it("keeps task-level backpressure out of needs-retry even with no model waiting slots", async () => {
  let release!: () => void;
  let calls = 0;
  const gate = createInferenceGate({
    env: {},
    config: inferenceTestConfig({ capacity: 1, queue: { maxDepth: 0 } }),
    fetchImpl: async () => {
      if (++calls === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { ok: true, status: 200, statusText: "OK", text: async () => "answer" };
    },
  });
  const request = {
    route: "chat/completions" as const,
    baseUrl: "http://127.0.0.1:8000/v1",
    body: { model: "m" },
    purpose: "test",
  };
  const occupant = gate.run({ owner: "other", caller: "occupant", request });
  const runtime = new TaskRuntime({ db: gate.database });
  runtime.register("call", 1, () => runGated(gate, { owner: "a", caller: "task", request }));
  const task = runtime.submit({ owner: "a", kind: "call", input: {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(runtime.get(task.id)?.status).toBe("running");
  release();
  await occupant;
  expect((await task.promise)?.status).toBe("completed");
  expect(calls).toBe(2);
  expect(gate.stats().rows.completed).toBe(2);
  await runtime.shutdown();
  await gate.shutdown();
  gate.database.close();
});

it("bounds a hung remote stage without claiming application completion", async () => {
  vi.useFakeTimers();
  const fetchImpl: InferenceFetch = async (url) => {
    if (String(url).startsWith("https:")) {
      return new Promise(() => {});
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  classification: "generic",
                  sanitized_task: "hello",
                  replacements: [],
                }),
              },
            },
          ],
        }),
    };
  };
  const gate = createInferenceGate({ config: inferenceTestConfig(), fetchImpl, env: {} });
  const runtime = new TaskRuntime({ db: gate.database });
  const broker = createAdminBotPrivacyBroker(undefined, {
    gate,
    fetchImpl,
    env: { NVIDIA_API_KEY: "synthetic" },
  });
  runtime.register("privacy", 1, () => broker.handle({ task: "hello" }));
  try {
    const submitted = runtime.submit({ owner: "a", kind: "privacy", input: {} });
    await vi.advanceTimersByTimeAsync(120_001);
    expect((await submitted.promise)?.status).toBe("needs_retry");
  } finally {
    await runtime.shutdown({ graceMs: 0 });
    await gate.shutdown();
    gate.database.close();
    vi.useRealTimers();
  }
});
