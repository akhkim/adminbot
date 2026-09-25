// Pangram's AI-text detector, for the ICLR integrity watch.
//
// Pangram 4, through the text task API, on the whole document's text. Both halves matter, and both
// were learned the hard way against the website's number:
//
//   - The model. The API still defaults to Pangram 3.3.2 (until 30 Sep 2026); the website runs
//     Pangram 4. On one ICLR submission the website said 82% AI and 3.3.2 said 0%. The file-upload
//     endpoint ignores a `model` field and always answers with 3.3.2, so it cannot be used.
//   - The text. The watch first sent only the main body, before the References heading, and
//     missed what the website flags in appendices. It now sends the whole document, extracted on
//     this host with the review-mode line numbers stripped. That text scored 82% under Pangram 4,
//     the same as the website.
//
// The API is asynchronous: POST /task hands back a task id, and GET /task/{id} is polled until its
// stage is STAGE_SUCCESS or STAGE_FAILED. Pangram 4 bills per started 100 words, so the caller
// scores each uploaded version once and never re-sends an unchanged paper.
//
// The text sent is restricted manuscript content; the PDF itself never leaves the host.
// `public_dashboard_link` is always false, so the result never becomes a shareable page.

import { setTimeout as delay } from "node:timers/promises";
import type { AiTextScore, AiTextScorer } from "../contracts/paper-integrity-checks.js";

const BASE_URL = "https://text.external-api.pangram.com";
/** The model the website scores with. Pinned: the API's default is the retiring 3.3.2. */
export const PANGRAM_MODEL = "pangram-4";
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;
// A 40-page paper finishes in a minute or two; past this the task is abandoned and the version
// retried by a later sweep.
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
    const created = await call("/task", signal, {
      text,
      model: PANGRAM_MODEL,
      public_dashboard_link: false,
    });
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
  // What actually scored it. Kept so a score from a model the website no longer uses is visibly
  // that, and so the watch can tell which stored scores are due a re-score.
  const version =
    typeof task.version === "string" && /^[0-9A-Za-z.-]{1,20}$/u.test(task.version)
      ? task.version
      : undefined;
  return {
    fraction_ai: ai,
    fraction_ai_assisted: fraction("fraction_ai_assisted") ?? 0,
    fraction_human: fraction("fraction_human") ?? Math.max(0, 1 - ai),
    ...(prediction ? { prediction } : {}),
    ...(version ? { model_version: version } : {}),
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
  if (status === 413) {
    return "The text is larger than Pangram accepts.";
  }
  return `Pangram returned HTTP ${status}.`;
}
