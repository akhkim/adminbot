import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const GWS_TIMEOUT_MS = 45_000;
const GWS_MAX_OUTPUT_BYTES = 1024 * 1024;

// The lab's shared Google Calendar. Members are granted read-only ("reader") guest access here
// automatically when their account is approved (see auth.ts `approveRegistration`).
//
// It is a real mailbox, so it comes from the environment. Unset, the invite runner rejects with a
// message naming the var -- callers already treat a rejection as non-fatal, so an unconfigured
// deployment approves members without a calendar invite instead of failing the approval.
export const ADMINBOT_LAB_EMAIL_ENV = "ADMINBOT_LAB_EMAIL";

export type CalendarInviteRunner = (email: string) => Promise<void>;

// The AdminBot service's systemd unit runs with a minimal PATH that doesn't include the npm
// global bin directory `gws` installs into, so a bare "gws" lookup fails with ENOENT there even
// though it resolves fine in an interactive shell. Mirrors the resolution
// `scripts/adminbot-email-automation.ts`'s GWS constant already uses.
function resolveGwsExecutable(env: NodeJS.ProcessEnv | undefined): string {
  const candidates = [
    (env ?? process.env).GWS_BIN ?? "",
    path.join(os.homedir(), ".npm-global", "bin", "gws"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return "gws";
}

/**
 * Grants view-only access to the lab calendar via the `gws` CLI's calendar ACL endpoint — the
 * same mechanism `scripts/adminbot-email-automation.ts`'s `addCalendarReader` already uses against
 * this calendar. Callers must treat a rejected promise as non-fatal: approving a new member must
 * not fail just because the calendar invite failed (log/audit it and move on instead).
 */
export function createCalendarInviteRunner(env?: NodeJS.ProcessEnv): CalendarInviteRunner {
  const gws = resolveGwsExecutable(env);
  return async (email) => {
    const trimmed = email.trim();
    if (!trimmed) {
      throw new Error("calendar invite requires a non-empty email");
    }
    const calendarId = (env ?? process.env)[ADMINBOT_LAB_EMAIL_ENV]?.trim();
    if (!calendarId) {
      throw new Error(
        `the lab calendar is not configured: set ${ADMINBOT_LAB_EMAIL_ENV} to grant calendar access`,
      );
    }
    try {
      await execFile(
        gws,
        [
          "calendar",
          "acl",
          "insert",
          "--params",
          JSON.stringify({ calendarId, sendNotifications: true }),
          "--json",
          JSON.stringify({ role: "reader", scope: { type: "user", value: trimmed } }),
        ],
        {
          env: env ?? process.env,
          maxBuffer: GWS_MAX_OUTPUT_BYTES,
          timeout: GWS_TIMEOUT_MS,
          windowsHide: true,
        },
      );
    } catch (error) {
      throw new Error(formatGwsError(error), { cause: error });
    }
  };
}

function formatGwsError(error: unknown): string {
  const failure = error as { code?: unknown; stderr?: unknown };
  if (failure?.code === "ENOENT") {
    return "gws executable was not found in the AdminBot service PATH";
  }
  const detail =
    typeof failure?.stderr === "string"
      ? failure.stderr.replace(new RegExp("[\\x00-\\x1f\\x7f]+", "gu"), " ").trim().slice(0, 500)
      : undefined;
  return detail ? `gws calendar acl insert failed: ${detail}` : "gws calendar acl insert failed";
}
