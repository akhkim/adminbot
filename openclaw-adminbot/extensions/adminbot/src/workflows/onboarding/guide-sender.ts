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
import {
  adminBotExternalCollaboratorSubgroups,
  type AdminBotExternalCollaboratorSubgroup,
} from "../../contracts/actions.js";
import { renderEmailBodyHtml } from "../../connectors/email-html.js";
import { collaboratorSubgroupAccess } from "../members/collaborator-subgroups.js";
import { resolveGogExecutable } from "../../connectors/gog.js";
import { adminBotSlackConnectInviteIsFresh } from "../../kernel/service.js";
import { splitDisplayName, type DcsFormRunner } from "./dcs-form.js";
import type { DriveWorkspaceProvisioner } from "./drive-workspace.js";
import { findOnboardingTemplate } from "./emails.js";
import {
  composeOnboardingGuide,
  configuredEnvValue,
  driveWorkspaceFolderName,
  firstNameOf,
  unfilledPlaceholders,
  type AdminBotComposedGuide,
  type AdminBotGuideComposeResult,
  type AdminBotGuideOverrides,
} from "./guide.js";

const execFile = promisify(execFileCallback);
const GOG_TIMEOUT_MS = 45_000;
// The full-member guide: the one mail whose copy promises a CS account request.
/**
 * Whose Drive folder is provisioned with the lab's templates in it.
 *
 * Everyone else who gets a folder -- trial-phase students, co-authors, visiting professors,
 * acquaintances -- gets an empty one. The prototype holds the lab's own working documents, and
 * handing those to someone on a trial or to an external collaborator shares more of the lab than
 * their relationship to it warrants. Keyed on the template rather than on a roster lookup because
 * the send path is what decides which onboarding someone is getting, and a recipient is often not
 * on the roster yet at the moment the folder is created.
 */
const FULL_MEMBER_TEMPLATE_IDS = new Set(["member", "member_what_to_expect"]);

const DCS_FORM_TEMPLATE_ID = "member";

/**
 * The mail whose Slack Connect invitation travels separately, and the template that carries it.
 *
 * The alumni mail follows the 2026-08-07 template doc, which points alumni at the workspace join
 * link and carries no {slack_connect_link}. The invitation is still wanted; it just does not belong
 * in that mail, and it does not go out with it either -- it follows ten days later, sent by the
 * sweep behind /onboarding/alumni-slack-invites/run.
 *
 * Minted there rather than here on purpose. A Connect link goes stale in about a fortnight (see
 * adminBotSlackConnectInviteIsFresh), so one minted at welcome time and mailed ten days later would
 * reach the reader with days left on it. The delay is the whole reason the mint moved.
 */
const GOG_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Mints a Slack Connect invite and returns its URL.
 *
 * The link goes stale after roughly a fortnight, so a minted one is remembered for
 * ADMINBOT_SLACK_CONNECT_INVITE_DAYS and handed out again inside that window rather than re-minted
 * per send -- see `slackConnectInviteCache`. Past it, this is called again for a fresh one.
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
  /**
   * Also file the DCS Slack-access request for this person.
   *
   * Defaults to on for the full-member guide and off for every other template: that mail is what
   * starts a new member's CS account, and its own copy tells the reader an account request is
   * coming. This used to fire on registration approval instead, which was the wrong moment --
   * by then the member has an address and the request has already been made.
   *
   * Still a flag rather than a rule, because a re-send is not a second request: an operator
   * resending the guide to someone who already has an account unticks it.
   */
  submit_dcs_form?: boolean;
  /** Compose and provision nothing; used by the tab's preview. */
  preview?: boolean;
  /**
   * The copy as the operator edited it in the preview, replacing the stored template for this one
   * send. Blank or absent means send the template unchanged.
   *
   * Edited copy is still substituted before it goes out -- the preview shows the two provisioned
   * links as placeholders because they do not exist yet -- and a placeholder that survives
   * substitution refuses the send, exactly as it does for the stored copy.
   */
  subject_override?: string;
  body_override?: string;
  /**
   * Channels to invite the recipient to as well, by name ("#proj-alg-circuit") or by id.
   *
   * The onboarding mails tell a collaborator they will be invited to their project channel, and
   * until this existed nothing made that true: the Connect invite goes to the one configured
   * onboarding channel, so every project channel was added by hand, or forgotten. Invites are
   * minted before the mail goes out, and a failure stops the send -- a mail promising an invite
   * that never arrives is the case this ordering exists to prevent.
   */
  slack_project_channels?: readonly string[];
  /**
   * Who else goes on the thread, and where a reply should land.
   *
   * Carried on the request because they are per-recipient facts, not template ones: the matching
   * mails put each applicant's project lead on the thread so the lead can answer in place, and
   * every one of these asks for a reply that must not come back to the bot mailbox nobody reads.
   * Composed copy used to carry both in the plan file and lose them at the sender, which sent a
   * mail whose "the lead cc'ed will be your contact" sentence was not true of the mail itself.
   */
  cc?: readonly string[];
  reply_to?: string;
};

