// Sends a composed onboarding guide, and provisions the two things the copy references.
//
// Provisioning happens before the send and both halves must succeed: an email that tells someone
// their Drive folder is at "{drive_folder_link}", or hands them a Slack fallback with no invite to
// fall back from, is worse than no email. On failure nothing is sent and the Drive folder cleans
// itself up.
//
// Slack arrives as an injected seam rather than an import. The invite needs the Slack extension's
// write client, and a bundled plugin reaching into another plugin is exactly what the extensions
// boundary forbids -- so the composition root wires it, the same way the calendar invite and the
// account-approved email are wired.
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { DriveWorkspaceProvisioner } from "./drive-workspace.js";
import { renderEmailBodyHtml } from "./email-html.js";
import { resolveGogExecutable } from "./gog-executor.js";
import { findOnboardingTemplate } from "./onboarding-emails.js";
import {
  composeOnboardingGuide,
  driveWorkspaceFolderName,
  firstNameOf,
  type AdminBotComposedGuide,
} from "./onboarding-guide.js";

const execFile = promisify(execFileCallback);
const GOG_TIMEOUT_MS = 45_000;
const GOG_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Mints a Slack Connect invite and returns its URL.
 *
 * The link expires after roughly 14 days, which is why it is minted per send and never stored.
 *
 * Note that `conversations.inviteShared` requires `emails` or `user_ids`, so Slack will also send
 * its own invite mail to the address. The guide carries the same link deliberately: the recipient
 * can act from either message, and the guide is the one that explains what the invite is for.
 */
export type SlackConnectInviter = (params: {
  email: string;
  channelId: string;
}) => Promise<{ url: string }>;

export type AdminBotOnboardingSendRequest = {
  template_id: string;
  name: string;
  email: string;
  /** Everything the template needs that the tab collected by hand. */
  values?: Record<string, string | undefined>;
  slack_channel_id?: string;
  /** Compose and provision nothing; used by the tab's preview. */
  preview?: boolean;
};

export type AdminBotOnboardingSendResult = {
  template_id: string;
  subject: string;
  body: string;
  /** HTML alternative rendered from `body`; absent only when the body renders to nothing. */
  body_html?: string;
  sent: boolean;
  drive_folder_link?: string;
  slack_connect_link?: string;
};

export type AdminBotOnboardingSendFailure = {
  status: number;
  message: string;
  missing?: string[];
};

export type AdminBotOnboardingSender = (
  request: AdminBotOnboardingSendRequest,
) => Promise<
  | { ok: true; payload: AdminBotOnboardingSendResult }
  | { ok: false; error: AdminBotOnboardingSendFailure }
>;

export type AdminBotOnboardingSenderOptions = {
  env?: NodeJS.ProcessEnv;
  provisionDriveWorkspace?: DriveWorkspaceProvisioner;
  inviteToSlackConnect?: SlackConnectInviter;
  /** Resolves `{zhijing_whatsapp}`; reads AdminBot settings so no phone number lives in the repo. */
  headProfessorWhatsapp?: () => string | undefined;
  defaultSlackChannelId?: string;
  sendEmail?: (params: {
    to: string;
    subject: string;
    body: string;
    body_html?: string;
  }) => Promise<void>;
};

/** #jinesis-with-friends-and-collaborators — where external collaborators and trials land. */
export const DEFAULT_SLACK_CONNECT_CHANNEL_ID = "C09MANEUPPZ";

function gogEmailSender(env: NodeJS.ProcessEnv) {
  const gog = resolveGogExecutable(env);
  return async ({
    to,
    subject,
    body,
    body_html: bodyHtml,
  }: {
    to: string;
    subject: string;
    body: string;
    body_html?: string;
  }) => {
    const account = env.GOG_ACCOUNT?.trim();
    await execFile(
      gog,
      [
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
        subject,
        "--body",
        body,
        // Without an html alternative the delivered text/plain part is wrapped for us, mid
        // paragraph, at whatever width the encoder and the reading client agree on.
        ...(bodyHtml ? ["--body-html", bodyHtml] : []),
      ],
      { env, maxBuffer: GOG_MAX_OUTPUT_BYTES, timeout: GOG_TIMEOUT_MS, windowsHide: true },
    );
  };
}

/** The html alternative as a spreadable field, omitted rather than empty when there is no body. */
function htmlOf(body: string): { body_html?: string } {
  const rendered = renderEmailBodyHtml(body);
  return rendered ? { body_html: rendered } : {};
}

function needs(templateId: string, token: string): boolean {
  return findOnboardingTemplate(templateId)?.required.includes(token) ?? false;
}

