import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const DCS_FORM_TIMEOUT_MS = 90_000;
const DCS_FORM_MAX_OUTPUT_BYTES = 1024 * 1024;

// The roster keeps one free-text `name`; the DCS form (like most external forms) wants separate
// First/Last Name answers, so this splits on the last space -- everything before it becomes the
// first name (covers middle names/initials), the final token becomes the last name. A one-word
// name (no space) has nothing to split, so it is used for both rather than leaving a required
// field blank.
export function splitDisplayName(name: string): { firstName: string; lastName: string } {
  const trimmed = name.trim();
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace === -1) {
    return { firstName: trimmed, lastName: trimmed };
  }
  return {
    firstName: trimmed.slice(0, lastSpace).trim(),
    lastName: trimmed.slice(lastSpace + 1).trim(),
  };
}

export type DcsFormParams = {
  firstName: string;
  lastName: string;
  email: string;
};

export type DcsFormRunner = (params: DcsFormParams) => Promise<void>;

export type DcsFormEscalationResult =
  | { escalated: true }
  | { escalated: false; errorMessage: string };

export type DcsFormFailover = {
  record: (input: {
    serviceType: string;
    payload: Record<string, unknown>;
    errorMessage: string;
    status?: "recorded" | "aws_retry_failed" | "escalated_to_human" | "resolved";
  }) => { id: string };
  update: (
    id: string,
    patch: {
      status?: "recorded" | "aws_retry_failed" | "escalated_to_human" | "resolved";
      error_message?: string;
      attempt_count?: number;
    },
  ) => unknown;
  awsFallback?: (params: DcsFormParams) => Promise<void>;
  escalateToHumans?: (input: {
    params: DcsFormParams;
    error: string;
    recordId: string;
  }) => Promise<DcsFormEscalationResult>;
};

/**
 * Submits the DCS Slack-access request form (scripts/adminbot-dcs-form-submit.ts) on a newly
 * approved member's behalf. Spawns the script as its own process rather than importing Playwright
 * here: a hung/crashed browser then can never take the AdminBot API down with it, matching why
 * the OpenReview and reimbursement connectors shell out to their own scripts.
 *
 * `scriptPath` is injected from the repo-root composition layer (host/main.ts), the same reason
 * `openReviewScriptPath` and the reimbursement workflow's `formScriptPath` are: extensions/adminbot
 * does not know where the repo root is, and must not compute it via a core import. Returns
 * `undefined` (not a no-op runner) when no script path is configured, so
 * approveRegistration's caller can tell "not wired up" apart from "wired up and it happened to
 * succeed" the same way the OpenReview route reports 503 when unconfigured instead of quietly
 * doing nothing.
 */
export function createDcsFormRunner(options: {
  scriptPath?: string;
  env?: NodeJS.ProcessEnv;
  // Same seam as the gog/gws runners' `run`: lets tests assert on the call without launching a
  // real browser against the real form.
  run?: (params: { firstName: string; lastName: string; email: string }) => Promise<void>;
}): DcsFormRunner | undefined {
  if (options.run) {
    return options.run;
  }
  if (!options.scriptPath) {
    return undefined;
  }
  const scriptPath = options.scriptPath;
  return async ({ firstName, lastName, email }) => {
    const payload = JSON.stringify({ firstName, lastName, email });
    let stdout: string;
    try {
      const result = await execFile(process.execPath, ["--import", "tsx", scriptPath, payload], {
        env: options.env ?? process.env,
        maxBuffer: DCS_FORM_MAX_OUTPUT_BYTES,
        timeout: DCS_FORM_TIMEOUT_MS,
        windowsHide: true,
      });
      stdout = result.stdout;
    } catch (error) {
      throw new Error(formatDcsFormError(error), { cause: error });
    }
    const parsed = parseDcsFormResult(stdout);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
  };
}

/**
 * Local Playwright first, then an exact-payload AWS retry, then a human Slack/nudge.
 * The original request is written to the ledger before either fallback so a crash cannot drop it.
 */
export function withDcsFormFailover(
  submit: DcsFormRunner,
  failover: DcsFormFailover,
): DcsFormRunner {
  return async (params) => {
    try {
      await submit(params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let recordedError = message;
      const recorded = failover.record({
        serviceType: "dcs_form",
        payload: { ...params },
        errorMessage: message,
        status: "recorded",
      });
      if (failover.awsFallback) {
        try {
          await failover.awsFallback(params);
          failover.update(recorded.id, { status: "resolved", attempt_count: 2 });
          return;
        } catch (awsError) {
          const awsMessage = awsError instanceof Error ? awsError.message : String(awsError);
          recordedError = `${message}; aws: ${awsMessage}`;
          failover.update(recorded.id, {
            status: "aws_retry_failed",
            error_message: recordedError,
            attempt_count: 2,
          });
        }
      }
      if (failover.escalateToHumans) {
        try {
          const escalation = await failover.escalateToHumans({
            params,
            error: message,
            recordId: recorded.id,
          });
          if (escalation.escalated) {
            failover.update(recorded.id, { status: "escalated_to_human" });
          } else {
            failover.update(recorded.id, {
              error_message: `${recordedError}; escalation: ${escalation.errorMessage}`,
            });
          }
        } catch (escalationError) {
          const escalationMessage =
            escalationError instanceof Error ? escalationError.message : String(escalationError);
          failover.update(recorded.id, {
            error_message: `${recordedError}; escalation: ${escalationMessage}`,
          });
        }
      }
      throw error;
    }
  };
}

export async function submitDcsFormViaAwsFallback(
  params: DcsFormParams,
  options: { url: string; token?: string; fetchImpl?: typeof fetch },
): Promise<void> {
  const url = new URL(options.url);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("DCS AWS fallback URL must use https");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`DCS AWS fallback returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as { ok?: boolean; error?: string };
  if (body.ok !== true) {
    throw new Error(body.error?.trim() || "DCS AWS fallback did not confirm submission");
  }
}

function parseDcsFormResult(stdout: string): { ok: true } | { ok: false; error: string } {
  // The script writes exactly one JSON line; take the last non-empty one in case Playwright (or
  // its bundled browser) logged anything else to stdout first.
  const line = stdout.trim().split("\n").at(-1) ?? "";
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === "object" && "ok" in parsed) {
      return parsed as { ok: true } | { ok: false; error: string };
    }
  } catch {
    // fall through
  }
  return { ok: false, error: `dcs form script returned no JSON result: ${line.slice(0, 300)}` };
}

function formatDcsFormError(error: unknown): string {
  const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
  if (failure?.code === "ENOENT") {
    return "dcs form submit script was not found";
  }
  // A non-zero exit from the script itself still carries its JSON result on stdout; surface that
  // instead of the generic "command failed" execFile throws.
  if (typeof failure?.stdout === "string" && failure.stdout.trim()) {
    const parsed = parseDcsFormResult(failure.stdout);
    if (!parsed.ok) {
      return parsed.error;
    }
  }
  const detail =
    typeof failure?.stderr === "string"
      ? failure.stderr
          .replaceAll(/\p{Cc}+/gu, " ")
          .trim()
          .slice(0, 500)
      : undefined;
  return detail ? `dcs form submission failed: ${detail}` : "dcs form submission failed";
}
