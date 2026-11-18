// Scheduled member changes: a Member Type change that waits for its day.
//
// An admin agrees a grace period ("a week, then acquaintance") and records it here instead of in
// their head. The daily sweep makes the change with the same save the Edit member form makes, so
// channels, the Monday meeting and the calendar follow the new type exactly as they would by hand.
import type { AdminBotAuthSession } from "../../contracts/actions.js";
import type { AdminBotScheduledMemberChange } from "../../contracts/scheduled-member-changes.js";
import type { AdminBotMemberPrincipal } from "../../workflows/identity/auth.js";
import { sameMemberType } from "../../workflows/members/roster-sync.js";
import { readJsonOrEmpty, sendJson, sendServiceResult } from "../server.http.js";
import type { AdminBotRouteContext } from "./context.js";
import { adminSessionOnly, principalActor, privilegedOnly } from "./guards.js";
import { saveLabMemberAsAdmin } from "./members.js";
import { del, post, route, type Route } from "./router.js";

type SweepEntry = { id: string; member_id: string; member_type: string; detail: string };

/**
 * The admin who scheduled the change, as the principal the save runs under.
 *
 * The sweep arrives with the service token, which names nobody, and a Member Type change has to be
 * approved by a person. That person is whoever scheduled it -- but only while they are still an
 * admin: a decision made by somebody who has since lost the role is held for another admin to
 * re-make, not carried out on stale authority.
 */
function schedulerPrincipal(
  ctx: AdminBotRouteContext,
  change: AdminBotScheduledMemberChange,
): AdminBotMemberPrincipal | undefined {
  const admin = ctx.store.getLabMember(change.created_by);
  if (!admin || admin.privilege_level !== "admin") {
    return undefined;
  }
  // No session exists for a cron run. Nothing on the save path reads it; it is here because a
  // member principal has one, and an already-expired stand-in can never be mistaken for a login.
  const session: AdminBotAuthSession = {
    token_hash: "",
    member_id: admin.id,
    created_at: change.created_at,
    expires_at: change.created_at,
    last_seen_at: change.created_at,
  };
  return { kind: "member", member: admin, session };
}

function stepSummary(body: unknown): string {
  const steps = (
    body as { member_type_change?: { steps?: Array<{ step: string; status: string }> } } | null
  )?.member_type_change?.steps;
  return steps?.length
    ? steps.map((step) => `${step.step}: ${step.status}`).join("; ")
    : "member type saved";
}

export const scheduledMemberChangeRoutes: readonly Route[] = [
  // Admin sessions only: scheduling is deciding somebody's tier, so a person has to own it. The
  // sweep below is the one thing the service token may do, and it takes no input.
  route(
    ["GET", "POST"],
    "/lab/scheduled-member-changes",
    adminSessionOnly(async ({ req, res, url, ctx, principal }) => {
      const changes = ctx.service.scheduledMemberChanges();
      if (req.method === "GET") {
        sendServiceResult(res, changes.list(url.searchParams.get("status") ?? undefined));
        return;
      }
      sendServiceResult(res, changes.create(await readJsonOrEmpty(req), principalActor(principal)));
    }),
  ),
  // Called by the cron job (scripts/adminbot-scheduled-member-changes-cron.sh, daily).
  post(
    "/lab/scheduled-member-changes/run",
    privilegedOnly(async ({ res, ctx, principal }) => {
      const changes = ctx.service.scheduledMemberChanges();
      const actor = principalActor(principal);
      const done: SweepEntry[] = [];
      const failed: SweepEntry[] = [];
      const held: SweepEntry[] = [];
      for (const change of changes.due()) {
        const entry = {
          id: change.id,
          member_id: change.member_id,
          member_type: change.member_type,
        };
        const member = ctx.store.getLabMember(change.member_id);
        if (!member) {
          const detail = "the member record no longer exists";
          changes.settle(change, "failed", detail, actor);
          failed.push({ ...entry, detail });
          continue;
        }
        if (sameMemberType(member.member_type, change.member_type)) {
          const detail = "already this member type; nothing to change";
          changes.settle(change, "done", detail, actor);
          done.push({ ...entry, detail });
          continue;
        }
        const scheduler = schedulerPrincipal(ctx, change);
        if (!scheduler) {
          // Left pending: the next admin to look at the list can cancel and re-schedule it.
          held.push({ ...entry, detail: `${change.created_by} is no longer an admin` });
          continue;
        }
        // One at a time, settled as each lands: a sweep that dies halfway must not make the same
        // change (and send the same guide) twice on its next run. A change that fails is not
        // retried either -- it may have half applied, and that is for a person to look at.
        let detail: string;
        let ok = false;
        try {
          const saved = await saveLabMemberAsAdmin(ctx, scheduler, change.member_id, {
            member_type: change.member_type,
            silent: change.silent,
          });
          ok = saved.status < 400;
          detail = ok
            ? stepSummary(saved.body)
            : ((saved.body as { error?: { message?: string } } | null)?.error?.message ??
              `the save was refused (HTTP ${saved.status})`);
        } catch (error) {
          detail = error instanceof Error ? error.message : String(error);
        }
        changes.settle(change, ok ? "done" : "failed", detail, actor);
        (ok ? done : failed).push({ ...entry, detail });
      }
      sendJson(res, 200, { done, failed, held });
    }),
  ),
  // Cancelling keeps the row, as `cancelled`: "we were going to, and decided not to" is part of
  // the record of how somebody's tier was handled.
  del(
    /^\/lab\/scheduled-member-changes\/([^/]+)$/u,
    adminSessionOnly(({ res, ctx, principal, params }) => {
      sendServiceResult(
        res,
        ctx.service
          .scheduledMemberChanges()
          .cancel(decodeURIComponent(params[1]!), principalActor(principal)),
      );
    }),
  ),
];
