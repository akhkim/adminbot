// Pangram's AI-text detector, for the ICLR integrity watch.
//
// The inference API is asynchronous: POST /task hands back a task id, and GET /task/{id} is polled
// until its stage is STAGE_SUCCESS or STAGE_FAILED. Pangram bills per started 1,000 words, so the
// caller scores each uploaded version once and never re-sends an unchanged paper.
//
// The text sent is restricted manuscript content. `public_dashboard_link` is always false, so the
// result never becomes a shareable page on Pangram's side.

import { setTimeout as delay } from "node:timers/promises";
import type { AiTextScore, AiTextScorer } from "../contracts/paper-integrity-checks.js";

const BASE_URL = "https://text.external-api.pangram.com";
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;
// A paper-length text normally finishes in well under a minute; past this the task is abandoned
// and the version retried by a later sweep.
const MAX_WAIT_MS = 10 * 60_000;

/** Failures whose messages are fixed strings, safe to store on the check and show an admin. */
export class PangramError extends Error {}

export type PangramScorerOptions = {
  apiKey: string;
  fetchImpl?: typeof globalThis.fetch;
  baseUrl?: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
};

export function createPangramScorer(options: PangramScorerOptions): AiTextScorer {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? BASE_URL;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;

  const call = async (path: string, signal: AbortSignal, body?: unknown) => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-api-key": options.apiKey,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PangramError(describeStatus(response.status));
    }
    const parsed = (await response.json().catch(() => undefined)) as unknown;
    if (!parsed || typeof parsed !== "object") {
      throw new PangramError("Pangram returned an unreadable response.");
    }
    return parsed as Record<string, unknown>;
  };

  return async (text, signal) => {
    const created = await call("/task", signal, { text, public_dashboard_link: false });
    const taskId = typeof created.task_id === "string" ? created.task_id : "";
    if (!/^[A-Za-z0-9-]{1,128}$/u.test(taskId)) {
      throw new PangramError("Pangram did not return a task id.");
    }
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      await delay(pollIntervalMs, undefined, { signal });
      const task = await call(`/task/${encodeURIComponent(taskId)}`, signal);
      if (task.stage === "STAGE_SUCCESS") {
        return toScore(task);
      }
      if (task.stage === "STAGE_FAILED") {
        throw new PangramError("Pangram could not classify the text.");
      }
      if (Date.now() > deadline) {
        throw new PangramError("Pangram did not finish in time.");
      }
    }
  };
}

function toScore(task: Record<string, unknown>): AiTextScore {
  const fraction = (key: string) => {
    const value = task[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
      ? value
      : undefined;
  };
  const ai = fraction("fraction_ai");
  if (ai === undefined) {
    throw new PangramError("Pangram's result had no AI fraction.");
  }
  const prediction =
    typeof task.prediction_short === "string" ? task.prediction_short.slice(0, 40) : undefined;
  return {
    fraction_ai: ai,
    fraction_ai_assisted: fraction("fraction_ai_assisted") ?? 0,
    fraction_human: fraction("fraction_human") ?? Math.max(0, 1 - ai),
    ...(prediction ? { prediction } : {}),
  };
}

function describeStatus(status: number): string {
  if (status === 401 || status === 403) {
    return "Pangram rejected the API key (check PANGRAM_API_KEY).";
  }
  if (status === 402) {
    return "The Pangram account is out of credits.";
  }
  if (status === 429) {
    return "Pangram is rate limiting requests.";
  }
  return `Pangram returned HTTP ${status}.`;
}
