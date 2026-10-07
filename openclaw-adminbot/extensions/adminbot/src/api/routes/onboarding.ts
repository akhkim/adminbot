import { randomUUID } from "node:crypto";
// Onboarding guides, the membership sheet, interviews, and onboarding sweeps.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.
import type { AdminBotMemberNudgeChannel } from "../../contracts/actions.js";
import { ADMINBOT_ALUMNI_SLACK_CONNECT_TEMPLATE_ID } from "../../contracts/paper-cycle.js";
import type { AdminBotOnboardingSendRequest } from "../../workflows/onboarding/guide-sender.js";
import { memberGuideStatus } from "../../workflows/onboarding/guide-status.js";
import { describeMemberSheetReadFailure } from "../member-sheet-config.js";
import {
  readJson,
  readJsonOrEmpty,
  readRecord,
  sendJson,
  sendServiceResult,
} from "../server.http.js";
import { prepareInterviewInvitation } from "../server.interview-invitation.js";
import {
  type NewMemberOnboardingDeps,
  onboardNewMember,
  queueNewMemberGuide,
} from "../server.member-onboarding.js";
import {
  addMemberSheetRow,
  type MemberSheetAddRowRequest,
  type MemberSheetEditRequest,
  type MemberSheetOnboardRequest,
  onboardFromMemberSheet,
  previewOnboardFromMemberSheet,
  proposeMemberSheetEdits,
  readMemberSheet,
  readRosterSheet,
} from "../server.member-sheet.js";
import type { AdminBotPrincipal, AdminBotRouteContext } from "./context.js";
import {
  adminSessionOnly,
  approverIdentityFor,
  principalActor,
  privilegedOnly,
  requirePrivileged,
} from "./guards.js";
import { readGroupMeetingSeries } from "./meetings.js";
import { get, post, route, type Route } from "./router.js";

