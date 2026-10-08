// Meeting records, attendance, and the standing group meeting.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.
import type {
  AdminBotMeetingAttendee,
  AdminBotMeetingRecordInput,
} from "../../contracts/actions.js";
import {
  type GroupMeetingSchedule,
  groupMeetingSeriesId,
  resolveGroupMeetingEventId,
} from "../../contracts/group-meeting.js";
import {
  type AdminBotStandingMeeting,
  standingMeetings,
} from "../../workflows/calendar/standing-meetings.js";
import { groupMeetingInviteEmails } from "../../workflows/meetings/attendance-nudge.js";
import { meetingListRow } from "../../workflows/meetings/meeting-list-row.js";
import {
  asString,
  readJson,
  readJsonOrEmpty,
  readRecord,
  sendJson,
  sendServiceResult,
} from "../server.http.js";
import type { AdminBotRouteContext } from "./context.js";
import {
  adminSessionOnly,
  memberOnly,
  principalActor,
  privilegedOnly,
  requirePrivileged,
} from "./guards.js";
import { del, get, post, put, route, type Route } from "./router.js";

export const meetingsRoutes: readonly Route[] = [
  get("/lab/meetings", async ({ res, ctx, principal }) => {
    // The Lab Members form's Meetings checkboxes. Guest lists name real people's addresses, so
    // this is for an admin session only, like the form that uses it.
    if (principal.kind !== "member" || principal.member.privilege_level !== "admin") {
      sendJson(res, 403, { error: { message: "the meeting list needs an admin session" } });
      return;
    }
    const standing = await readStandingMeetings(ctx);
    if ("error" in standing) {
      sendJson(res, standing.error.status, { error: { message: standing.error.message } });
      return;
    }
    // The form ticks a box per meeting and reads who is on it; how a meeting was classified and
    // which calendar events it was folded from are the calendar sync's business.
    sendJson(res, 200, {
      meetings: standing.meetings.map(({ id, title, attendees }) => ({ id, title, attendees })),
    });
  }),
  get(
    "/meetings",
    memberOnly(({ res, url, principal, ctx }) => {
      const { service } = ctx;
      const isAdmin = principal.member.privilege_level === "admin";
      const limitText = url.searchParams.get("limit");
      if (limitText === null) {
        if (url.searchParams.has("before_started_at") || url.searchParams.has("before_id")) {
          sendJson(res, 400, { error: { message: "invalid meetings page" } });
          return;
        }
        const all = isAdmin
          ? service.listMeetings()
          : service.listMeetingsForMember(principal.member.id);
        sendServiceResult(
          res,
          all.ok
            ? { ...all, payload: { meetings: all.payload.meetings.map(meetingListRow) } }
            : all,
        );
        return;
      }
      const beforeStartedAt = url.searchParams.get("before_started_at");
      const beforeId = url.searchParams.get("before_id");
      const limit = Number(limitText);
      if (
        !/^[1-9]\d*$/u.test(limitText) ||
        limit > 50 ||
        (beforeStartedAt === null) !== (beforeId === null) ||
        (beforeStartedAt !== null &&
          (beforeStartedAt.length > 100 || !beforeId?.trim() || beforeId.length > 512))
      ) {
        sendJson(res, 400, { error: { message: "invalid meetings page" } });
        return;
      }
      const page = {
        limit,
        ...(beforeStartedAt !== null && beforeId !== null
          ? { before: { started_at: beforeStartedAt, id: beforeId } }
          : {}),
      };
      const listed = isAdmin
        ? service.listMeetingsPage(page)
        : service.listMeetingsPageForMember(principal.member.id, page);
      sendServiceResult(
        res,
        listed.ok
          ? {
              ...listed,
              payload: { ...listed.payload, meetings: listed.payload.meetings.map(meetingListRow) },
            }
          : listed,
      );
    }),
  ),
  post(
    "/meetings",
    adminSessionOnly(async ({ req, res, ctx }) => {
      const { service } = ctx;
      const body = (await readJson(req)) as AdminBotMeetingRecordInput;
      sendServiceResult(res, service.upsertMeeting({ ...body, source: body.source ?? "manual" }));
    }),
  ),
  put(
    /^\/meetings\/([^/]+)\/attendance$/u,
    adminSessionOnly(async ({ req, res, principal, ctx, params }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      const attendees = Array.isArray(body.attendees)
        ? (body.attendees as AdminBotMeetingAttendee[])
        : [];
      const saved = service.setMeetingAttendance(
        decodeURIComponent(params[1]),
        attendees,
        principal.kind === "member" ? principal.member.id : "service",
      );
      // The reply replaces the row on the tab, so it has the list's shape.
      sendServiceResult(
        res,
        saved.ok ? { ...saved, payload: meetingListRow(saved.payload) } : saved,
      );
    }),
  ),
  route("*", "/meetings/attendance-nudges", async ({ req, res, ctx, principal }) => {
    const { service } = ctx;
    // Reading who has stopped coming names people, so both verbs are governance surfaces. The GET
    // is the preview an admin reads before the lab hears anything; the POST is what actually sends,
    // and takes requirePrivileged (which the service principal satisfies) rather than
    // requireMemberPrivileged for the same reason the other cron-driven sweeps do: the message is
    // computed entirely from attendance records, so there is no caller-composed text to protect.
    if (req.method !== "GET" && req.method !== "POST") {
      sendJson(res, 405, { error: { message: "method not allowed" } });
      return;
    }
    if (!requirePrivileged(res, principal)) {
      return;
    }
    const inviteEmails = await readGroupMeetingInvite(ctx, service.groupMeetingSchedule());
    if (req.method === "GET") {
      const preview = service.collectMeetingAttendanceNudges({ inviteEmails });
      // Each row's missed meetings are the streak itself -- a row exists only when every one of
      // `meetings` was missed -- so the preview names them once instead of once per person.
      sendServiceResult(
        res,
        preview.ok
          ? {
              ...preview,
              payload: {
                ...preview.payload,
                absent: preview.payload.absent.map(
                  ({ missed_meeting_ids: _ids, missed_topics: _topics, ...row }) => row,
                ),
              },
            }
          : preview,
      );
      return;
    }
    sendServiceResult(
      res,
      await service.sendMeetingAttendanceNudges(principalActor(principal), { inviteEmails }),
    );
  }),
  del(
    /^\/meetings\/([^/]+)$/u,
    adminSessionOnly(({ res, principal, params, ctx }) => {
      const { service } = ctx;
      sendServiceResult(
        res,
        service.deleteMeeting(
          decodeURIComponent(params[1]),
          principal.kind === "member" ? principal.member.id : "service",
        ),
      );
    }),
  ),
  post(
    "/meetings/invite-membership/run",
    privilegedOnly(async ({ req, res, ctx, principal }) => {
      const { service } = ctx;
      const body = readRecord(await readJsonOrEmpty(req));
      const surface = asString(body.surface) === "lab_calendar" ? "lab_calendar" : "group_meeting";
      const meeting = await readGroupMeetingSeries(
        ctx,
        asString(body.calendar_id) || ctx.labCalendar.id,
        asString(body.event_id) || undefined,
      );
      if ("error" in meeting) {
        sendJson(res, meeting.error.status, { error: { message: meeting.error.message } });
        return;
      }
      const { calendarId, seriesId, targets, attendees } = meeting;

      sendServiceResult(
        res,
        service.planInviteMembership({
          surface,
          eventId: seriesId,
          eventIds: targets,
          calendarId,
          attendees,
          actor: principalActor(principal),
        }),
      );
    }),
  ),
];

