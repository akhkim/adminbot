import { randomUUID } from "node:crypto";
import type { AdminBotAuditEvent, AdminBotStoredProposal } from "../contracts/actions.js";
import {
  AdminBotService,
  type AdminBotActionExecutor,
  type AdminBotExecutorOutcome,
} from "../kernel/service.js";
import {
  adminBotLabCalendarId,
  ADMINBOT_LAB_EMAIL_ENV,
  type CalendarInviteRunner,
} from "../workflows/onboarding/calendar-invite.js";
import {
  createSlackConnectOnboardingInviter,
  type AdminBotOnboardingSender,
} from "../workflows/onboarding/guide-sender.js";
import { readInterviewInvitation } from "../workflows/onboarding/interview.js";
// What happens around an executed onboarding action: the guide email that goes with it and the
// lab calendar grant it implies. Wired into the executor by createAdminBotMockService.
//
// Cut from server.ts.

/**
 * Say once, at startup, that nobody will be granted calendar access.
 *
 * Silence here is what let this go unnoticed for four months: the invite is best-effort by design
 * -- an approval must not fail because Google did -- so an unconfigured deployment approved
 * members, failed the invite, wrote an audit row, and carried on looking healthy. Nothing read
 * those rows until somebody audited them, by which point 155 members had been told in their
 * onboarding checklist that they were already on the calendar.
 *
 * Skipped when a runner is injected: tests and the host supply their own, and it is not this
 * function's business whether that one is configured.
 */
export function warnIfLabCalendarUnconfigured(injected: unknown): void {
  if (injected || adminBotLabCalendarId()) {
    return;
  }
  console.warn(
    `[adminbot] ${ADMINBOT_LAB_EMAIL_ENV} is not set: no member will be granted lab calendar ` +
      "access, and every approval will record auth.calendar_invite_failed. Set it, then repair " +
      "the members already approved with POST /lab/members/backfill-calendar-invites.",
  );
}

/** Mints the #friends-and-collaborators Slack Connect invite on its own; see guide-sender.ts. */
export type SlackConnectOnboardingInviter = ReturnType<typeof createSlackConnectOnboardingInviter>;

/** What the `calendar.grant_lab_calendar` arm needs, resolved at execute time. */
export type LabCalendarGrant = {
  invite: CalendarInviteRunner;
  recordAudit: (event: Pick<AdminBotAuditEvent, "type" | "actor" | "details">) => void;
};

/**
 * The executor arms for `onboarding.send_guide` and `calendar.grant_lab_calendar`.
 *
 * Wraps whatever connector the launcher injected and answers this one type in-process, because the
 * work is not a CLI call: the sender mints a Slack Connect invite, provisions the Drive folder,
 * invites the project channels and files the DCS roster row before the mail goes out. Everything else
 * falls through untouched.
 *
 * `handled: false` when no sender is configured, which is what the service turns into an audited
 * execution failure -- the same answer it gives for any action no connector claimed. Silently
 * reporting success would mark a guide sent that nobody received.
 */
