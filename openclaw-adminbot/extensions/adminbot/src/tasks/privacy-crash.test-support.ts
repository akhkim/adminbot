import { appendFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { AdminBotPrivacyTaskRequest } from "../contracts/actions.js";
import { inferenceTestConfig } from "../inference/config.test-support.js";
import { createInferenceGate } from "../inference/gate.js";
import { createAdminBotPrivacyBroker, type PrivacyBrokerFetch } from "../privacy/broker.js";
import { TaskRuntime } from "./runtime.js";

export const privacyCrashInput: AdminBotPrivacyTaskRequest = {
  task: "Write a synthetic note about Test Member",
  sensitive_terms: ["Test Member"],
};

export function privacyCrashHarness(file: string, logFile: string, holdFinal?: () => void) {
  const db = new DatabaseSync(file);
  const fetchImpl: PrivacyBrokerFetch = async (_url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as { response_format?: unknown };
    const stage = body.response_format ? "classify" : "final";
    appendFileSync(logFile, `${JSON.stringify({ stage, pid: process.pid })}\n`);
    if (stage === "final" && holdFinal) {
      holdFinal();
      return new Promise(() => {});
    }
    const content =
      stage === "classify"
        ? JSON.stringify({
            classification: "private",
            sanitized_task: privacyCrashInput.task,
            replacements: [],
          })
        : "Synthetic note completed after restart";
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
    };
  };
  const gate = createInferenceGate({
    db,
    config: inferenceTestConfig({ persistAcrossRestarts: false, shutdownGraceMs: 0 }),
    fetchImpl,
    env: {},
  });
  const broker = createAdminBotPrivacyBroker(undefined, { gate, fetchImpl, env: {} });
  const runtime = new TaskRuntime({ db, persist: true });
  runtime.register<AdminBotPrivacyTaskRequest>("privacy", 1, (input, ctx) =>
    broker.handle(input, ctx.signal, { owner: ctx.owner }),
  );
  return { db, gate, runtime };
}

if (process.argv[2] === "--privacy-crash-worker") {
  const { runtime } = privacyCrashHarness(process.argv[3], process.argv[4], () => {
    process.send?.({ event: "final-running" });
  });
  runtime.submit({
    kind: "privacy",
    owner: "synthetic-owner",
    key: "original-privacy-request",
    input: privacyCrashInput,
  });
  setInterval(() => {}, 1000);
}
