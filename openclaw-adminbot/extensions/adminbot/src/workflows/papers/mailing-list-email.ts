/**
 * Sends the publication digest to one address, through the same `gog` CLI as every other lab mail.
 *
 * Deliberately not a propose -> approve -> execute action, on the same reasoning as the
 * account-approved mail: an admin has already chosen the range and typed the recipient on the tab
 * that triggers this, and asking them to approve their own click would be asking twice. The route
 * is admin-session-gated and every send is audited with the range, the recipient and the count.
 *
 * `reply_to` is set: this mail invites a reply from somebody outside the lab (a funder, a
 * collaborator, a mailing list owner), and replies to the bot mailbox are read by nobody.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { renderEmailBodyHtml } from "../../connectors/email-html.js";
import { resolveGogExecutable } from "../../connectors/gog.js";

const execFile = promisify(execFileCallback);
const GOG_TIMEOUT_MS = 45_000;
const GOG_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Where replies to a publication digest should land. See the module note. */
export const PUBLICATION_DIGEST_REPLY_TO = "akim@cs.toronto.edu";

export type PublicationMailingRunner = (params: {
  to: string;
  subject: string;
  body: string;
}) => Promise<void>;

export function createPublicationMailingRunner(
  options: {
    env?: NodeJS.ProcessEnv;
    replyTo?: string;
    // Same seam as the other mail runners: lets tests assert the command without shelling out to a
    // real binary and mailing a real person.
    run?: (args: string[]) => Promise<void>;
  } = {},
): PublicationMailingRunner {
  const gog = resolveGogExecutable(options.env);
  const replyTo = options.replyTo?.trim() || PUBLICATION_DIGEST_REPLY_TO;
  return async ({ to, subject, body }) => {
    const recipient = to.trim();
    if (!recipient) {
      throw new Error("the publication digest needs a recipient address");
    }
    // GOG_ACCOUNT pins the sending mailbox the way the action executor's payload `account` does;
    // without it gog falls back to whichever account it considers default.
    const account = (options.env ?? process.env).GOG_ACCOUNT?.trim();
    const args = [
      "--json",
      "--no-input",
      "--enable-commands-exact",
      "gmail.send",
      ...(account ? ["--account", account] : []),
      "gmail",
      "send",
      "--to",
      recipient,
      "--subject",
      subject,
      "--body",
      body,
      // text/plain alone comes out hard-wrapped mid paragraph, and a publication list is mostly
      // titles and URLs -- the two things a break through them ruins.
      "--body-html",
      renderEmailBodyHtml(body),
      "--reply-to",
      replyTo,
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
      const failure = error as { code?: unknown; stderr?: unknown };
      if (failure?.code === "ENOENT") {
        throw new Error("gog executable was not found in the AdminBot service PATH", {
          cause: error,
        });
      }
      const detail =
        typeof failure?.stderr === "string" ? failure.stderr.trim().slice(0, 500) : undefined;
      throw new Error(detail ? `gog gmail send failed: ${detail}` : "gog gmail send failed", {
        cause: error,
      });
    }
  };
}
