// The lab roster: listing, editing, merging, and requests to add somebody.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type AdminBotLabMemberInput,
  redactConfidentialMemberFields,
} from "../../contracts/actions.js";
import { ADMIN_LIST_PAGE_SIZE, pageOf, readAdminListPage } from "../../contracts/list-page.js";
import {
  type AdminBotMemberRequestStatus,
  adminBotMemberRequestStatuses,
} from "../../contracts/member-requests.js";
import { memberAttends } from "../../workflows/calendar/standing-meetings.js";
import type { AdminBotMemberPrincipal } from "../../workflows/identity/auth.js";
import type { AdminBotWriteOrigin } from "../../workflows/members/adoption.js";
import { privilegeForMemberTypeChange } from "../../workflows/members/member-type-access.js";
import {
  deskAdoption,
  filterOverviewRows,
  type ProfileReminderInclude,
  readProfileOverviewFilter,
  remindScopeFor,
} from "../../workflows/members/profile-overview-filter.js";
import { profileOverviewWireRow } from "../../workflows/members/profile-overview-row.js";
import { sameMemberType } from "../../workflows/members/roster-sync.js";
import { isTravelHistorySubject } from "../../workflows/members/travel-history.js";
import { newMemberIdentity } from "../member-create.js";
import { describeMemberSheetReadFailure } from "../member-sheet-config.js";
import {
  asString,
  readJson,
  readJsonOrEmpty,
  readRecord,
  sendJson,
  sendServiceResult,
} from "../server.http.js";
import { enrollNewMember } from "../server.member-onboarding.js";
import { readRosterSheet } from "../server.member-sheet.js";
import { applyMeetingSelection, applyMemberTypeChange } from "../server.member-type-change.js";
import type { AdminBotRouteContext } from "./context.js";
import {
  adminSessionOnly,
  approverIdentityFor,
  memberOnly,
  principalActor,
  privilegedOnly,
  requireMemberPrivileged,
  requirePrivileged,
} from "./guards.js";
import { readStandingMeetings } from "./meetings.js";
import { memberViewEtag } from "./members-etag.js";
import { memberOnboardingDeps } from "./onboarding.js";
import { readListPage, limitParam } from "./query-params.js";
import { del, get, post, put, route, type Route, under } from "./router.js";
import { requestIsSecure, sendAuthResult } from "./session.js";
import { sendNotModified } from "./version-etag.js";

