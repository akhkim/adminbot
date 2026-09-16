import { expect, it } from "vitest";
import { TaskRuntime } from "./runtime.js";

it("allows at most three executions by default without reducing the checkpoint budget", async () => {
  const runtime = new TaskRuntime();
  let executions = 0;
  let checkpoints = 0;
  runtime.register("work", 1, async (_, ctx) => {
    executions++;
    for (let i = 0; i < 8; i++) {
      await ctx.step(`stage-${i}`, {}, () => ++checkpoints);
    }
    throw new Error("deterministic validation failure");
  });
  try {
    let submitted = runtime.submit({ owner: "a", kind: "work", input: {} });
    for (let i = 0; i < 3; i++) {
      expect((await submitted.promise)?.status).toBe("failed");
      if (i < 2) {
        submitted = runtime.retry(submitted.id, "a")!;
      }
    }
    expect(runtime.get(submitted.id)?.retryExhausted).toBe(true);
    expect(() => runtime.retry(submitted.id, "a")).toThrow("execution attempt limit");
    expect(executions).toBe(3);
    expect(checkpoints).toBe(8);
  } finally {
    await runtime.shutdown({ graceMs: 0 });
  }
});

it("keeps the checkpoint-attempt ceiling independent of the execution budget", async () => {
  const runtime = new TaskRuntime({ maxExecutions: 5, maxAttempts: 2 });
  let calls = 0;
  runtime.register("work", 1, async (_, ctx) => {
    for (let i = 0; i < 3; i++) {
      await ctx.step(`stage-${i}`, {}, () => ++calls);
    }
  });
  try {
    const submitted = runtime.submit({ owner: "a", kind: "work", input: {} });
    const finished = await submitted.promise;
    expect(finished?.error).toContain("checkpoint attempt limit");
    expect(finished?.executionAttempts).toBe(1);
    expect(calls).toBe(2);
    expect(() => runtime.retry(submitted.id, "a")).toThrow("checkpoint attempt limit");
  } finally {
    await runtime.shutdown({ graceMs: 0 });
  }
});