/**
 * Files a calendar action, records the caller as its approver, and executes it.
 *
 * The approval is recorded against the member id and role of the person who clicked, not against a
 * generic "system" actor — that is what keeps the ledger answerable. Execution is the same path
 * every other action takes, so a missing `gog`, a locked keyring or a Google refusal comes back as
 * the same execution failure it would anywhere else, and the proposal stays in the queue rather
 * than being reported as done.
 */
/**
 * The addresses on the lab's group-meeting invite, or an empty list when the calendar cannot say.
 *
 * Deliberately swallows every failure. The calendar read shells out to gog, which is missing on
 * some boxes, unauthenticated on others and occasionally just slow -- and the attendance nudge has
 * a working audience without it (the roster's own full members). Turning a locked keyring into a
 * 502 would mean nobody is ever reminded to come to the meeting.
 */
export async function readGroupMeetingInvite(
  ctx: AdminBotRouteContext,
  schedule: GroupMeetingSchedule,
): Promise<string[]> {
  if (!ctx.readCalendarEvents) {
    return [];
  }
  try {
    // A fortnight forward: long enough to catch the next occurrence of a weekly series even when
    // one week is cancelled, short enough that a recurring event does not expand into hundreds.
    const from = new Date();
    const to = new Date(from.getTime() + 14 * 86_400_000);
    const events = await ctx.readCalendarEvents({
      calendarId: ctx.labCalendar.id,
      from: from.toISOString(),
      to: to.toISOString(),
      max: 50,
    });
    return groupMeetingInviteEmails(events, schedule);
  } catch {
    return [];
  }
}

