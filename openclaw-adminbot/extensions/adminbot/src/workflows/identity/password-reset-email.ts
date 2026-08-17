import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { renderEmailBodyHtml } from "../../connectors/email-html.js";
import { resolveGogExecutable } from "../../connectors/gog.js";
import { buildPasswordResetUrl, resolveAdminBotControlUiUrl } from "../../contracts/control-ui.js";

const execFile = promisify(execFileCallback);
const GOG_TIMEOUT_MS = 45_000;
const GOG_MAX_OUTPUT_BYTES = 1024 * 1024;

export const PASSWORD_RESET_SUBJECT = "Reset your Jinesis Lab password";

export type PasswordResetEmailRunner = (params: {
  email: string;
  name?: string;
  // The raw one-time token. Only ever held in memory here and in the mail body — the store keeps
  // its hash — so the URL is assembled at send time rather than by the auth workflow.
  token: string;
  expiresInMinutes: number;
}) => Promise<void>;

/**
 * Emails a member the one-time link that lets them set a new password, through the same `gog` CLI
 * every other lab email goes out on. Like the account-approved mail this deliberately skips the
 * propose -> approve -> execute pipeline: an admin approving each reset would defeat the point of a
 * self-service recovery, and the mail only ever goes to the address already on the credential.
 * Callers must treat a rejected promise as non-fatal — the token row is already written, and the
 * failure is audited rather than rolled back.
 */
export function createPasswordResetEmailRunner(
  options: {
    env?: NodeJS.ProcessEnv;
    // The Control UI origin the link lands on. Not the AdminBot service origin: only the Control
    // UI can redeem the token — see contracts/control-ui.ts.
    controlUiUrl?: string;
    // Same seam as the other gog runners: lets tests assert the argv without mailing a real person.
    run?: (args: string[]) => Promise<void>;
  } = {},
): PasswordResetEmailRunner {
  const env = options.env ?? process.env;
  const gog = resolveGogExecutable(options.env);
  const controlUiUrl = options.controlUiUrl?.trim() || resolveAdminBotControlUiUrl(env);
  // Pins the Control UI back to the AdminBot that minted the token when this deployment publishes
  // a public service origin; unset, the Control UI keeps whatever its own build declared.
  const adminBotUrl = env.ADMINBOT_PUBLIC_URL?.trim();
  return async ({ email, name, token, expiresInMinutes }) => {
    const to = email.trim();
    if (!to) {
      throw new Error("password reset email requires a non-empty email");
    }
    const account = env.GOG_ACCOUNT?.trim();
    const resetUrl = buildPasswordResetUrl({ token, controlUiUrl, adminBotUrl });
    const body = buildPasswordResetEmailBody({ name, resetUrl, expiresInMinutes });
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
      PASSWORD_RESET_SUBJECT,
      "--body",
      body,
      // text/plain alone hard-wraps mid-paragraph, and the reset URL is the line that suffers most
      // from a break through it.
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
export function buildPasswordResetEmailBody(params: {
  name?: string;
  resetUrl: string;
  expiresInMinutes: number;
}): string {
  const greeting = params.name?.trim() ? `Hi ${params.name.trim()},` : "Hi,";
  return [
    greeting,
    "",
    "Someone asked to reset the password on your Jinesis Lab account. Open this link to choose a new one:",
    params.resetUrl,
    "",
    `The link works once and expires in ${params.expiresInMinutes} minutes.`,
    "",
    "If you did not ask for this, you can ignore this email — your current password still works and nothing has changed.",
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
      ? failure.stderr
          .replaceAll(/\p{Cc}+/gu, " ")
          .trim()
          .slice(0, 500)
      : undefined;
  return detail ? `gog gmail send failed: ${detail}` : "gog gmail send failed";
}