export const membersRoutes: readonly Route[] = [
  // Member requests: anyone signed in may propose adding somebody; only an admin decides. Ahead of
  // every /lab/members/:id pattern so "requests" is never read as a member id. A member session
  // throughout -- the service principal speaks for whoever is chatting, so it can neither file a
  // request in a real member's name nor approve one.
  route(
    "*",
    under("/lab/members/requests"),
    memberOnly(
      async ({ req, res, url, ctx, principal }) => {
        await handleMemberRequestRoute(req, res, ctx, url, principal);
      },
      { status: 403, message: "member session required" },
    ),
  ),
  get(
    "/lab/members/collaborator-schedules",
    memberOnly(
      ({ res, principal, ctx }) => {
        const { service } = ctx;
        sendServiceResult(res, service.listActiveCollaboratorSchedules(principal.member.id));
      },
      { status: 403, message: "member session required" },
    ),
  ),
  get("/lab/members", ({ res, url, principal, ctx }) => {
    const { service } = ctx;
    // The roster is lab-internal but not confidential, with two exceptions. What a member discloses
    // about their health or family is written for one reader, and this response goes to all of
    // them; the service principal drives agent tool calls on behalf of whoever is chatting, so it
    // is not entitled to that either. The schedule fields are the second exception, and a narrower
    // one: they are stripped for member sessions that are neither the member nor an admin, while
    // the service principal keeps them so the importer and the scheduling tools still work.
    const viewer = {
      ...(principal.kind === "member" ? { memberId: principal.member.id } : {}),
      isAdmin: principal.kind === "member" && principal.member.privilege_level === "admin",
      isMemberSession: principal.kind === "member",
    };
    const view = url.searchParams.get("view");
    if (view !== null && view !== "summary") {
      sendJson(res, 400, { error: { message: "invalid member view" } });
      return;
    }
    const page = readListPage(url);
    if (page === "invalid") {
      sendJson(res, 400, { error: { message: "invalid list pagination or search" } });
      return;
    }
    if (view === "summary") {
      if (page) {
        sendJson(res, 400, { error: { message: "summary view cannot be paginated" } });
        return;
      }
      const etag = memberViewEtag(ctx.store, principal, "lab-members", { view });
      if (etag && sendNotModified(res, etag)) {
        return;
      }
      const result = service.listLabMemberSummaries(
        principal.kind === "member" ? principal.member.id : undefined,
      );
      sendServiceResult(
        res,
        result.ok
          ? {
              ...result,
              payload: {
                members: result.payload.members.map((member) =>
                  redactConfidentialMemberFields(member, viewer),
                ),
                ...(result.payload.self
                  ? { self: redactConfidentialMemberFields(result.payload.self, viewer) }
                  : {}),
              },
            }
          : result,
        { etag },
      );
      return;
    }
    const etag = memberViewEtag(ctx.store, principal, "lab-members", { page });
    if (etag && sendNotModified(res, etag)) {
      return;
    }
    // A page carries the card projection; the unpaged read stays full for the agent tools.
    const result = service.listLabMembers(page);
    sendServiceResult(
      res,
      result.ok
        ? {
            ...result,
            payload: {
              ...result.payload,
              members: result.payload.members.map((member) =>
                redactConfidentialMemberFields(member, viewer),
              ),
            },
          }
        : result,
      { etag },
    );
  }),
  get(
    "/lab/members/duplicates",
    privilegedOnly(({ res, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, service.listDuplicateMembers());
    }),
  ),
  get(/^\/lab\/members\/([^/]+)\/recent-edits$/u, ({ res, url, principal, ctx, params }) => {
    const { service } = ctx;
    const memberId = decodeURIComponent(params[1]!);
    // Your own record, or an admin's read of anyone's. A member seeing who has been in their
    // profile is the point of putting this on the profile page -- after "view as" landed, an
    // admin editing it is a thing that happens and the member should be able to see it.
    const isSelf = principal.kind === "member" && principal.member.id === memberId;
    if (!isSelf && !requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(res, service.listRecentUpdatesForMember(memberId, limitParam(url)));
  }),
  get(/^\/lab\/members\/([^/]+)\/travel$/u, ({ res, url, principal, ctx, params }) => {
    const { service } = ctx;
    const memberId = decodeURIComponent(params[1]!);
    // Your own, and only if you are the one member the lab keeps a travel history for. This is the
    // most sensitive read in the service, so it is narrower than every other member route: not
    // "self or an admin" but "self, and the head professor". An admin reading somebody else's
    // movements is the thing this feature must not become, and it was asked for so one person could
    // track her own trips -- so that is exactly what it serves and no more.
    //
    // A 404 rather than a 403: to anyone who is not the subject this route does not exist, which is
    // also true of the data behind it, since nobody else's sign-ins are stamped with a place
    // (isTravelHistorySubject, and the write side in workflows/identity/auth.ts).
    const isSelf = principal.kind === "member" && principal.member.id === memberId;
    // Unwrapped explicitly so a settings read that somehow failed denies rather than defaults: an
    // unreadable configuration is not a reason to widen the one route that must never widen.
    const settings = service.getSettings();
    const subject = isTravelHistorySubject(memberId, settings.ok ? settings.payload : undefined);
    if (!isSelf || !subject) {
      sendJson(res, 404, { error: { message: "no travel history for this member" } });
      return;
    }
    sendServiceResult(
      res,
      service.buildMemberTravelHistory(memberId, {
        ...(url.searchParams.get("from") ? { fromIso: url.searchParams.get("from")! } : {}),
        ...(url.searchParams.get("to") ? { toIso: url.searchParams.get("to")! } : {}),
      }),
    );
  }),
  post("/lab/members/backfill-calendar-invites", async ({ req, res, ctx, principal }) => {
    // requireMemberPrivileged for the same reason /lab/members/merge is: a run mails real people,
    // and the service principal drives every agent tool call. `dry_run` defaults to true in the
    // auth service, so a caller who sends nothing gets the plan rather than the sends.
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const body = readRecord(await readJson(req));
    sendAuthResult(
      res,
      await ctx.auth.backfillLabCalendarInvites({
        actorId: principalActor(principal),
        ...(body.dry_run === false ? { dryRun: false } : {}),
        ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
      }),
      requestIsSecure(req, ctx.trustProxyHeaders),
    );
  }),
  post("/lab/members/merge", async ({ req, res, principal, ctx }) => {
    const { service } = ctx;
    // requireMemberPrivileged, not requirePrivileged: a merge retires a person's record, moves
    // their login and cannot be undone from the UI, and the caller names both ids -- so it is
    // exactly the kind of admin-composed write the service principal is kept out of. The same
    // reasoning as /papers/slot-reminder/run.
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.mergeLabMembers({
        survivorId: asString(body.survivor_id),
        duplicateId: asString(body.duplicate_id),
        actorId: principal.member.id,
      }),
    );
  }),
  get("/lab/members/without-email", ({ res, principal, ctx }) => {
    const { service } = ctx;
    // The preview behind the purge, and admin-only for the same reason the profile overview is:
    // it is everybody's contactability at once, which is a governance read rather than a member
    // answering "can the lab reach me".
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    sendServiceResult(res, service.listMembersWithoutEmail(principal.member.id));
  }),
  post("/lab/members/without-email/purge", async ({ req, res, principal, ctx }) => {
    const { service } = ctx;
    // Deletes people, so it takes a genuine admin member session and never the shared service
    // principal -- the same line the merge draws, for a stronger reason: a merge keeps the history
    // under the survivor and this keeps nothing. There is deliberately no cron caller.
    //
    // `dry_run` defaults to true in the service, so a body-less POST previews rather than deletes:
    // the destructive reading of an ambiguous request is the wrong default.
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const body = readRecord(await readJsonOrEmpty(req));
    sendServiceResult(
      res,
      service.deleteMembersWithoutEmail({
        actorId: principal.member.id,
        dryRun: body?.dry_run !== false,
      }),
    );
  }),
  del(/^\/lab\/members\/([^/]+)$/u, async ({ req, res, principal, ctx, params }) => {
    const { service } = ctx;
    // Same gate as the merge, and the id comes from the path rather than a body so a mistyped
    // request 404s instead of deleting somebody adjacent.
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const body = readRecord(await readJsonOrEmpty(req));
    sendServiceResult(
      res,
      service.deleteLabMember({
        memberId: decodeURIComponent(params[1]),
        actorId: principal.member.id,
        force: body?.force === true,
      }),
    );
  }),
  get(/^\/lab\/members\/([^/]+)\/locations$/u, ({ res, url, principal, ctx, params }) => {
    const { service } = ctx;
    const memberId = decodeURIComponent(params[1]);
    // Your own timeline, or an admin's. Where a colleague has been for the last six months is not
    // roster data — it is a movement history, and it stays with them and the people who schedule.
    const isSelf = principal.kind === "member" && principal.member.id === memberId;
    if (!isSelf && !requirePrivileged(res, principal)) {
      return;
    }
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit ? Number(rawLimit) : undefined;
    sendServiceResult(
      res,
      service.listMemberLocations(memberId, Number.isFinite(limit) ? limit : undefined),
    );
  }),
  post("/lab/members", async ({ req, res, ctx, principal }) => {
    if (principal.kind !== "member" || principal.member.privilege_level !== "admin") {
      sendJson(res, 403, { error: { message: "An admin member session is required." } });
      return;
    }
    const body = readRecord(await readJson(req));
    const identity = newMemberIdentity(body, ctx.store.listLabMembers());
    if (identity.error) {
      sendJson(res, 409, { error: { message: identity.error } });
      return;
    }
    const saved = await saveLabMemberAsAdmin(ctx, principal, identity.id!, body);
    sendJson(res, saved.status, saved.body);
  }),
  put(/^\/lab\/members\/([^/]+)$/u, async ({ req, res, ctx, principal, params }) => {
    const { service } = ctx;
    const memberId = decodeURIComponent(params[1]);
    const body = readRecord(await readJson(req));
    // Only a genuine admin *member* session (the Control UI's own Bearer) gets the full governance
    // write that can set privilege_level/status/email/access_overrides. The shared service principal
    // drives every agent tool call regardless of which member is chatting, so it does not get that
    // write; it is limited to the same whitelisted profile fields as a member self-edit (but for
    // any member id, so automation can sync those fields). updateOwnProfile rejects governed fields
    // with a clear 4xx and performs no partial write.
    //
    // This used to say the service principal "must NOT imply admin". That is no longer true in
    // effect, and the comment is corrected rather than left to mislead. Password resets are now
    // delivered to `correspondence_email` (see passwordResetRecipient in workflows/identity/auth.ts),
    // which is on that whitelist -- so a holder of the service token can redirect any member's reset
    // link to an address they control and take the account over, admins included.
    //
    // Accepted deliberately: the service token is held as tightly as an admin password, and the
    // alternative -- members without a departmental mailbox being unable to recover their account --
    // was the worse failure. If that judgement changes, the fix is to drop `correspondence_email`
    // from SELF_PROFILE_EDITABLE_FIELDS on this path only; the scripts that sync it write straight
    // to the database and do not come through here.
    if (principal.kind === "member" && principal.member.privilege_level === "admin") {
      const saved = await saveLabMemberAsAdmin(ctx, principal, memberId, body);
      sendJson(res, saved.status, saved.body);
      return;
    }
    if (principal.kind === "service") {
      sendServiceResult(res, service.updateOwnProfile(memberId, body));
      return;
    }
    // Unreachable while this route stays out of ANONYMOUS_ROUTES, but written as an explicit deny
    // so profile writes fail closed rather than depending on a check made elsewhere.
    if (principal.kind === "anonymous") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    if (principal.member.id !== memberId) {
      sendJson(res, 403, { error: { message: "members can only update their own profile" } });
      return;
    }
    sendServiceResult(res, service.updateOwnProfile(memberId, body, profileWriteOrigin(principal)));
  }),
  post(
    "/members/roster-sync",
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
      const syncBody = readRecord(await readJson(req));
      const force = syncBody.force === true;
      if (force && principal.kind === "service") {
        sendJson(res, 403, {
          error: {
            message:
              "force requires an admin session: it overrides the guard that stops a bad sheet read from rewriting the roster",
          },
        });
        return;
      }
      let sheet;
      try {
        sheet = await readRosterSheet(ctx.memberSheet);
      } catch (error) {
        sendJson(res, 502, {
          error: { message: describeMemberSheetReadFailure(error, ctx.memberSheet) },
        });
        return;
      }
      if ("error" in sheet) {
        sendJson(res, sheet.error.status, { error: { message: sheet.error.message } });
        return;
      }
      sendServiceResult(
        res,
        service.syncMemberRoster({
          sheet: sheet.parsed,
          actor: principalActor(principal),
          dryRun: syncBody.dry_run === true,
          force,
        }),
      );
    }),
  ),
  post(
    "/members/nudge-list/seed",
    adminSessionOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const body = readRecord(await readJsonOrEmpty(req));
      sendServiceResult(
        res,
        service.seedNudgeListFromMemberTypes({
          actor: principalActor(principal),
          dryRun: body.dry_run !== false,
        }),
      );
    }),
  ),
  post(
    "/members/notes/migrate",
    adminSessionOnly(({ res, principal, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, service.migrateMemberNotesToFields(principalActor(principal)));
    }),
  ),
  get("/members/mandatory-fields-incomplete", ({ res, ctx }) => {
    const { service } = ctx;
    // Read-only roster scan (same shape as /papers/nudges), so no privilege gate: it powers the
    // dashboard's own-profile warning too, which any signed-in member may load.
    sendServiceResult(res, service.listMembersWithIncompleteMandatoryFields());
  }),
  get(
    "/members/profile-overview",
    privilegedOnly(({ res, url, ctx }) => {
      const { service } = ctx;
      const desk = url.searchParams.get("view") === "desk";
      const page = readAdminListPage(url.searchParams);
      const filter = readProfileOverviewFilter(url.searchParams);
      if (page === "invalid" || filter === "invalid") {
        sendJson(res, 400, { error: { message: "invalid profile overview page" } });
        return;
      }
      const overview = service.listMemberProfileOverview();
      if (!overview.ok) {
        sendServiceResult(res, overview);
        return;
      }
      // The roll-ups are taken over everybody before anything is cut, so the figures at the top of
      // the page and on My Desk are exact however little of the roster travels with them.
      const { members, ...rollUp } = overview.payload;
      if (desk) {
        const heads = deskAdoption(members, ADMIN_LIST_PAGE_SIZE);
        sendJson(res, 200, {
          ...rollUp,
          members: heads.members.map(profileOverviewWireRow),
          desk: heads.counts,
        });
        return;
      }
      // Rows leave out the zeroed counters the client fills in itself; see profileOverviewWireRow.
      const { rows, ...rest } = pageOf(filterOverviewRows(members, filter), page);
      sendJson(res, 200, {
        ...rollUp,
        members: rows.map(profileOverviewWireRow),
        ...rest,
        summary: { remind_count: remindScopeFor(members, filter).memberIds.length },
      });
    }),
  ),
  post(
    "/members/mandatory-fields-reminder/run",
    privilegedOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const reminderBody = readRecord(await readJsonOrEmpty(req));
      const rawInclude = asString(reminderBody.include);
      let include: ProfileReminderInclude | undefined =
        rawInclude === "profile" || rawInclude === "timeline" || rawInclude === "both"
          ? rawInclude
          : undefined;
      let reminderRecipients = Array.isArray(reminderBody.recipient_member_ids)
        ? reminderBody.recipient_member_ids.filter((id): id is string => typeof id === "string")
        : undefined;
      // The Lab Overview no longer holds every row, so it sends the filter it is showing and the
      // people are resolved here, by the same function that counted them for the button.
      if (typeof reminderBody.filter === "string") {
        const filter = readProfileOverviewFilter(new URLSearchParams(reminderBody.filter));
        const overview = service.listMemberProfileOverview();
        if (filter === "invalid" || !overview.ok) {
          if (overview.ok) {
            sendJson(res, 400, { error: { message: "invalid profile overview filter" } });
          } else {
            sendServiceResult(res, overview);
          }
          return;
        }
        const scope = remindScopeFor(overview.payload.members, filter);
        // An empty recipient list means "everyone" to the service, so a filter that matches nobody
        // must stop here rather than turn into the whole roster.
        if (!scope.memberIds.length) {
          sendJson(res, 200, { created: [], skipped: [] });
          return;
        }
        include = scope.include;
        reminderRecipients = scope.memberIds;
      }
      sendServiceResult(
        res,
        await service.sendMandatoryFieldsReminders(principalActor(principal), {
          ...(include ? { include } : {}),
          ...(reminderRecipients?.length ? { recipientIds: reminderRecipients } : {}),
        }),
      );
    }),
  ),
  post(
    "/members/graduations/run",
    privilegedOnly(async ({ res, principal, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, await service.sweepGraduations(principalActor(principal)));
    }),
  ),
  post(
    "/members/thesis-milestones/run",
    privilegedOnly(async ({ res, principal, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, await service.sweepThesisMilestones(principalActor(principal)));
    }),
  ),
  post(
    "/members/city-channels/sync",
    privilegedOnly(async ({ res, principal, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, await service.syncCityChannels(principalActor(principal)));
    }),
  ),
  post(
    "/members/disengagement/run",
    privilegedOnly(async ({ res, principal, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, await service.chaseDisengagedMembers(principalActor(principal)));
    }),
  ),
  post(
    "/members/topic-channels/run",
    privilegedOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const body = readRecord(await readJsonOrEmpty(req));
      const channels = Array.isArray(body.channels)
        ? body.channels.filter((entry): entry is string => typeof entry === "string")
        : [];
      if (channels.length === 0) {
        sendJson(res, 400, { error: { message: "channels must not be empty" } });
        return;
      }
      sendServiceResult(res, await service.syncTopicChannels(principalActor(principal), channels));
    }),
  ),
];

