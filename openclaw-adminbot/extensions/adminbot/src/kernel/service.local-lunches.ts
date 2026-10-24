/** Standing authorization: invite local people to upcoming lunches; never remove anyone. */
import { createHash } from "node:crypto";
import type { AdminBotCalendarEvent, CalendarEventsReader } from "../workflows/calendar/events.js";
import { inviteAddressFor } from "../workflows/members/local-event-audience.js";
import {
  gazetteerPlaces,
  resolvePlace,
  type AdminBotMapPlace,
} from "../workflows/members/member-map.js";
import type { AdminBotService, AdminBotServiceStore } from "./service.js";

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();

function citiesIn(text: string, places: readonly AdminBotMapPlace[]) {
  const direct = resolvePlace(text);
  const haystack = ` ${fold(text)} `;
  const matches = places.filter((p) => haystack.includes(` ${fold(p.label)} `));
  if (matches.length) return matches;
  return direct && places.some((p) => p.key === direct.key) ? [direct] : [];
}

export function lunchCity(
  event: AdminBotCalendarEvent,
  places: readonly AdminBotMapPlace[] = gazetteerPlaces(),
): string | undefined {
  if (!/\blunch(?:es)?\b/iu.test(event.summary) || event.all_day) return undefined;
  const location = event.location ? citiesIn(event.location, places) : [];
  const title = citiesIn(event.summary.split(":")[0], places);
  const cities = new Set([...location, ...title].map((p) => p.key));
  return cities.size === 1 ? [...cities][0] : undefined;
}

export async function inviteLocalLunches(
  service: AdminBotService,
  store: Pick<AdminBotServiceStore, "listLabMembers" | "getLabMember" | "listProposalsByType">,
  calendarId: string,
  read: CalendarEventsReader,
  now = new Date(),
) {
  if (!calendarId.trim()) throw new Error("Lab calendar is not configured");
  if (!store.listLabMembers().length)
    throw new Error("Refusing lunch invites with an empty roster");
  const until = new Date(now.getTime() + 7 * 86_400_000);
  const events = await read({
    calendarId,
    from: now.toISOString(),
    to: until.toISOString(),
    query: "lunch",
    max: 250,
  });
  if (events.length >= 250)
    throw new Error("Lunch calendar result may be truncated; no invitations sent");
  const map = service.memberMap({ loginCity: true });
  if (!map.ok) throw new Error(map.error.message);
  const invited: Array<{ event_id: string; member_id: string; proposal_id: string }> = [];
  const skipped: Array<{ event_id: string; reason: string }> = [];
  const failed: Array<{ event_id: string; member_id: string; reason: string }> = [];
  for (const event of events) {
    const start = Date.parse(event.start);
    if (!Number.isFinite(start) || start < now.getTime() || start >= until.getTime()) continue;
    if (event.calendar_id && event.calendar_id !== calendarId) continue;
    const city = lunchCity(event, [...gazetteerPlaces(), ...map.payload.places]);
    if (!city) {
      skipped.push({ event_id: event.id, reason: "Not a timed lunch with one identifiable city" });
      continue;
    }
    const locals = map.payload.places.find((p) => p.key === city)?.members ?? [];
    const attendees = new Set((event.attendees ?? []).map((email) => email.trim().toLowerCase()));
    for (const local of locals) {
      // A timezone can cover several cities. Automatic invitations require a city placement.
      if (local.precision !== "city") continue;
      const member = store.getLabMember(local.member_id);
      if (!member) continue;
      const email = inviteAddressFor(member);
      if (
        !email ||
        attendees.has(email) ||
        (member.email && attendees.has(member.email.trim().toLowerCase()))
      )
        continue;
      const key = `local-lunch:${createHash("sha256")
        .update(JSON.stringify([calendarId, event.id, email]))
        .digest("hex")}`;
      const previous = store
        .listProposalsByType("calendar.add_attendees")
        .find((p) => p.idempotency_key === key);
      if (previous) {
        if (previous.status !== "executed")
          failed.push({
            event_id: event.id,
            member_id: member.id,
            reason: `Previous invitation ${previous.status}; not replayed automatically`,
          });
        continue;
      }
      const proposed = service.createProposal({
        type: "calendar.add_attendees",
        summary: `Invite ${member.name ?? member.id} to ${event.summary}`,
        target: { service: "google", channel: "calendar", target: event.id },
        proposed_payload: { calendar_id: calendarId, event_id: event.id, attendees: [email] },
        idempotency_key: key,
        rationale:
          "Standing local-lunch policy requested by Ayush on 2026-10-24; location matched using the existing member map.",
        undo_plan: "An administrator may remove this guest from this occurrence.",
      });
      if (!proposed.ok) {
        failed.push({ event_id: event.id, member_id: member.id, reason: proposed.error.message });
        continue;
      }
      const approved = service.approve(proposed.payload.id, {
        payload_hash: proposed.payload.payload_hash,
        approver_role: "admin",
        approver_id: "system:local-lunch-policy",
        note: "Standing authorization: add location-matched members to upcoming lab lunches; no removals.",
      });
      const result = approved.ok
        ? await service.execute(proposed.payload.id, { dry_run: false, idempotency_key: key })
        : approved;
      if (!result.ok || result.payload.status !== "executed") {
        failed.push({
          event_id: event.id,
          member_id: member.id,
          reason: result.ok ? "Invitation not confirmed" : result.error.message,
        });
      } else {
        attendees.add(email);
        invited.push({
          event_id: event.id,
          member_id: member.id,
          proposal_id: proposed.payload.id,
        });
      }
    }
  }
  return { checked: events.length, invited, skipped, failed };
}
