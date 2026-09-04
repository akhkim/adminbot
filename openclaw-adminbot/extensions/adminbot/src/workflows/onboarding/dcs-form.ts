import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const DCS_FORM_TIMEOUT_MS = 90_000;
const DCS_FORM_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * The roster's one free-text `name`, as the separate First/Last answers an external form wants.
 *
 * Split on the last run of whitespace: everything before it is the first name (which covers
 * middle names and initials), the final token is the last name.
 *
 * `undefined` when there is no last name to give, which the caller must treat as "cannot file
 * this". It used to answer a one-word name by putting that word in *both* fields, and the result
 * was a real DCS account requested for "Eric Eric" -- a wrong surname on a university system,
 * filed under the lab's name, which is worse than the blank the duplication was avoiding. There
 * are 14 one-word names on the roster today, so this was not a one-off.
 *
 * Whitespace is matched as a class rather than as a literal " " for the same reason: a name
 * pasted out of Slack or Sheets can carry a non-breaking or full-width space, and against a
 * literal space "Eric\u00a0Zhang" looked exactly like a mononym and was duplicated whole.
 */
export function splitDisplayName(
  name: string,
): { firstName: string; lastName: string } | undefined {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const lastName = parts.length > 1 ? parts.at(-1) : undefined;
  if (!lastName) {
    return undefined;
  }
  return { firstName: parts.slice(0, -1).join(" "), lastName };
}

export type DcsFormRunner = (params: {
  firstName: string;
  lastName: string;
  email: string;
}) => Promise<void>;

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