export function executorWithOnboardingGuide(
  serviceRef: () => AdminBotService,
  inner: AdminBotActionExecutor | undefined,
  sender: () => AdminBotOnboardingSender | undefined,
  labCalendar: () => LabCalendarGrant | undefined,
  slackConnect: () => SlackConnectOnboardingInviter | undefined,
  enroll: () =>
    | ((proposal: AdminBotStoredProposal) => Promise<AdminBotExecutorOutcome>)
    | undefined,
): AdminBotActionExecutor {
  return {
    async execute(proposal) {
      const service = serviceRef();
      if (proposal.type === "lab_member.enroll") {
        const run = enroll();
        return run ? run(proposal) : { handled: false, reason: "enrollment is not wired" };
      }
      if (proposal.type === "calendar.grant_lab_calendar") {
        return grantLabCalendar(proposal, labCalendar());
      }
      if (proposal.type === "slack.connect_invite") {
        const invite = slackConnect();
        if (!invite) {
          return { handled: false, reason: "no Slack Connect inviter is configured" };
        }
        const payload = (proposal.proposed_payload ?? {}) as Record<string, unknown>;
        const result = await invite(typeof payload.email === "string" ? payload.email : "");
        return result.ok
          ? {
              handled: true,
              delivered: true,
              artifacts: { channel_id: result.channel_id, reused: String(result.reused) },
            }
          : { handled: true, delivered: false, reason: result.reason };
      }
      if (proposal.type !== "onboarding.send_guide") {
        return inner ? inner.execute(proposal) : { handled: false };
      }
      const send = sender();
      if (!send) {
        return { handled: false, reason: "no onboarding sender is configured" };
      }
      const payload = (proposal.proposed_payload ?? {}) as Record<string, unknown>;
      const templateId = typeof payload.template_id === "string" ? payload.template_id : "";
      const name = typeof payload.name === "string" ? payload.name : "";
      const email = typeof payload.email === "string" ? payload.email : "";
      if (!templateId || !email) {
        return { handled: false, reason: "template_id and email are required" };
      }
      const result = await send({
        template_id: templateId,
        name,
        email,
        ...(payload.interview ? { interview: readInterviewInvitation(payload.interview) } : {}),
        ...(Array.isArray(payload.cc)
          ? { cc: payload.cc.filter((value): value is string => typeof value === "string") }
          : {}),
        ...(typeof payload.reply_to === "string" ? { reply_to: payload.reply_to } : {}),
        ...(typeof payload.body_override === "string"
          ? { body_override: payload.body_override }
          : {}),
        ...(typeof payload.subject_override === "string"
          ? { subject_override: payload.subject_override }
          : {}),
        ...(payload.values && typeof payload.values === "object"
          ? { values: payload.values as Record<string, string | undefined> }
          : {}),
        ...(typeof payload.add_dcs_roster_row === "boolean"
          ? { add_dcs_roster_row: payload.add_dcs_roster_row }
          : {}),
        // The project channels an admin picked on the Members tab. Dropping them here is how
        // every approved guide used to go out with no #proj-xxx invite at all.
        ...(Array.isArray(payload.slack_project_channels)
          ? {
              slack_project_channels: payload.slack_project_channels.filter(
                (channel): channel is string => typeof channel === "string",
              ),
            }
          : {}),
      });
      if (!result.ok) {
        // Refused rather than thrown: an unfilled placeholder or a missing value is a fixable
        // state, and the reason is what an admin needs to see on the failed approval.
        return { handled: true, delivered: false, reason: result.error.message };
      }
      if (payload.interview && result.payload.sent) {
        const existing = service.listLabMembers();
        if (
          existing.ok &&
          !existing.payload.members.some(
            (member) => member.email?.toLowerCase() === email.toLowerCase(),
          )
        ) {
          const saved = service.upsertLabMember({
            id: `interview-${randomUUID()}`,
            name,
            email,
            member_type: "interviewee",
            collaborator_subgroup: "interviewee",
            privilege_level: "external_collaborator",
          });
          if (!saved.ok) {
            return {
              handled: true,
              delivered: true,
              artifacts: {
                template_id: result.payload.template_id,
                subject: result.payload.subject,
                warning: `Invitation sent; candidate record needs attention: ${saved.error.message}`,
              },
            };
          }
        }
      }
      return {
        handled: true,
        delivered: true,
        artifacts: { template_id: result.payload.template_id, subject: result.payload.subject },
      };
    },
  };
}

/**
 * Read access to the lab calendar, as an approved action.
 *
 * Audited as `auth.calendar_invite_sent` / `_failed`, the rows the calendar backfill keys on, so a
 * member granted here is not granted again by the backfill and a failure is visible to it.
 */
export async function grantLabCalendar(
  proposal: AdminBotStoredProposal,
  grant: LabCalendarGrant | undefined,
): Promise<AdminBotExecutorOutcome> {
  if (!grant) {
    return { handled: false, reason: "no lab calendar invite runner is configured" };
  }
  const payload = (proposal.proposed_payload ?? {}) as Record<string, unknown>;
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  const memberId = typeof payload.member_id === "string" ? payload.member_id : undefined;
  if (!email) {
    return { handled: false, reason: "email is required" };
  }
  const actor = proposal.approvals.at(-1)?.approver_id ?? "adminbot";
  try {
    await grant.invite(email);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    grant.recordAudit({
      type: "auth.calendar_invite_failed",
      actor,
      details: { ...(memberId ? { member_id: memberId } : {}), email, error: message },
    });
    return { handled: true, delivered: false, reason: message };
  }
  grant.recordAudit({
    type: "auth.calendar_invite_sent",
    actor,
    details: { ...(memberId ? { member_id: memberId } : {}), email },
  });
  return { handled: true, delivered: true, artifacts: { email } };
}
