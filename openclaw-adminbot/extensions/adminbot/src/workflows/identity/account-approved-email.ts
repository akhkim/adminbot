import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { renderEmailBodyHtml } from "../../connectors/email-html.js";
import { resolveGogExecutable } from "../../connectors/gog.js";

const execFile = promisify(execFileCallback);
const GOG_TIMEOUT_MS = 45_000;
const GOG_MAX_OUTPUT_BYTES = 1024 * 1024;

// Where an approved member goes to sign in. Overridable so a different deployment (or a test) does
// not have to patch code, but defaulted because the lab has exactly one dashboard.
const DEFAULT_DASHBOARD_URL = "https://jinesis-admin.vercel.app";

export const ACCOUNT_APPROVED_SUBJECT = "Your Jinesis Lab account is approved";

export type AccountApprovedEmailRunner = (params: {
  email: string;
  name?: string;
}) => Promise<void>;

/**
 * Emails a newly approved member to tell them their account is live, via the same `gog` CLI the
 * action executor sends every other lab email with. This is a notification of a decision an admin
 * has already made, so it deliberately does not go through the propose -> approve -> execute
 * pipeline that `email.send` proposals use: that would ask an admin to approve the same account
 * twice. Callers must treat a rejected promise as non-fatal — approval itself has already been
 * recorded, and a failed email is audited for retry rather than rolled back.
 */
export function createAccountApprovedEmailRunner(
  options: {
    env?: NodeJS.ProcessEnv;
    dashboardUrl?: string;
    // Same seam as the gog action executor's `run`: lets tests assert the command without
    // shelling out to a real binary (and mailing a real person).
    run?: (args: string[]) => Promise<void>;
  } = {},
): AccountApprovedEmailRunner {
  const gog = resolveGogExecutable(options.env);
  const dashboardUrl =
    options.dashboardUrl?.trim() ||
    (options.env ?? process.env).ADMINBOT_DASHBOARD_URL?.trim() ||
    DEFAULT_DASHBOARD_URL;
  return async ({ email, name }) => {
    const to = email.trim();
    if (!to) {
      throw new Error("account approval email requires a non-empty email");
    }
    // GOG_ACCOUNT pins the sending mailbox the same way the action executor's payload `account`
    // does; without it gog falls back to whichever account it considers default.
    const account = (options.env ?? process.env).GOG_ACCOUNT?.trim();
    const body = buildAccountApprovedEmailBody({ name, dashboardUrl });
    const args = [
      "--json",
      "--no-input",
      "--enable-commands-exact",
      "gmail.send",
      ...(account ? ["--account", account] : []),
      "gmail",
      "send",
      "--to",
      to,
      "--subject",
      ACCOUNT_APPROVED_SUBJECT,
      "--body",
      body,
      // Same reason as every other lab email: text/plain alone comes out hard-wrapped mid
      // paragraph, and the sign-in URL is the line that suffers most from a break through it.
      "--body-html",
      renderEmailBodyHtml(body),
    ];
    if (options.run) {
      await options.run(args);
      return;
    }
    try {
      await execFile(gog, args, {
        env: options.env ?? process.env,
        maxBuffer: GOG_MAX_OUTPUT_BYTES,
        timeout: GOG_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch (error) {
      throw new Error(formatGogEmailError(error), { cause: error });
    }
  };
}

/** Exported for tests and so the copy can be reviewed without running the CLI. */
export function buildAccountApprovedEmailBody(params: {
  name?: string;
  dashboardUrl: string;
}): string {
  const greeting = params.name?.trim() ? `Hi ${params.name.trim()},` : "Hi,";
  return [
    greeting,
    "",
    "Your Jinesis Lab account has been approved. You can now sign in with the email and password you registered:",
    params.dashboardUrl,
    "",
    "Once you are in, the dashboard shows the lab roster, active papers and their deadlines, and the reimbursement tool. Your onboarding checklist is waiting there too.",
    "",
    "If you did not request this account, reply to this email and we will remove it.",
    "",
    "— AdminBot, Jinesis Lab",
  ].join("\n");
}

function formatGogEmailError(error: unknown): string {
  const failure = error as { code?: unknown; stderr?: unknown };
  if (failure?.code === "ENOENT") {
    return "gog executable was not found in the AdminBot service PATH";
  }
  const detail =
    typeof failure?.stderr === "string"
      ? // \p{Cc} is the Unicode control-character class: CLI stderr can carry ANSI escapes that
        // would otherwise be replayed verbatim into an audit record.
        failure.stderr
          .replaceAll(/\p{Cc}+/gu, " ")
          .trim()
          .slice(0, 500)
      : undefined;
  return detail ? `gog gmail send failed: ${detail}` : "gog gmail send failed";
}
