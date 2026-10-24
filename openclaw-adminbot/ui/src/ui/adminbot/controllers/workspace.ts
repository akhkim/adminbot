// Settings, feedback, notifications, and tab usage.
//
// Controller for this zone: loads through api/workspace.ts and writes the result onto the host state.
// Cut from controllers/admin.ts, which keeps the host shape and the shared lab read.

import { updateSettingsAsAdmin } from "../api/workspace.ts";
import {
  type AdminBotHost,
  type AdminBotVenueSource,
  cvErrorText,
  loadAdminBot,
  requirePrivilegedSession,
} from "./admin.ts";

export type AdminBotSettingsSaveInput = {
  paper_escalation_business_days?: number;
  meeting_minimum_minutes?: number;
  cv_recency_window_months?: number;
  head_professor_member_id?: string;
  lab_manager_member_id?: string;
  head_professor_whatsapp?: string;
  applicant_sheet_id?: string;
  applicant_last_reviewed_at?: string;
  venue_sources?: AdminBotVenueSource[];
};

export async function saveAdminBotSettings(
  host: AdminBotHost,
  settings: AdminBotSettingsSaveInput,
): Promise<void> {
  const session = requirePrivilegedSession(host);
  if (!session) {
    return;
  }
  host.adminBotNotice = null;
  const result = await updateSettingsAsAdmin(
    settings as Record<string, unknown>,
    session.sessionToken,
    session.baseUrl,
  );
  if (!result.ok) {
    host.adminBotNotice = {
      kind: "error",
      // The service names what it refused on a 400 (an out-of-range window, say), which beats any
      // fixed copy this side could write.
      text: result.message?.trim() || cvErrorText(result.kind, "save settings"),
    };
    return;
  }
  host.adminBotNotice = { kind: "success", text: "Saved AdminBot settings." };
  await loadAdminBot(host, undefined, undefined, true);
}