/**
 * The origin stamp for a profile write made through this principal.
 *
 * A member editing their own record is adoption and stamps `member`. The same form submitted by an
 * admin who is viewing as that member is not: nobody has arrived, and counting it would inflate
 * the exact number the Profile Overview exists to keep honest. So it stamps `admin`, with the
 * admin as the actor, and reads identically to that admin editing the row from the members tab.
 */
export function profileWriteOrigin(principal: AdminBotMemberPrincipal): AdminBotWriteOrigin {
  return principal.impersonator
    ? { source: "admin", actor: principal.impersonator.id }
    : { source: "member", actor: principal.member.id };
}

export async function handleMemberRequestRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
  url: URL,
  principal: AdminBotMemberPrincipal,
): Promise<void> {
  const { service } = ctx;
  const isAdmin = principal.member.privilege_level === "admin";
  if (req.method === "GET" && url.pathname === "/lab/members/requests") {
    const status = url.searchParams.get("status");
    const result = service.listMemberRequests({
      memberId: principal.member.id,
      isAdmin,
      ...(adminBotMemberRequestStatuses.includes(status as AdminBotMemberRequestStatus)
        ? { status: status as AdminBotMemberRequestStatus }
        : {}),
    });
    if (!result.ok) {
      sendServiceResult(res, result);
      return;
    }
    // What approving would grant, worked out the same way the save will work it out, so the admin
    // reads "this makes them an admin" on the card rather than finding out afterwards.
    sendJson(res, 200, {
      requests: result.payload.requests.map((request) => ({
        ...request,
        requested_by_name: ctx.store.getLabMember(request.requested_by)?.name,
        access_level:
          privilegeForMemberTypeChange(
            { privilege_level: "external_collaborator" },
            request.profile.member_type,
          )?.privilege_level ?? "external_collaborator",
      })),
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/lab/members/requests") {
    sendServiceResult(
      res,
      service.submitMemberRequest(principal.member.id, readRecord(await readJson(req))),
    );
    return;
  }
  const edit = /^\/lab\/members\/requests\/([^/]+)\/edit$/u.exec(url.pathname);
  if (req.method === "POST" && edit?.[1]) {
    if (!isAdmin) {
      sendJson(res, 403, { error: { message: "only an admin can edit a member request" } });
      return;
    }
    sendServiceResult(
      res,
      service.editMemberRequest(
        decodeURIComponent(edit[1]),
        principal.member.id,
        readRecord(await readJson(req)),
      ),
    );
    return;
  }
  const decision = /^\/lab\/members\/requests\/([^/]+)\/(approve|reject)$/u.exec(url.pathname);
  if (req.method === "POST" && decision?.[1] && decision[2]) {
    if (!isAdmin) {
      sendJson(res, 403, { error: { message: "only an admin can decide a member request" } });
      return;
    }
    const requestId = decodeURIComponent(decision[1]);
    const body = readRecord(await readJson(req));
    if (decision[2] === "reject") {
      const note = typeof body.note === "string" ? body.note : undefined;
      sendServiceResult(res, service.rejectMemberRequest(requestId, principal.member.id, note));
      return;
    }
    const claimed = service.claimMemberRequest(
      requestId,
      principal.member.id,
      typeof body.expected_updated_at === "string" ? body.expected_updated_at : undefined,
    );
    if (!claimed.ok) {
      sendServiceResult(res, claimed);
      return;
    }
    const request = claimed.payload.request;
    // The same id scheme self-signup uses: the requester never picks one, so there is nothing to
    // collide with an existing member's.
    const memberId = `mem_${randomUUID()}`;
    let saved: { status: number; body: unknown };
    try {
      saved = await saveLabMemberAsAdmin(ctx, principal, memberId, {
        ...request.profile,
        ...(request.meetings ? { meetings: request.meetings } : {}),
      });
    } catch (error) {
      service.settleMemberRequestApproval(request, { failed: true });
      throw error;
    }
    if (saved.status >= 400) {
      service.settleMemberRequestApproval(request, { failed: true });
      sendJson(res, saved.status, saved.body);
      return;
    }
    const approved = service.settleMemberRequestApproval(request, { memberId });
    sendJson(res, 200, { request: approved, member: saved.body });
    return;
  }
  const withdraw = /^\/lab\/members\/requests\/([^/]+)$/u.exec(url.pathname);
  if (req.method === "DELETE" && withdraw?.[1]) {
    sendServiceResult(
      res,
      service.withdrawMemberRequest(decodeURIComponent(withdraw[1]), principal.member.id),
    );
    return;
  }
  sendJson(res, 404, { error: { message: "not found" } });
}

/**
 * The admin's write of one roster record: the Add member and Edit member forms, and the approval of
 * a member request, which is the same save made on the requester's behalf. One function so that
 * approving a request can never do less (or more) than an admin typing the record in themselves --
 * Member Type still sets the access level, and the Meetings boxes still reach the calendar.
 */
export async function saveLabMemberAsAdmin(
  ctx: AdminBotRouteContext,
  principal: AdminBotMemberPrincipal,
  memberId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const { service } = ctx;
  const existing = ctx.store.getLabMember(memberId);
  // `meetings` is not a field on the record: it is the Meetings checkboxes, applied to the
  // calendar below, and must not be stored on the member.
  const { meetings: meetingField, ...fields } = body;
  const input = fields as AdminBotLabMemberInput;
  const selectedMeetings = Array.isArray(meetingField)
    ? meetingField.filter((value): value is string => typeof value === "string")
    : undefined;
  // Member Type decides the access level: the form has no separate Privilege field. A change is
  // re-onboarding without the welcome mail -- the rooms, meeting and sheet row are brought into
  // line below, approved by this admin's click. A new record takes its level from the type too.
  const typeChanged =
    typeof input.member_type === "string" &&
    (existing
      ? !sameMemberType(existing.member_type, input.member_type)
      : input.member_type.trim() !== "");
  const implied = typeChanged
    ? privilegeForMemberTypeChange(
        existing ?? { privilege_level: "external_collaborator" },
        input.member_type,
      )
    : undefined;
  const explicitPrivilege =
    input.privilege_level !== undefined && input.privilege_level !== existing?.privilege_level;
  const explicitSubgroup =
    input.collaborator_subgroup !== undefined &&
    input.collaborator_subgroup !== existing?.collaborator_subgroup;
  const nextPrivilege =
    implied && !explicitPrivilege
      ? implied.privilege_level
      : (input.privilege_level ?? existing?.privilege_level);
  // An admin cannot take away their own admin access: done by mistake, nobody is left signed in
  // who can put it back. Another admin can.
  if (
    memberId === principal.member.id &&
    existing?.privilege_level === "admin" &&
    nextPrivilege !== "admin"
  ) {
    return {
      status: 409,
      body: {
        error: {
          message: "You can't remove your own admin access. Ask another admin to change it.",
        },
      },
    };
  }
  const saved = service.upsertLabMember(
    {
      ...input,
      ...(implied && !explicitPrivilege
        ? {
            privilege_level: implied.privilege_level,
            ...(explicitSubgroup || !implied.collaborator_subgroup
              ? {}
              : { collaborator_subgroup: implied.collaborator_subgroup }),
          }
        : {}),
      id: memberId,
      ...(!existing && !input.joined_month
        ? { joined_month: new Date().toISOString().slice(0, 7) }
        : {}),
    },
    // An admin correcting somebody's record is not that member adopting the tool, so this is
    // stamped `admin` and does not count toward their adoption rate. The actor is recorded so
    // "who typed this" has an answer either way -- and comes from principalActor so that an
    // admin doing this while viewing as another admin is still recorded as themselves.
    { source: "admin", actor: principalActor(principal) },
  );
  const approver = approverIdentityFor(principal);
  // A new record is always enrolled, typed or not: the access design's consequences of holding its
  // level are the same whichever door the person came in by (server.member-onboarding.ts).
  if (!saved.ok || !approver || (!(typeChanged || !existing) && !selectedMeetings)) {
    return saved.ok
      ? { status: saved.status, body: saved.payload }
      : { status: saved.status, body: { error: saved.error } };
  }
  const standing = selectedMeetings ? await readStandingMeetings(ctx) : undefined;
  // The Monday meeting has two possible sources in one save: the type, and its checkbox. The
  // checkbox wins only when the admin actually changed it; otherwise the type decides and the
  // unchanged tick must not undo that.
  const groupMeeting =
    standing && !("error" in standing)
      ? standing.meetings.find((meeting) => meeting.kind === "group")
      : undefined;
  const groupMeetingExplicit =
    groupMeeting !== undefined &&
    (selectedMeetings ?? []).includes(groupMeeting.id) !==
      memberAttends(groupMeeting, existing ?? saved.payload);
  const response: Record<string, unknown> = { ...saved.payload };
  if (!existing) {
    response.member_type_change = await enrollNewMember(
      memberOnboardingDeps(ctx, principal, approver),
      saved.payload,
      { skipGroupMeeting: groupMeetingExplicit },
    );
  } else if (typeChanged) {
    response.member_type_change = await applyMemberTypeChange(
      {
        ...memberOnboardingDeps(ctx, principal, approver),
        skipGroupMeeting: groupMeetingExplicit,
      },
      existing,
      saved.payload,
    );
  }
  if (selectedMeetings && standing) {
    response.meeting_changes =
      "error" in standing
        ? [{ step: "meeting", status: "failed", detail: standing.error.message }]
        : await applyMeetingSelection(
            { service, approver },
            saved.payload,
            standing.calendarId,
            standing.meetings.filter((meeting) => meeting.kind !== "group" || groupMeetingExplicit),
            selectedMeetings,
          );
  }
  return { status: 200, body: response };
}
