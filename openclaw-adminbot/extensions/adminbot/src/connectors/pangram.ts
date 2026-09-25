// Pangram's AI-text detector, for the ICLR integrity watch.
//
// Scores the whole PDF through Pangram's file endpoint, which is what its website does with an
// upload. The integrity watch used to send only the main text it extracted itself (before the
// bibliography), and the two disagreed badly: on one ICLR submission the website said 22% and the
// watch said 0%, because every AI-flagged window was in the appendix the watch never sent. Scoring
// the file makes the automated number the one an author sees when they check their own paper.
//
// The file endpoint answers synchronously -- no task to poll. Pangram bills per 1,000 words of what
// it extracts, so the caller scores each uploaded version once and never re-sends an unchanged
// paper.
//
// What leaves the host is the submission PDF itself, a restricted manuscript. It is uploaded under
// a fixed filename rather than the paper's title, and `public_dashboard_link` is always false, so
// the result never becomes a shareable page on Pangram's side.

import type { AiTextScore, AiTextScorer } from "../contracts/paper-integrity-checks.js";

const FILE_URL = "https://file-external.api.pangram.com/";
// A 40-page paper takes Pangram a minute or two; past this the upload is abandoned and the version
// retried by a later sweep.
const REQUEST_TIMEOUT_MS = 10 * 60_000;

/** Failures whose messages are fixed strings, safe to store on the check and show an admin. */
export class PangramError extends Error {}

export type PangramScorerOptions = {
  apiKey: string;
  fetchImpl?: typeof globalThis.fetch;
  fileUrl?: string;
};

export function createPangramScorer(options: PangramScorerOptions): AiTextScorer {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const fileUrl = options.fileUrl ?? FILE_URL;

  return async (pdf, signal) => {
    const form = new FormData();
    form.append(
      "files",
      new Blob([new Uint8Array(pdf)], { type: "application/pdf" }),
      "submission.pdf",
    );
    form.append("public_dashboard_link", "false");
    const response = await fetchImpl(fileUrl, {
      method: "POST",
      headers: { "x-api-key": options.apiKey },
      body: form,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PangramError(describeStatus(response.status));
    }
    const parsed = (await response.json().catch(() => undefined)) as unknown;
    // One result per uploaded file; the endpoint has answered both as a bare list and wrapped.
    const results = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? ((parsed as { results?: unknown }).results ?? [parsed])
        : [];
    const result = Array.isArray(results) ? results[0] : undefined;
    if (!result || typeof result !== "object") {
      throw new PangramError("Pangram returned an unreadable response.");
    }
    return toScore(result as Record<string, unknown>);
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
  // Counted from Pangram's own extraction, which is what it billed and scored; the text itself is
  // not kept.
  const words =
    typeof task.text === "string" ? task.text.split(/\s+/u).filter(Boolean).length : undefined;
  return {
    fraction_ai: ai,
    fraction_ai_assisted: fraction("fraction_ai_assisted") ?? 0,
    fraction_human: fraction("fraction_human") ?? Math.max(0, 1 - ai),
    ...(prediction ? { prediction } : {}),
    ...(words ? { words_scored: words } : {}),
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
    return "The PDF is larger than Pangram accepts.";
  }
  return `Pangram returned HTTP ${status}.`;
}
