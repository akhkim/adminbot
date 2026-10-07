import type { ServerResponse } from "node:http";
// Lab calendar events and the scheduled invite passes.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.
import type { AdminBotActionProposal } from "../../contracts/actions.js";
import { AdminBotService, type AdminBotServiceResponse } from "../../kernel/service.js";
import { normalizeCalendarTimezone, toAbsoluteRfc3339 } from "../../workflows/calendar/time.js";
import {
  asString,
  readJson,
  readJsonOrEmpty,
  readRecord,
  sendJson,
  sendServiceResult,
} from "../server.http.js";
import type { AdminBotPrincipal } from "./context.js";
import {
  adminSessionOnly,
  principalActor,
  privilegedOnly,
  requireMemberPrivileged,
} from "./guards.js";
import { get, post, type Route } from "./router.js";

export const calendarRoutes: readonly Route[] = [
  // Both calendar routes are admin-member only. They read the lab's calendar and spend model time,
  // which is not something a plain member session or the shared service principal should be able
  // to do — and neither route writes anything: creating an event or inviting anyone still goes
  // through POST /proposals as a typed calendar.* action, approval, and the gog connector.
  get(
    "/calendar/events",
    adminSessionOnly(async ({ res, url, ctx }) => {
      if (!ctx.readCalendarEvents) {
        sendJson(res, 503, { error: { message: "calendar reading is not configured" } });
        return;
      }
      const max = Number(url.searchParams.get("max") ?? "");
      try {
        const calendarId = url.searchParams.get("calendar_id") ?? ctx.labCalendar.id;
        const from = url.searchParams.get("from") ?? "";
        const to = url.searchParams.get("to") ?? "";
        const query = url.searchParams.get("query") ?? "";
        const events = await ctx.readCalendarEvents({
          ...(calendarId ? { calendarId } : {}),
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(query ? { query } : {}),
          ...(Number.isFinite(max) && max > 0 ? { max: Math.min(max, 250) } : {}),
        });
        // The calendar travels with its events so the tab embeds, lists and writes to the same one.
        sendJson(res, 200, { events, calendar: ctx.labCalendar });
      } catch (error) {
        // The CLI is missing, unauthenticated, or its keyring is locked. Say so rather than
        // returning an empty list, which reads as "your calendar is empty".
        sendJson(res, 502, {
          error: {
            message: `could not read the calendar: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        });
      }
    }),
  ),
  // The three writes. Each one creates the typed action, records the signed-in admin as its
  // approver, and executes it in the same call.
  //
  // This is a deliberate exception to "propose, then approve on the Actions tab", made because the
  // tab is admin-only and the person clicking is the person who would have approved it anyway. The
  // exception is in the *number of clicks*, not in the governance: the proposal, the named
  // approver and the execution all still land in the ledger, so "who put this on the calendar" is
  // answerable afterwards exactly as it is for every other action. A non-admin never reaches here
  // — requireMemberPrivileged refuses plain members and the service principal both.
  post("/calendar/events", async ({ req, res, ctx, principal }) => {
    const { service } = ctx;
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const body = readRecord(await readJson(req));
    const summary = asString(body.summary);
    const timezone = normalizeCalendarTimezone(asString(body.timezone) || ctx.labCalendar.timezone);
    if (!timezone) {
      sendJson(res, 400, {
        error: {
          message: "timezone must be an IANA name such as America/Toronto; use Etc/GMT+12 for AoE",
        },
      });
      return;
    }
    // The draft carries a wall-clock time ("2026-09-01T13:00"), which is not RFC3339 and which
    // Google rejects outright as `400 badRequest`. Resolve it against the calendar's zone first.
    const from = toAbsoluteRfc3339(asString(body.start), timezone);
    const to = toAbsoluteRfc3339(asString(body.end), timezone);
    if (!summary || !from || !to) {
      sendJson(res, 400, {
        error: { message: "summary, and a readable start and end time, are required" },
      });
      return;
    }
    const attendees = readStringList(body.attendees);
    await runCalendarAction(res, service, principal, {
      // With attendees the create has to mail them, which is a different action type and a higher
      // tier; without, it is a hold nobody hears about.
      type: attendees.length ? "calendar.send_invite" : "calendar.create_tentative_hold",
      summary: `Create "${summary}"`,
      payload: {
        calendar_id: asString(body.calendar_id) || ctx.labCalendar.id,
        summary,
        from,
        to,
        timezone,
        ...(asString(body.location) ? { location: asString(body.location) } : {}),
        ...(asString(body.description) ? { description: asString(body.description) } : {}),
        ...(attendees.length ? { attendees } : {}),
      },
      rationale: "Created from the Calendar tab by an admin.",
    });
  }),
  post(/^\/calendar\/events\/([^/]+)$/u, async ({ req, res, ctx, principal, params }) => {
    const { service } = ctx;
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const eventId = decodeURIComponent(params[1]);
    const body = readRecord(await readJson(req));
    const summary = asString(body.summary);
    const timezone = normalizeCalendarTimezone(asString(body.timezone) || ctx.labCalendar.timezone);
    if (!timezone) {
      sendJson(res, 400, {
        error: {
          message: "timezone must be an IANA name such as America/Toronto; use Etc/GMT+12 for AoE",
        },
      });
      return;
    }
    const from = toAbsoluteRfc3339(asString(body.start), timezone);
    const to = toAbsoluteRfc3339(asString(body.end), timezone);
    if (!summary || !from || !to) {
      sendJson(res, 400, {
        error: { message: "summary, and a readable start and end time, are required" },
      });
      return;
    }
    await runCalendarAction(res, service, principal, {
      type: "calendar.reschedule",
      summary: `Update "${summary}"`,
      // No attendees here on purpose: the connector's update path *replaces* the guest list, so an
      // edit that carried one would uninvite everyone the edit did not mention. Inviting is the
      // route below.
      payload: {
        calendar_id: asString(body.calendar_id) || ctx.labCalendar.id,
        event_id: eventId,
        summary,
        from,
        to,
        timezone,
        ...(asString(body.location) ? { location: asString(body.location) } : {}),
        ...(asString(body.description) ? { description: asString(body.description) } : {}),
      },
      rationale: asString(body.rationale) || "Edited from the Calendar tab by an admin.",
    });
  }),
  post(/^\/calendar\/events\/([^/]+)\/invite$/u, async ({ req, res, ctx, principal, params }) => {
    const { service } = ctx;
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const eventId = decodeURIComponent(params[1]);
    const body = readRecord(await readJson(req));
    const attendees = readStringList(body.attendees);
    // An exclusive send: the Calendar tab's filters are the whole guest list, so roster members on
    // the event that the filters exclude come off it in the same call.
    const remove = readStringList(body.remove);
    const remaining = readStringList(body.remaining_attendees);
    if (!attendees.length && !remove.length) {
      sendJson(res, 400, { error: { message: "attendees or remove are required" } });
      return;
    }
    const calendarId = asString(body.calendar_id) || ctx.labCalendar.id;
    const label = asString(body.summary) || eventId;
    const rationale = asString(body.rationale) || "Invited from the Calendar tab by an admin.";

    if (remove.length) {
      // The write behind a removal replaces the guest list rather than subtracting from it (see
      // buildCalendarRemoveAttendeesArgs), so a caller that asks to remove somebody has to name the
      // list it means to leave behind. An empty one is either a caller that forgot or a plan that
      // would clear the event, and both are refused rather than guessed at -- the same reading
      // `planInviteMembership` gives an empty attendee list.
      if (!remaining.length) {
        sendJson(res, 422, {
          error: {
            message:
              "remaining_attendees is required when removing, and must not be empty — refusing to clear the guest list",
          },
        });
        return;
      }
      // Everyone being invited has to survive the replace. Without this an add followed by a
      // removal whose remaining list predates it would uninvite the people just added.
      const missing = attendees.filter(
        (email) =>
          !remaining.some((keep) => keep.trim().toLowerCase() === email.trim().toLowerCase()),
      );
      if (missing.length) {
        sendJson(res, 422, {
          error: {
            message: `remaining_attendees must include everyone being invited; missing ${missing.join(", ")}`,
          },
        });
        return;
      }
    }

    // Add first, then replace. Either order lands the same guest list -- `remaining_attendees`
    // already contains the invitees -- but adding first means a failure between the two leaves the
    // event over-inclusive rather than short of the people who were supposed to be on it.
    if (attendees.length) {
      const added = await executeCalendarAction(service, principal, {
        type: "calendar.add_attendees",
        summary: `Invite ${attendees.length} to ${label}`,
        payload: { calendar_id: calendarId, event_id: eventId, attendees },
        rationale,
      });
      if (!added.ok) {
        sendServiceResult(res, added);
        return;
      }
      if (!remove.length) {
        sendJson(res, 200, added.payload);
        return;
      }
    }

    await runCalendarAction(res, service, principal, {
      type: "calendar.remove_attendees",
      summary: `Remove ${remove.length} from ${label}`,
      payload: {
        calendar_id: calendarId,
        event_id: eventId,
        // Both halves travel: the ledger records who was dropped, and the connector writes the set
        // that remains.
        removed_attendees: remove,
        remaining_attendees: remaining,
      },
      rationale,
      undo_plan: "Re-invite the removed attendees with calendar.add_attendees.",
    });
  }),
  post(
    "/calendar/event-draft",
    adminSessionOnly(async ({ req, res, ctx }) => {
      if (!ctx.draftCalendarEvent) {
        sendJson(res, 503, { error: { message: "event drafting is not configured" } });
        return;
      }
      const body = readRecord(await readJson(req));
      const prompt = asString(body.prompt);
      if (!prompt) {
        sendJson(res, 400, { error: { message: "prompt is required" } });
        return;
      }
      try {
        const requestedTimezone = asString(body.timezone) || ctx.labCalendar.timezone;
        const timezone = normalizeCalendarTimezone(requestedTimezone);
        if (!timezone) {
          sendJson(res, 400, {
            error: {
              message:
                "timezone must be an IANA name such as America/Toronto; use Etc/GMT+12 for AoE",
            },
          });
          return;
        }
        const now = asString(body.now);
        // An `editing` block turns the same route into "apply this instruction to that event". The
        // caller sends what the event currently says; nothing is read back from Google here, so the
        // model can never be handed an event the operator was not looking at.
        const editingRaw = readRecord(body.editing);
        const editingSummary = asString(editingRaw.summary);
        const editingStart = asString(editingRaw.start);
        const editing =
          editingSummary && editingStart
            ? {
                summary: editingSummary,
                start: editingStart,
                ...(asString(editingRaw.end) ? { end: asString(editingRaw.end) } : {}),
                ...(asString(editingRaw.location)
                  ? { location: asString(editingRaw.location) }
                  : {}),
                ...(asString(editingRaw.description)
                  ? { description: asString(editingRaw.description) }
                  : {}),
              }
            : undefined;
        const result = await ctx.draftCalendarEvent({
          prompt,
          ...(timezone ? { timezone } : {}),
          ...(now ? { now } : {}),
          ...(editing ? { editing } : {}),
        });
        if (!result.ok) {
          // A model that could not produce a usable event is a 400 naming what was wrong with the
          // draft, so the operator can rewrite the sentence rather than guess.
          sendJson(res, 400, { error: { message: result.error } });
          return;
        }
        sendJson(res, 200, { draft: result.draft });
      } catch (error) {
        sendJson(res, 502, {
          error: {
            message: `the drafting model failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        });
      }
    }),
  ),
  post(
    "/calendar/themed-meeting-invites/run",
    privilegedOnly(async ({ req, res, ctx, principal }) => {
      const { service } = ctx;
      const body = readRecord(await readJsonOrEmpty(req));
      const meetings = Array.isArray(body.meetings)
        ? body.meetings.flatMap((entry) => {
            const row = readRecord(entry);
            const eventId = asString(row.event_id);
            const summary = asString(row.summary);
            return eventId && summary ? [{ event_id: eventId, summary }] : [];
          })
        : [];
      const channels = Array.isArray(body.channels)
        ? body.channels.flatMap((entry) => {
            const row = readRecord(entry);
            const channel = asString(row.channel);
            const ids = readStringList(row.slack_user_ids);
            return channel ? [{ channel, slack_user_ids: ids }] : [];
          })
        : [];
      if (channels.length === 0) {
        sendJson(res, 400, { error: { message: "channels must be non-empty" } });
        return;
      }
      // `meetings` is now optional: the service host has a calendar client of its own, so a caller
      // that can see Slack but not Google -- which is every cron wrapper -- sends the channels alone
      // and the events are read here. An explicit list still wins, which is what keeps the tests and
      // any existing caller working.
      let resolvedMeetings = meetings;
      if (resolvedMeetings.length === 0) {
        if (!ctx.readCalendarEvents) {
          sendJson(res, 503, { error: { message: "calendar reading is not configured" } });
          return;
        }
        try {
          const events = await ctx.readCalendarEvents({
            calendarId: asString(body.calendar_id) || ctx.labCalendar.id,
            max: 250,
          });
          resolvedMeetings = events.flatMap((event) =>
            event.summary ? [{ event_id: event.id, summary: event.summary }] : [],
          );
        } catch (error) {
          // A failed read must not become "no meetings matched", which is a silent no-op that reads
          // like a clean run. Same reasoning as the invite-membership route above.
          sendJson(res, 502, {
            error: {
              message: `could not read the calendar: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          });
          return;
        }
      }
      sendServiceResult(
        res,
        await service.syncThemedMeetingInvites(principalActor(principal), {
          meetings: resolvedMeetings,
          channels,
          calendarId: asString(body.calendar_id) || ctx.labCalendar.id,
        }),
      );
    }),
  ),
  post(
    "/calendar/local-event-audience/run",
    privilegedOnly(async ({ req, res, ctx, principal }) => {
      const { service } = ctx;
      const body = readRecord(await readJsonOrEmpty(req));
      const eventId = asString(body.event_id);
      if (!eventId) {
        sendJson(res, 400, { error: { message: "event_id is required" } });
        return;
      }
      sendServiceResult(
        res,
        service.sweepLocalEventAudience(
          {
            eventId,
            calendarId: asString(body.calendar_id) || ctx.labCalendar.id,
            city: asString(body.city) || "Zurich",
            zone: asString(body.zone) || "Europe/Zurich",
            attendees: readStringList(body.attendees),
            ...(asString(body.day) ? { day: asString(body.day) } : {}),
          },
          principalActor(principal),
        ),
      );
    }),
  ),
  post(
    "/calendar/research-theme-invites/run",
    privilegedOnly(async ({ req, res, ctx, principal }) => {
      const { service } = ctx;
      const body = readRecord(await readJsonOrEmpty(req));
      const meetings = Array.isArray(body.meetings)
        ? body.meetings.flatMap((entry) => {
            const row = readRecord(entry);
            const eventId = asString(row.event_id);
            const summary = asString(row.summary);
            return eventId && summary
              ? [{ event_id: eventId, summary, attendees: readStringList(row.attendees) }]
              : [];
          })
        : [];
      if (meetings.length === 0) {
        sendJson(res, 400, { error: { message: "meetings must be non-empty" } });
        return;
      }
      sendServiceResult(
        res,
        service.sweepResearchThemeInvites(
          {
            meetings,
            calendarId: asString(body.calendar_id) || ctx.labCalendar.id,
          },
          principalActor(principal),
        ),
      );
    }),
  ),
];

export function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) =>
    typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
  );
}

/**
 * One calendar action, all the way through propose -> approve -> execute, as a result.
 *
 * Returns rather than responds so a route can run more than one and still answer once. The
 * exclusive invite needs exactly that: adding people and removing people are two typed actions
 * with two audit rows, and collapsing them into one would lose which of the two failed.
 */
export async function executeCalendarAction(
  service: AdminBotService,
  principal: Extract<AdminBotPrincipal, { kind: "member" }>,
  action: {
    type: string;
    summary: string;
    payload: Record<string, unknown>;
    rationale: string;
    /** How to reverse it, for the ledger. Worth carrying on anything that takes something away. */
    undo_plan?: string;
  },
): Promise<AdminBotServiceResponse<{ action_id: string; status: string; executed_at?: string }>> {
  const created = service.createProposal({
    type: action.type as AdminBotActionProposal["type"],
    summary: action.summary,
    proposed_payload: action.payload,
    rationale: action.rationale,
    ...(action.undo_plan ? { undo_plan: action.undo_plan } : {}),
  });
  if (!created.ok) {
    return created;
  }
  const approved = service.approve(created.payload.id, {
    payload_hash: created.payload.payload_hash,
    approver_role: "admin",
    approver_id: principal.member.id,
    note: "Admin acted directly from the Calendar tab.",
  });
  if (!approved.ok) {
    return approved;
  }
  const executed = await service.execute(created.payload.id, { dry_run: false });
  if (!executed.ok) {
    return executed;
  }
  return {
    ok: true,
    status: 200,
    payload: {
      action_id: created.payload.id,
      status: executed.payload.status,
      ...(executed.payload.executed_at ? { executed_at: executed.payload.executed_at } : {}),
    },
  };
}

export async function runCalendarAction(
  res: ServerResponse,
  service: AdminBotService,
  principal: Extract<AdminBotPrincipal, { kind: "member" }>,
  action: {
    type: string;
    summary: string;
    payload: Record<string, unknown>;
    rationale: string;
    undo_plan?: string;
  },
): Promise<void> {
  const result = await executeCalendarAction(service, principal, action);
  if (!result.ok) {
    sendServiceResult(res, result);
    return;
  }
  sendJson(res, 200, result.payload);
}
