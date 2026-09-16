import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { privacyCrashHarness, privacyCrashInput } from "./privacy-crash.test-support.js";

it("resumes the real privacy broker after SIGKILL using its saved classification and a new final attempt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "privacy-task-crash-"));
  const file = join(directory, "tasks.sqlite");
  const logFile = join(directory, "model-calls.jsonl");
  const child = fork(
    fileURLToPath(new URL("./privacy-crash.test-support.ts", import.meta.url)),
    ["--privacy-crash-worker", file, logFile],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr?.on("data", (data) => {
    stderr += String(data);
  });
  let recovered: ReturnType<typeof privacyCrashHarness> | undefined;
  const calls = () =>
    readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { stage: string; pid: number });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Privacy worker timed out: ${stderr}`));
      }, 10000);
      child.once("message", (message) => {
        clearTimeout(timer);
        if ((message as { event?: string }).event !== "final-running") {
          reject(new Error("Unexpected worker checkpoint"));
          return;
        }
        resolve();
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Privacy worker exited ${code}: ${stderr}`));
      });
    });
    expect(calls().map((call) => call.stage)).toEqual(["classify", "final"]);
    await new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
      child.kill("SIGKILL");
    });

    recovered = privacyCrashHarness(file, logFile);
    const { runtime, gate } = recovered;
    runtime.start();
    const task = runtime.list("synthetic-owner")[0];
    expect(task.status).toBe("needs_retry");
    expect(task.result).toBeUndefined();
    expect(gate.stats().rows.completed).toBe(0);
    const checkpoints = runtime.steps(task.id);
    const classification = checkpoints.find((step) =>
      step.key.endsWith("model:privacy_broker.classify"),
    )!;
    const interrupted = checkpoints.find((step) =>
      step.key.endsWith("model:privacy_broker.local"),
    )!;
    expect(classification.status).toBe("completed");
    expect(classification.result).toMatchObject({ ok: true, status: 200 });
    expect(interrupted.status).toBe("uncertain");
    expect(calls()).toHaveLength(2);

    const retry = runtime.retry(task.id, "synthetic-owner")!;
    const completed = await retry.promise;
    expect(completed?.status).toBe("completed");
    expect(completed?.result).toEqual({
      route: "local",
      output: "Synthetic note completed after restart",
    });
    const final = runtime.steps(task.id).find((step) => step.key === interrupted.key)!;
    expect(final.status).toBe("completed");
    expect(final.attempt).not.toBe(interrupted.attempt);
    expect(runtime.steps(task.id).find((step) => step.key === classification.key)?.attempt).toBe(
      classification.attempt,
    );
    expect(calls().map((call) => call.stage)).toEqual(["classify", "final", "final"]);
    expect(calls()[0].pid).toBe(child.pid);
    expect(calls()[2].pid).toBe(process.pid);
    expect(gate.stats().rows.completed).toBe(1);
    const reattached = runtime.submit({
      kind: "privacy",
      owner: "synthetic-owner",
      key: "original-privacy-request",
      input: privacyCrashInput,
    });
    expect(reattached.id).toBe(task.id);
    expect(reattached.result).toEqual(completed?.result);
    expect(calls()).toHaveLength(3);
  } finally {
    child.kill("SIGKILL");
    if (recovered) {
      await recovered.runtime.shutdown({ graceMs: 0 });
      await recovered.gate.shutdown();
      recovered.db.close();
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