// An approval must name a real person, so the shared service principal (which every agent tool
// call authenticates as) cannot supply one.
/**
 * The Monday group meeting as it stands: every live series id and the union of their guests.
 *
 * Shared by the membership sweep and a Lab Members type change, so both write to the same series.
 * A recurring meeting comes back as dated occurrences (`<series>_<instant>`). Every one ahead is
 * kept, not just the first: once somebody edits the meeting "this and following" in Google, the
 * later Mondays belong to a new `<series>_R<instant>` series and the configured id names a series
 * that has already ended. Writing to that id is what used to happen -- it re-sent the dead series
 * to everyone on it and left the live meeting untouched, so the same removals were proposed again
 * the next morning.
 */
export async function readGroupMeetingSeries(
  ctx: AdminBotRouteContext,
  calendarId: string,
  eventId?: string,
): Promise<
  | { calendarId: string; seriesId: string; targets: string[]; attendees: string[] }
  | { error: { status: number; message: string } }
> {
  if (!ctx.readCalendarEvents) {
    return { error: { status: 503, message: "calendar reading is not configured" } };
  }
  const seriesId = groupMeetingSeriesId(eventId || resolveGroupMeetingEventId());
  let events: Awaited<ReturnType<NonNullable<typeof ctx.readCalendarEvents>>>;
  try {
    events = await ctx.readCalendarEvents({ calendarId, max: 250 });
  } catch (error) {
    // Plans are computed from this read. A failed read must not become "the meeting has no
    // attendees", which is a proposal to empty it.
    return {
      error: {
        status: 502,
        message: `could not read the calendar: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }
  const occurrences = events.filter((candidate) => groupMeetingSeriesId(candidate.id) === seriesId);
  if (occurrences.length === 0) {
    return {
      error: {
        status: 404,
        message: `no event ${seriesId} on calendar ${calendarId} in the read window`,
      },
    };
  }
  const targets = [
    ...new Set(occurrences.map((occurrence) => occurrence.recurring_event_id ?? occurrence.id)),
  ];
  // The union, so somebody who is only on a later split still gets reconciled.
  const attendees = [
    ...new Map(
      occurrences
        .flatMap((occurrence) => occurrence.attendees ?? [])
        .map((email) => [email.trim().toLowerCase(), email.trim()] as const),
    ).values(),
  ];
  return { calendarId, seriesId, targets, attendees };
}

/**
 * The lab calendar's standing meetings (Monday, `Theme:`, `Proj:`) with who is on each.
 *
 * What the Lab Members form's Meetings checkboxes offer. A failed read is an error, never an empty
 * list: an empty list would read as "on no meetings" and a save would then remove them from all.
 */
export async function readStandingMeetings(
  ctx: AdminBotRouteContext,
): Promise<
  | { calendarId: string; meetings: AdminBotStandingMeeting[] }
  | { error: { status: number; message: string } }
> {
  if (!ctx.readCalendarEvents) {
    return { error: { status: 503, message: "calendar reading is not configured" } };
  }
  const calendarId = ctx.labCalendar.id;
  try {
    const events = await ctx.readCalendarEvents({ calendarId, max: 250 });
    return { calendarId, meetings: standingMeetings(events, resolveGroupMeetingEventId()) };
  } catch (error) {
    return {
      error: {
        status: 502,
        message: `could not read the calendar: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }
}