export const onboardingRoutes: readonly Route[] = [
  // Onboarding for one member of the roster, which is what the Members tab's Add-member button
  // runs after it has created the record. Matched before `onboardingStep` below, whose pattern
  // would otherwise read "guide" as the id of a checklist step (there is no such step, so it would
  // 404 rather than do this).
  //
  // Admin member session only, for the same reason /onboarding/guide is: approving what this
  // queues mints a Slack Connect invite and mails a stranger. The shared service principal
  // authenticates every agent tool call regardless of who is chatting, so accepting it here
  // would let anyone talking to AdminBot put an onboarding mail in the approval queue.
  get(/^\/lab\/members\/([^/]+)\/onboarding\/guide$/u, ({ res, ctx, principal, params }) => {
    if (principal.kind !== "member" || principal.member.privilege_level !== "admin") {
      sendJson(res, 403, { error: { message: "An admin member session is required." } });
      return;
    }
    const member = ctx.store.getLabMember(decodeURIComponent(params[1]));
    if (!member) {
      sendJson(res, 404, { error: { message: "Member not found." } });
      return;
    }
    sendJson(
      res,
      200,
      memberGuideStatus(
        member,
        ctx.store.listAuditEvents(),
        ctx.store.listProposalsByType("onboarding.send_guide"),
      ),
    );
  }),
  post(
    /^\/lab\/members\/([^/]+)\/onboarding\/guide$/u,
    adminSessionOnly(async ({ req, res, ctx, principal, params }) => {
      const body = readRecord(await readJsonOrEmpty(req));
      if (
        body.slack_project_channels !== undefined &&
        (!Array.isArray(body.slack_project_channels) ||
          body.slack_project_channels.length > 20 ||
          body.slack_project_channels.some(
            (channel) => typeof channel !== "string" || !channel.trim() || channel.length > 128,
          ))
      ) {
        sendJson(res, 400, { error: { message: "Use up to 20 Slack channel names or IDs." } });
        return;
      }
      const guide = await queueNewMemberGuide(
        memberOnboardingDeps(ctx, principal, approverIdentityFor(principal)),
        decodeURIComponent(params[1]),
        { slackChannels: body.slack_project_channels as string[] | undefined },
      );
      if (guide.status === "failed" || guide.status === "skipped") {
        sendJson(res, guide.status === "skipped" ? 422 : (guide.http_status ?? 502), {
          error: { message: guide.reason },
        });
        return;
      }
      sendJson(res, 200, {
        proposal_id: guide.proposal_id,
        template_id: guide.template_id,
        email: guide.email,
        status: guide.status,
        detail: guide.detail,
      });
    }),
  ),
  post(
    /^\/lab\/members\/([^/]+)\/onboarding\/([^/]+)$/u,
    async ({ req, res, principal, ctx, params }) => {
      const { service } = ctx;
      const memberId = decodeURIComponent(params[1]);
      // Members tick off their own checklist; admins can correct anyone's. The service principal
      // is allowed so the agent can mark a step done when it observes the work (e.g. it just sent
      // the calendar invite) -- this is roster bookkeeping, not an outbound action. An anonymous
      // caller never reaches here: this route is not in ANONYMOUS_ROUTES.
      if (principal.kind === "member" && principal.member.id !== memberId) {
        if (!requirePrivileged(res, principal)) {
          return;
        }
      }
      const body = (await readJson(req)) as { complete?: boolean };
      sendServiceResult(
        res,
        service.setOnboardingStep(
          memberId,
          decodeURIComponent(params[2]),
          body.complete !== false,
          principalActor(principal),
        ),
      );
    },
  ),
  get(
    /^\/onboarding\/([^/]+)\/pending$/u,
    privilegedOnly(({ res, params, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, service.listOnboardingStepPending(decodeURIComponent(params[1])));
    }),
  ),
  // The Membership tab's grid over the lab's own member spreadsheet. Admin-only to read: the
  // roster carries every member's address and the lab's notes about them.
  route(
    ["GET", "POST"],
    "/membership/sheet",
    adminSessionOnly(async ({ req, res, ctx, principal }) => {
      const { service } = ctx;
      if (!ctx.memberSheet) {
        sendJson(res, 503, {
          error: {
            message:
              "this deployment has no member spreadsheet configured; set ADMINBOT_MEMBER_SHEET_ID",
          },
        });
        return;
      }
      if (req.method === "GET") {
        try {
          sendJson(res, 200, await readMemberSheet(ctx.memberSheet));
        } catch (error) {
          sendJson(res, 502, {
            error: { message: describeMemberSheetReadFailure(error, ctx.memberSheet) },
          });
        }
        return;
      }
      const editBody = (await readJson(req)) as MemberSheetEditRequest;
      let editResult;
      try {
        editResult = await proposeMemberSheetEdits(
          service,
          ctx.memberSheet,
          editBody,
          principalActor(principal),
        );
      } catch (error) {
        sendJson(res, 502, {
          error: { message: describeMemberSheetReadFailure(error, ctx.memberSheet) },
        });
        return;
      }
      if ("error" in editResult) {
        sendJson(res, editResult.error.status, { error: { message: editResult.error.message } });
        return;
      }
      sendJson(res, 200, editResult);
    }),
  ),
  post(
    "/membership/sheet/onboard/preview",
    adminSessionOnly(async ({ req, res, ctx }) => {
      if (!ctx.memberSheet) {
        sendJson(res, 503, {
          error: {
            message:
              "this deployment has no member spreadsheet configured; set ADMINBOT_MEMBER_SHEET_ID",
          },
        });
        return;
      }
      const previewBody = (await readJson(req)) as MemberSheetOnboardRequest;
      let previewResult;
      try {
        previewResult = await previewOnboardFromMemberSheet(ctx.memberSheet, previewBody);
      } catch (error) {
        sendJson(res, 502, {
          error: { message: describeMemberSheetReadFailure(error, ctx.memberSheet) },
        });
        return;
      }
      if ("error" in previewResult) {
        sendJson(res, previewResult.error.status, {
          error: { message: previewResult.error.message },
        });
        return;
      }
      sendJson(res, 200, previewResult);
    }),
  ),
  post(
    "/membership/sheet/onboard",
    adminSessionOnly(async ({ req, res, ctx, principal }) => {
      const { service } = ctx;
      if (!ctx.memberSheet) {
        sendJson(res, 503, {
          error: {
            message:
              "this deployment has no member spreadsheet configured; set ADMINBOT_MEMBER_SHEET_ID",
          },
        });
        return;
      }
      const onboardBody = (await readJson(req)) as MemberSheetOnboardRequest;
      let onboardResult;
      try {
        // The admin's click approves enrollment, as on the Members tab, and the standard full-member
        // guide with it; guides for other Member Types still wait in Pending Actions.
        const onboardDeps = memberOnboardingDeps(ctx, principal, approverIdentityFor(principal));
        onboardResult = await onboardFromMemberSheet(service, ctx.memberSheet, onboardBody, {
          enroll: (input) =>
            onboardNewMember(onboardDeps, input, {
              origin: { source: "admin", actor: principalActor(principal) },
              guide: "none",
              skipSheet: "the row is already on the sheet",
            }),
          queueGuide: (memberId, options) => queueNewMemberGuide(onboardDeps, memberId, options),
        });
      } catch (error) {
        sendJson(res, 502, {
          error: { message: describeMemberSheetReadFailure(error, ctx.memberSheet) },
        });
        return;
      }
      if ("error" in onboardResult) {
        sendJson(res, onboardResult.error.status, {
          error: { message: onboardResult.error.message },
        });
        return;
      }
      sendJson(res, 200, onboardResult);
    }),
  ),
  post(
    "/membership/sheet/rows",
    adminSessionOnly(async ({ req, res, ctx, principal }) => {
      const { service } = ctx;
      const approver = approverIdentityFor(principal);
      if (!approver) {
        sendJson(res, 403, { error: { message: "Add row needs a signed-in admin" } });
        return;
      }
      if (!ctx.memberSheet) {
        sendJson(res, 503, {
          error: {
            message:
              "this deployment has no member spreadsheet configured; set ADMINBOT_MEMBER_SHEET_ID",
          },
        });
        return;
      }
      const addBody = readRecord(await readJson(req)) as MemberSheetAddRowRequest;
      let addResult;
      try {
        addResult = await addMemberSheetRow(
          service,
          ctx.memberSheet,
          addBody,
          approver,
          principalActor(principal),
          (input) =>
            onboardNewMember(memberOnboardingDeps(ctx, principal, approver), input, {
              origin: { source: "admin", actor: principalActor(principal) },
              guide: "send",
              skipSheet: "the row was just added to the sheet",
            }),
        );
      } catch (error) {
        sendJson(res, 502, {
          error: { message: describeMemberSheetReadFailure(error, ctx.memberSheet) },
        });
        return;
      }
      if ("error" in addResult) {
        sendJson(res, addResult.error.status, { error: { message: addResult.error.message } });
        return;
      }
      sendJson(res, 200, addResult);
    }),
  ),
  // The nightly reconciliation of the roster against the lab's spreadsheet.
  //
  // `requirePrivileged` rather than `requireMemberPrivileged`, like the other cron-triggered
  // sweeps: nothing is caller-supplied. The sheet is read here, the diff is computed from it and
  // the store, and the only external effects are proposals an admin still has to approve.
  //
  // `force` is the exception and takes a real admin session. It skips the guard that stops a
  // truncated read from rewriting the roster, which is a judgement about a spreadsheet somebody has
  // looked at -- not something a cron job can assert on its own.
  post(
    "/onboarding/sheet-sweep/run",
    privilegedOnly(async ({ req, res, ctx, principal }) => {
      const { service } = ctx;
      if (!ctx.memberSheet) {
        sendJson(res, 503, {
          error: {
            message:
              "this deployment has no member spreadsheet configured; set ADMINBOT_MEMBER_SHEET_ID",
          },
        });
        return;
      }
      const sweepBody = readRecord(await readJsonOrEmpty(req));
      let sweepSheet;
      try {
        sweepSheet = await readRosterSheet(ctx.memberSheet);
      } catch (error) {
        sendJson(res, 502, {
          error: { message: describeMemberSheetReadFailure(error, ctx.memberSheet) },
        });
        return;
      }
      if ("error" in sweepSheet) {
        sendJson(res, sweepSheet.error.status, { error: { message: sweepSheet.error.message } });
        return;
      }
      const swept = service.sweepOnboardingMail({
        sheet: sweepSheet.parsed,
        actor: principalActor(principal),
        dryRun: sweepBody.dry_run === true,
      });
      if (!swept.ok || sweepBody.dry_run === true) {
        sendServiceResult(res, swept);
        return;
      }
      // The sweep created them at the least-privileged level. Enrolling them -- the level their
      // Member Type implies and everything it grants -- waits for an admin, beside their guide.
      const enrollments: Array<{ member_id: string; proposal_id?: string; error?: string }> = [];
      for (const memberId of swept.payload.created) {
        const member = ctx.store.getLabMember(memberId);
        if (!member) {
          continue;
        }
        const filed = service.createProposal({
          type: "lab_member.enroll",
          summary: `Enroll ${member.name || member.id} as ${member.member_type || "no Member Type"}: their access level and what it grants -- joined on the member sheet`,
          target: { service: "adminbot", channel: "roster", target: member.id },
          proposed_payload: { member_id: member.id, member_type: member.member_type ?? "" },
          undo_plan: "Change their Member Type on the Members tab; that re-applies their access.",
        });
        enrollments.push(
          filed.ok
            ? { member_id: memberId, proposal_id: filed.payload.id }
            : { member_id: memberId, error: filed.error.message },
        );
      }
      sendJson(res, swept.status, { ...swept.payload, enrollments });
    }),
  ),
  get("/onboarding/interviewers", ({ res, url, ctx, principal }) => {
    if (
      principal.kind !== "member" ||
      !["member", "admin"].includes(principal.member.privilege_level)
    ) {
      sendJson(res, 403, { error: { message: "A lab member session is required." } });
      return;
    }
    const query = (url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 100);
    sendJson(res, 200, {
      members: ctx.store
        .listLabMembers()
        .filter(
          (member) =>
            member.slack_user_id &&
            ["member", "admin"].includes(member.privilege_level) &&
            (!query || member.name.toLowerCase().includes(query)),
        )
        .slice(0, 50)
        .map((member) => ({
          id: member.id,
          name: member.name,
          slack_user_id: member.slack_user_id,
          privilege_level: member.privilege_level,
        })),
    });
  }),
  post("/onboarding/interview-invitation", async ({ req, res, ctx, principal }) => {
    const { service } = ctx;
    if (
      principal.kind !== "member" ||
      !["member", "admin"].includes(principal.member.privilege_level)
    ) {
      sendJson(res, 403, { error: { message: "A lab member session is required." } });
      return;
    }
    sendServiceResult(
      res,
      await prepareInterviewInvitation(
        service,
        readRecord(await readJsonOrEmpty(req)),
        principal.member,
        ctx.onboardingSender,
        () => ctx.store.listProposalsByType("onboarding.send_guide"),
      ),
    );
  }),
  post(
    "/onboarding/guide",
    adminSessionOnly(async ({ req, res, ctx, principal }) => {
      const { service } = ctx;
      const body = (await readJson(req)) as AdminBotOnboardingSendRequest;
      const result = await ctx.onboardingSender(body);
      if (!result.ok) {
        sendJson(res, result.error.status, {
          error: {
            message: result.error.message,
            ...(result.error.missing ? { missing: result.error.missing } : {}),
          },
        });
        return;
      }
      service.recordOnboardingGuideSent({
        actor: principalActor(principal),
        template_id: result.payload.template_id,
        email: body.email,
        sent: result.payload.sent,
      });
      // The DCS request moved here from registration approval, and its audit trail moves with it:
      // the row is acted on by someone else's sysadmin, so the only record on this side that it was
      // ever asked for is this one. The username is recorded because it is what a later question
      // ("which account did we ask for?") is about; the password it was filed with is not, here or
      // anywhere else AdminBot writes.
      if (result.payload.dcs_roster_row) {
        const row = result.payload.dcs_roster_row;
        service.recordDcsRosterRowAttempt({
          actor: principalActor(principal),
          template_id: result.payload.template_id,
          email: body.email,
          added: row.added,
          ...(row.username ? { username: row.username } : {}),
          ...(row.error ? { error: row.error } : {}),
        });
      }
      sendJson(res, 200, result.payload);
    }),
  ),
  post(
    /^\/onboarding\/([^/]+)\/nudge$/u,
    adminSessionOnly(async ({ req, res, principal, ctx, params }) => {
      const { service } = ctx;
      const body = (await readJson(req)) as {
        channel?: AdminBotMemberNudgeChannel;
        message?: string;
      };
      sendServiceResult(
        res,
        await service.nudgeOnboardingStep(
          {
            step_id: decodeURIComponent(params[1]),
            channel: body.channel ?? "slack",
            ...(body.message ? { message: body.message } : {}),
          },
          principalActor(principal),
        ),
      );
    }),
  ),
  post(
    "/onboarding/chase/run",
    privilegedOnly(async ({ res, principal, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, await service.chaseOpenOnboarding(principalActor(principal)));
    }),
  ),
  post(
    "/onboarding/alumni-slack-invites/run",
    privilegedOnly(async ({ res, ctx, principal }) => {
      const { service } = ctx;
      const due = service.dueAlumniSlackInvites();
      const sent: Array<{ member_id: string; email: string }> = [];
      const skipped: Array<{ member_id: string; reason: string }> = [];
      for (const alumnus of due) {
        // One at a time, and the ledger is stamped per success rather than at the end: a sweep that
        // dies halfway must not re-invite everyone it already reached on its next run.
        const result = await ctx.onboardingSender({
          template_id: ADMINBOT_ALUMNI_SLACK_CONNECT_TEMPLATE_ID,
          name: alumnus.name,
          email: alumnus.email,
        });
        if (!result.ok) {
          skipped.push({ member_id: alumnus.member_id, reason: result.error.message });
          continue;
        }
        service.markAlumniSlackInviteSent(alumnus.member_id);
        sent.push({ member_id: alumnus.member_id, email: alumnus.email });
      }
      service.recordAlumniSlackInviteSweep({
        actor: principalActor(principal),
        sent: sent.length,
        skipped: skipped.length,
      });
      sendJson(res, 200, { sent, skipped });
    }),
  ),
];

/** What the shared onboarding steps need from a request, approved by `approver` when given. */
export function memberOnboardingDeps(
  ctx: AdminBotRouteContext,
  principal: AdminBotPrincipal,
  approver: { approver_role: string; approver_id: string } | undefined,
): NewMemberOnboardingDeps {
  return {
    ...memberEnrollmentContext(ctx),
    ...(approver ? { approver } : {}),
    actor: principalActor(principal),
  };
}

/** The parts of the onboarding deps that come from the deployment rather than the request. */
export function memberEnrollmentContext(
  ctx: AdminBotRouteContext,
): Omit<NewMemberOnboardingDeps, "approver" | "actor"> {
  return {
    service: ctx.service,
    ...(ctx.memberSheet ? { memberSheet: ctx.memberSheet } : {}),
    readGroupMeeting: () => readGroupMeetingSeries(ctx, ctx.labCalendar.id),
    recordAudit: (event) =>
      ctx.store.recordAudit({
        id: `aud_${randomUUID()}`,
        timestamp: new Date().toISOString(),
        ...event,
      }),
  };
}
