import type { AdminBotLoadMode } from "./controllers/admin.ts";

/** Pages that use another member's record, including admin-only roster roll-ups. */
export function needsLabRoster(tab: string, mode: AdminBotLoadMode, panel: string | null): boolean {
  return (
    tab === "myWork" ||
    (mode === "admin" &&
      (tab === "adminbotTimeAvailability" ||
        tab === "adminbotMeetings" ||
        tab === "adminbotBadges" ||
        tab === "adminbotCalendar")) ||
    panel === "papers" ||
    panel === "announcements"
  );
}