export function createAdminBotOnboardingSender(
  options: AdminBotOnboardingSenderOptions = {},
): AdminBotOnboardingSender {
  const env = options.env ?? process.env;
  const sendEmail = options.sendEmail ?? gogEmailSender(env);
  return async (request) => {
    const name = request.name?.trim() ?? "";
    const email = request.email?.trim() ?? "";
    if (!name) {
      return { ok: false, error: { status: 400, message: "name is required" } };
    }
    if (!email.includes("@")) {
      return { ok: false, error: { status: 400, message: "a valid email is required" } };
    }
    const template = findOnboardingTemplate(request.template_id);
    if (!template) {
      return {
        ok: false,
        error: { status: 404, message: `unknown template: ${request.template_id}` },
      };
    }

    const base: Record<string, string | undefined> = {
      ...request.values,
      first_name: request.values?.first_name?.trim() || firstNameOf(name),
      zhijing_whatsapp: request.values?.zhijing_whatsapp ?? options.headProfessorWhatsapp?.(),
    };

    // Report every missing hand-entered value at once, before provisioning anything: asking the
    // operator for one field at a time after a Drive folder already exists is how half-provisioned
    // people happen. Generated values are excluded here because they do not exist yet.
    const generated = new Set(["drive_folder_link", "slack_connect_link"]);
    const missingByHand = template.required.filter(
      (token) => !generated.has(token) && !base[token]?.trim(),
    );
    if (missingByHand.length > 0) {
      return {
        ok: false,
        error: {
          status: 422,
          message: `missing required values: ${missingByHand.join(", ")}`,
          missing: missingByHand,
        },
      };
    }

    if (request.preview) {
      const preview = composeOnboardingGuide(template.id, {
        ...base,
        drive_folder_link: base.drive_folder_link ?? "(generated when sent)",
        slack_connect_link: base.slack_connect_link ?? "(generated when sent)",
      });
      if (!preview.ok) {
        return {
          ok: false,
          error: { status: 422, message: "missing required values", missing: preview.missing },
        };
      }
      // The preview shows the operator exactly what the send would produce, html included.
      return {
        ok: true,
        payload: { ...preview.guide, ...htmlOf(preview.guide.body), sent: false },
      };
    }

    const values = { ...base };
    let driveLink: string | undefined;
    let slackLink: string | undefined;

    if (needs(template.id, "drive_folder_link") && !values.drive_folder_link?.trim()) {
      if (!options.provisionDriveWorkspace) {
        return {
          ok: false,
          error: { status: 501, message: "Drive workspace provisioning is not configured" },
        };
      }
      // A rejection here (Drive quota, an invalid parent folder, an auth-profile issue) must not
      // reach the caller as a bare thrown exception: the only place that catches it is the HTTP
      // server's generic 500 handler, which reports whatever Error.message happens to say with no
      // indication of which of the two provisioning calls actually failed. Naming it here is the
      // difference between "check the details and try again" and an operator who can act on it.
      let workspace: { folderId: string; link: string };
      try {
        workspace = await options.provisionDriveWorkspace({
          folderName: driveWorkspaceFolderName(name),
        });
      } catch (error) {
        return {
          ok: false,
          error: {
            status: 502,
            message: `Drive workspace provisioning failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
      driveLink = workspace.link;
      values.drive_folder_link = workspace.link;
    }

    if (needs(template.id, "slack_connect_link") && !values.slack_connect_link?.trim()) {
      if (!options.inviteToSlackConnect) {
        return {
          ok: false,
          error: { status: 501, message: "Slack Connect invites are not configured" },
        };
      }
      // Same reasoning as the Drive branch above: a missing bot token, a missing scope, or the
      // channel rejecting the invite all throw here, and each has a distinct fix.
      let invite: { url: string };
      try {
        invite = await options.inviteToSlackConnect({
          email,
          channelId:
            request.slack_channel_id?.trim() ||
            options.defaultSlackChannelId?.trim() ||
            DEFAULT_SLACK_CONNECT_CHANNEL_ID,
        });
      } catch (error) {
        return {
          ok: false,
          error: { status: 502, message: `Slack Connect invite failed: ${error instanceof Error ? error.message : String(error)}` },
        };
      }
      slackLink = invite.url;
      values.slack_connect_link = invite.url;
    }

    const composed = composeOnboardingGuide(template.id, values);
    if (!composed.ok) {
      return {
        ok: false,
        error: { status: 422, message: "missing required values", missing: composed.missing },
      };
    }
    const guide: AdminBotComposedGuide = composed.guide;
    const html = htmlOf(guide.body);
    await sendEmail({ to: email, subject: guide.subject, body: guide.body, ...html });
    return {
      ok: true,
      payload: {
        ...guide,
        ...html,
        sent: true,
        ...(driveLink ? { drive_folder_link: driveLink } : {}),
        ...(slackLink ? { slack_connect_link: slackLink } : {}),
      },
    };
  };
}
