// Camera-ready deadlines onto the lab calendar, cut from service.ts so it stays under its file-size
// ratchet. Nothing here writes to Google: it files `calendar.create_tentative_hold` proposals
// through the service's createProposal, so an admin approves each one before gog executes it.
import type { AdminBotActionProposal, AdminBotPaperRecord } from "../contracts/actions.js";
import { resolveLabCalendar } from "../workflows/calendar/lab-calendar.js";
import {
  cameraReadyCalendarEntries,
  cameraReadyCalendarProposal,
} from "../workflows/papers/camera-ready-deadlines.js";
import type { AdminBotServiceStore } from "./service.js";

type CameraReadyCalendarDeps = {
  store: Pick<AdminBotServiceStore, "listProposalsByType">;
  removePending: (actionId: string, request: { note: string }) => unknown;
  createProposal: (proposal: AdminBotActionProposal) => unknown;
};

/**
 * Propose one lab-calendar entry per venue with an accepted lab paper and a camera-ready ahead.
 *
 * Idempotent: a venue whose current date already has a proposal (pending, approved, executed --
 * or rejected, which is an admin's answer and is not asked again) gets nothing new. When the date
 * moves, the still-pending proposal for the old date is withdrawn and one for the new date is
 * filed. An event already on the calendar for the old date is left for an admin to remove: the
 * hold executor records no event id to cancel it by.
 */
export function reconcileCameraReadyCalendar(
  deps: CameraReadyCalendarDeps,
  papers: readonly AdminBotPaperRecord[],
  readModel: readonly unknown[],
  now: Date,
): { proposed: string[] } {
  const proposed: string[] = [];
  const entries = cameraReadyCalendarEntries(papers, readModel, now);
  if (!entries.length) {
    return { proposed };
  }
  const existing = deps.store
    .listProposalsByType("calendar.create_tentative_hold")
    .filter((proposal) => typeof proposal.target?.camera_ready_venue === "string");
  const calendarId = resolveLabCalendar().id;
  for (const entry of entries) {
    const forVenue = existing.filter(
      (proposal) => proposal.target?.camera_ready_venue === entry.venue_key,
    );
    if (forVenue.some((proposal) => proposal.target?.camera_ready_due === entry.due)) {
      continue;
    }
    for (const stale of forVenue) {
      if (stale.status === "pending") {
        deps.removePending(stale.id, { note: "The camera-ready deadline moved." });
      }
    }
    deps.createProposal(cameraReadyCalendarProposal(entry, calendarId));
    proposed.push(entry.venue_key);
  }
  return { proposed };
}