export type AdminBotOnboardingSendResult = {
  template_id: string;
  subject: string;
  /** Present when the send also filed a DCS Slack-access request; absent when it did not try. */
  dcs_form?: { submitted: boolean; error?: string };
  body: string;
  /** HTML alternative rendered from `body`; absent only when the body renders to nothing. */
  body_html?: string;
  sent: boolean;
  drive_folder_link?: string;
  slack_connect_link?: string;
  /** One entry per channel from `slack_project_channels`, in the order they were requested. */
  project_channel_invites?: { channel: string; url: string }[];
  /**
   * The standing-channel invites this subgroup is owed by the access matrix. `configured: false`
   * means the matrix grants them but no channel ids are set, so nobody was invited -- reported
   * rather than swallowed, because "we thought they were in" is the failure this is fixing.
   */
  active_channel_invites?: {
    configured: boolean;
    invited: { channel: string; url: string }[];
  };
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
  /**
   * Files the DCS Slack-access request. Same injection seam as the two provisioners above, and the
   * same runner the approval path uses -- the composition layer owns the script path, so a send
   * and an approval can never file the request two different ways.
   */
  submitDcsForm?: DcsFormRunner;
  /** Resolves `{zhijing_whatsapp}`; reads AdminBot settings so no phone number lives in the repo. */
  headProfessorWhatsapp?: () => string | undefined;
  defaultSlackChannelId?: string;
  /**
   * Remembers the Slack Connect invite minted for one address and channel, so a re-send hands out
   * the same link instead of a second invitation.
   *
   * Optional: without it every send mints a new one, which is the old behaviour and still correct,
   * just noisier for the recipient.
   */
  slackConnectInviteCache?: {
    get: (
      email: string,
      channelId: string,
    ) => { url: string; created_at: string } | undefined;
    save: (invite: {
      email: string;
      channel_id: string;
      url: string;
      created_at: string;
    }) => void;
  };
  now?: () => Date;
  /**
   * The address this person's portal account is under, given the address the mail is going to.
   *
   * They are different facts and the copy names the wrong one without this. A member's login is
   * the governed `email` on their roster row -- ybilleter@cs.toronto.edu -- while the guide is
   * sent to the address they actually read, ybilleter@ethz.ch. "Log into our lab portal using
   * {member_email}" then named an address the portal has never heard of, and the reader's only
   * way to find that out is a failed sign-in.
   *
   * Injected rather than looked up here because this module owns no store; the composition root
   * hands it the roster the same way it hands over the WhatsApp number and the invite cache.
   */
  portalLoginEmail?: (recipientEmail: string) => string | undefined;
  sendEmail?: (params: {
    to: string;
    subject: string;
    body: string;
    body_html?: string;
    cc?: readonly string[];
    reply_to?: string;
  }) => Promise<void>;
};

/**
 * The Slack Connect channel new externals land in -- #jinesis-with-friends-and-collaborators on
 * this deployment. It identifies a specific workspace, so it comes from the environment; a request
 * or the composition root may still override it per send.
 */
export const ADMINBOT_ONBOARDING_CHANNEL_ENV = "ADMINBOT_ONBOARDING_CHANNEL_ID";

/**
 * The lab's two standing channels, comma-separated, for the subgroups the access matrix puts in
 * them. Ids rather than names, because that is what the Slack API invites into.
 */
export const ADMINBOT_ACTIVE_CHANNELS_ENV = "ADMINBOT_ACTIVE_CHANNEL_IDS";

/**
 * The access-matrix row that puts somebody in #jinesis-active and #random-active.
 *
 * Read from the matrix rather than from a token in the copy. The Drive folder taught us what the
 * other way costs: `{drive_folder_link}` was both the sentence and the trigger, so editing the copy
 * silently changed who got provisioned. Access is a property of the subgroup, so it is decided by
 * the table that describes the subgroup -- which also means this row stops being merely descriptive
 * and starts doing something, which is the whole point.
 */
const ACTIVE_CHANNELS_ACCESS_ITEM = "active_channels";

/** The production email sender, exported so a caller can wrap it and still report what it did. */
export function gogEmailSender(env: NodeJS.ProcessEnv = process.env) {
  const gog = resolveGogExecutable(env);
  return async ({
    to,
    subject,
    body,
    body_html: bodyHtml,
    cc,
    reply_to: replyTo,
  }: {
    to: string;
    subject: string;
    body: string;
    body_html?: string;
    cc?: readonly string[];
    reply_to?: string;
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
        // gog takes both as comma-separated strings. Dropped here until now, so a plan that named
        // a lead on the thread produced a mail that did not.
        ...(cc?.length ? ["--cc", cc.join(",")] : []),
        ...(replyTo ? ["--reply-to", replyTo] : []),
      ],
      {
        env,
        maxBuffer: GOG_MAX_OUTPUT_BYTES,
        timeout: GOG_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  };
}

/**
 * A compose refusal, as an HTTP-shaped failure. A missing env var is 503 rather than 422: nothing
 * the caller can type fixes it, the deployment has to be configured.
 */
function composeFailure(
  result: Extract<AdminBotGuideComposeResult, { ok: false }>,
): AdminBotOnboardingSendFailure {
  if (result.reason === "missing-environment") {
    return {
      status: 503,
      message: `onboarding email is not configured: set ${result.missing.join(", ")}`,
      missing: result.missing,
    };
  }
  return {
    status: 422,
    message: "missing required values",
    missing: result.missing,
  };
}

/** The html alternative as a spreadable field, omitted rather than empty when there is no body. */
function htmlOf(body: string): { body_html?: string } {
  const rendered = renderEmailBodyHtml(body);
  return rendered ? { body_html: rendered } : {};
}

export function createAdminBotOnboardingSender(
  options: AdminBotOnboardingSenderOptions = {},
): AdminBotOnboardingSender {
  const env = options.env ?? process.env;
  const sendEmail = options.sendEmail ?? gogEmailSender(env);
  return async (request) => {
    const overrides: AdminBotGuideOverrides = {
      ...(request.subject_override?.trim()
        ? { subject: request.subject_override }
        : {}),
      ...(request.body_override?.trim() ? { body: request.body_override } : {}),
    };
    const name = request.name?.trim() ?? "";
    const email = request.email?.trim() ?? "";
    if (!name) {
      return { ok: false, error: { status: 400, message: "name is required" } };
    }
    if (!email.includes("@")) {
      return {
        ok: false,
        error: { status: 400, message: "a valid email is required" },
      };
    }
    const template = findOnboardingTemplate(request.template_id);
    if (!template) {
      return {
        ok: false,
        error: {
          status: 404,
          message: `unknown template: ${request.template_id}`,
        },
      };
    }

    const base: Record<string, string | undefined> = {
      ...request.values,
      first_name: request.values?.first_name?.trim() || firstNameOf(name),
      // The address the mail is going to, for the copy that has to name it back to the reader
      // ("log in using ..."). Defaulted like first_name so nobody retypes the recipient.
      // Explicit value first (an operator typing it in the tab), then the account address, then
      // the recipient address as the last resort -- which is right for somebody whose account is
      // under the address they are being written to, and was silently wrong for everyone else.
      member_email:
        request.values?.member_email?.trim() || options.portalLoginEmail?.(email) || email,
      zhijing_whatsapp:
        request.values?.zhijing_whatsapp ?? options.headProfessorWhatsapp?.(),
    };

    // Report every missing hand-entered value at once, before provisioning anything: asking the
    // operator for one field at a time after a Drive folder already exists is how half-provisioned
    // people happen. Generated values are excluded here because they do not exist yet.
    const generated = new Set(["drive_folder_link", "slack_connect_link"]);
    // Edited copy is judged by what it still says, not by what the stored template said.
    const copy = `${overrides.subject ?? template.subject ?? ""}\n${overrides.body ?? template.body}`;
    const missingByHand = template.required.filter(
      (token) =>
        copy.includes(`{${token}}`) &&
        !generated.has(token) &&
        !base[token]?.trim(),
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
      // The two provisioned links are left as `{drive_folder_link}` / `{slack_connect_link}` rather
      // than described in prose: the preview is editable and comes back as the body to send, so a
      // stand-in sentence here would ship instead of the real link. Each one stands in for itself,
      // which satisfies the "every required value is present" check without resolving to anything.
      const preview = composeOnboardingGuide(
        template.id,
        {
          ...base,
          drive_folder_link: base.drive_folder_link ?? "{drive_folder_link}",
          slack_connect_link: base.slack_connect_link ?? "{slack_connect_link}",
        },
        env,
        overrides,
      );
      if (!preview.ok) {
        return { ok: false, error: composeFailure(preview) };
      }
      // The preview shows the operator exactly what the send would produce, html included.
      return {
        ok: true,
        payload: {
          ...preview.guide,
          ...htmlOf(preview.guide.body),
          sent: false,
        },
      };
    }

    // A placeholder in edited copy refuses the send before anything is created: finding out after
    // a Drive folder and a Slack invite exist would leave both behind for a mail that never went.
    if (overrides.subject || overrides.body) {
      const probe = composeOnboardingGuide(
        template.id,
        {
          ...base,
          drive_folder_link: "https://drive.example",
          slack_connect_link: "https://slack.example",
        },
        env,
        overrides,
      );
      if (!probe.ok) {
        return { ok: false, error: composeFailure(probe) };
      }
      const unknown = unfilledPlaceholders(
        `${probe.guide.subject}\n${probe.guide.body}`,
      );
      if (unknown.length > 0) {
        return {
          ok: false,
          error: {
            status: 422,
            message: `the edited email still has unfilled placeholders: ${unknown.map((token) => `{${token}}`).join(", ")}`,
            missing: unknown,
          },
        };
      }
    }

    const values = { ...base };
    let driveLink: string | undefined;
    let slackLink: string | undefined;

    // Provisioned because the copy being sent asks for it, not because the stored template does:
    // an operator who deleted the Drive sentence should not still get a folder created for them.
    if (
      copy.includes("{drive_folder_link}") &&
      !values.drive_folder_link?.trim()
    ) {
      if (!options.provisionDriveWorkspace) {
        return {
          ok: false,
          error: {
            status: 501,
            message: "Drive workspace provisioning is not configured",
          },
        };
      }
      const workspace = await options.provisionDriveWorkspace({
        folderName: driveWorkspaceFolderName(name),
        includeContents: FULL_MEMBER_TEMPLATE_IDS.has(template.id),
      });
      driveLink = workspace.link;
      values.drive_folder_link = workspace.link;
    }

    if (
      copy.includes("{slack_connect_link}") &&
      !values.slack_connect_link?.trim()
    ) {
      if (!options.inviteToSlackConnect) {
        return {
          ok: false,
          error: {
            status: 501,
            message: "Slack Connect invites are not configured",
          },
        };
      }
      const channelId =
        request.slack_channel_id?.trim() ||
        options.defaultSlackChannelId?.trim() ||
        configuredEnvValue(env[ADMINBOT_ONBOARDING_CHANNEL_ENV]);
      if (!channelId) {
        return {
          ok: false,
          error: {
            status: 503,
            message: `Slack Connect invites need a channel: set ${ADMINBOT_ONBOARDING_CHANNEL_ENV} or pass slack_channel_id`,
          },
        };
      }
      // A link already minted for this person and channel is handed out again while it is still
      // inside the reuse window. Minting one per send filled the recipient's inbox with a fresh
      // Slack invitation every time a mail was corrected and re-sent, and left several live
      // invitations to the same channel pointing at the same person.
      const cached = options.slackConnectInviteCache?.get(email, channelId);
      if (
        cached?.url &&
        adminBotSlackConnectInviteIsFresh(cached, options.now?.() ?? new Date())
      ) {
        slackLink = cached.url;
        values.slack_connect_link = cached.url;
      } else {
        // Reported, not thrown. Slack refuses for ordinary reasons -- not_in_channel is the usual
        // one, because the bot has to be in a channel before it can invite anyone into it -- and an
        // exception out of here killed the whole batch on its first recipient rather than failing
        // that one send and moving on.
        let invite: { url: string };
        try {
          invite = await options.inviteToSlackConnect({ email, channelId });
        } catch (error) {
          return {
            ok: false,
            error: {
              status: 502,
              message: `could not invite ${email} to the onboarding channel (${channelId}): ${error instanceof Error ? error.message : String(error)}`,
            },
          };
        }
        slackLink = invite.url;
        // Slack invited them either way; only the shareable link is optional. The copy reads
        // "...stay in touch: {slack_connect_link}", so a missing link becomes the sentence that is
        // actually true -- the invitation is in their inbox -- rather than a refusal to send.
        values.slack_connect_link =
          invite.url || "check your inbox for the Slack invitation";
        if (invite.url) {
          // Only a real link is worth remembering; the fallback sentence is not one.
          options.slackConnectInviteCache?.save({
            email,
            channel_id: channelId,
            url: invite.url,
            created_at: (options.now?.() ?? new Date()).toISOString(),
          });
        }
      }
    }

    // Project-channel invites, before the mail rather than after it. Nothing has been sent yet, so
    // a channel that does not resolve or a Slack refusal can still stop the whole send; afterwards
    // it could only be reported, and the recipient would already be holding the promise.
    const projectChannels = [
      ...new Set(
        (request.slack_project_channels ?? [])
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    ];
    const projectInvites: { channel: string; url: string }[] = [];
    if (projectChannels.length > 0) {
      if (!options.inviteToSlackConnect) {
        return {
          ok: false,
          error: {
            status: 501,
            message: "Slack Connect invites are not configured",
          },
        };
      }
      for (const channel of projectChannels) {
        try {
          const invite = await options.inviteToSlackConnect({
            email,
            channelId: channel,
          });
          projectInvites.push({ channel, url: invite.url });
        } catch (error) {
          return {
            ok: false,
            error: {
              status: 502,
              message: `could not invite ${email} to ${channel}: ${error instanceof Error ? error.message : String(error)}`,
            },
          };
        }
      }
    }

    // Standing-channel invites, from the access matrix rather than from the copy, and before the
    // mail for the same reason the project ones are: both the coauthor-major and own-pace mails
    // tell the reader their channel invitations are on the way, so a Slack refusal has to stop the
    // send while that promise can still be withheld.
    let activeChannelInvites:
      | { configured: boolean; invited: { channel: string; url: string }[] }
      | undefined;
    const subgroup = (
      adminBotExternalCollaboratorSubgroups as readonly string[]
    ).includes(template.id)
      ? (template.id as AdminBotExternalCollaboratorSubgroup)
      : undefined;
    const owedActiveChannels =
      subgroup !== undefined &&
      collaboratorSubgroupAccess(subgroup).some(
        (grant) => grant.item === ACTIVE_CHANNELS_ACCESS_ITEM,
      );
    if (owedActiveChannels) {
      const channels = [
        ...new Set(
          (configuredEnvValue(env[ADMINBOT_ACTIVE_CHANNELS_ENV]) ?? "")
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        ),
      ];
      if (channels.length === 0) {
        // Not fatal. A deployment that has never set the variable would otherwise be unable to
        // onboard these two subgroups at all, which is a worse failure than an uninvited member --
        // and the operator sees `configured: false` on every such send rather than nothing.
        activeChannelInvites = { configured: false, invited: [] };
      } else {
        if (!options.inviteToSlackConnect) {
          return {
            ok: false,
            error: {
              status: 501,
              message: "Slack Connect invites are not configured",
            },
          };
        }
        const invited: { channel: string; url: string }[] = [];
        for (const channel of channels) {
          try {
            const invite = await options.inviteToSlackConnect({
              email,
              channelId: channel,
            });
            invited.push({ channel, url: invite.url });
          } catch (error) {
            return {
              ok: false,
              error: {
                status: 502,
                message: `could not invite ${email} to ${channel}: ${error instanceof Error ? error.message : String(error)}`,
              },
            };
          }
        }
        activeChannelInvites = { configured: true, invited };
      }
    }

    const composed = composeOnboardingGuide(
      template.id,
      values,
      env,
      overrides,
    );
    if (!composed.ok) {
      return { ok: false, error: composeFailure(composed) };
    }
    const guide: AdminBotComposedGuide = composed.guide;
    // The same guard as the pre-flight above, on the text that is actually about to be mailed.
    // It should never fire -- the pre-flight catches edited copy, and stored copy declares every
    // token it uses -- but rule 1 is the one thing worth checking twice, and this is the last
    // moment anything can.
    const leftover = unfilledPlaceholders(`${guide.subject}\n${guide.body}`);
    if (leftover.length > 0) {
      return {
        ok: false,
        error: {
          status: 422,
          message: `the edited email still has unfilled placeholders: ${leftover.map((token) => `{${token}}`).join(", ")}`,
          missing: leftover,
        },
      };
    }
    const html = htmlOf(guide.body);
    await sendEmail({
      to: email,
      subject: guide.subject,
      body: guide.body,
      ...html,
      ...(request.cc?.length ? { cc: request.cc } : {}),
      ...(request.reply_to?.trim()
        ? { reply_to: request.reply_to.trim() }
        : {}),
    });

    // After the mail, and reported rather than thrown: the guide has already been delivered, so a
    // failed form is a follow-up item, not a reason to tell the operator the send failed. Awaited
    // rather than fired and forgotten, because the operator asked for it in this request and the
    // approval path's fire-and-forget is exactly how twelve of these failed unnoticed.
    let dcsForm: { submitted: boolean; error?: string } | undefined;
    const wantsDcsForm =
      request.submit_dcs_form ?? template.id === DCS_FORM_TEMPLATE_ID;
    if (wantsDcsForm) {
      if (!options.submitDcsForm) {
        dcsForm = {
          submitted: false,
          error: "the DCS form runner is not configured",
        };
      } else {
        const { firstName, lastName } = splitDisplayName(name);
        try {
          await options.submitDcsForm({ firstName, lastName, email });
          dcsForm = { submitted: true };
        } catch (error) {
          dcsForm = {
            submitted: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }

    return {
      ok: true,
      payload: {
        ...guide,
        ...html,
        sent: true,
        ...(driveLink ? { drive_folder_link: driveLink } : {}),
        ...(slackLink ? { slack_connect_link: slackLink } : {}),
        ...(projectInvites.length > 0
          ? { project_channel_invites: projectInvites }
          : {}),
        ...(activeChannelInvites
          ? { active_channel_invites: activeChannelInvites }
          : {}),
        ...(dcsForm ? { dcs_form: dcsForm } : {}),
      },
    };
  };
}
