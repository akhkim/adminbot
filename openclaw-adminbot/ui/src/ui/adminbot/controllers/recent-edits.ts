// The Recent Edits tab's side of the wire. One read, no writes: a log is not something you edit.
import { t } from "../../../i18n/index.ts";
import type { UiSettings } from "../../storage.ts";
import {
  fetchRecentUpdates,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  type RecentUpdateRow,
} from "../auth/session.ts";

/** How many rows the feed asks for. Enough to answer "what happened this week" by scrolling. */
export const RECENT_EDITS_LIMIT = 100;

export type AdminBotRecentEditsHost = {
  settings: UiSettings;
  adminBotRecentEdits: RecentUpdateRow[];
  adminBotRecentEditsLoading: boolean;
  adminBotRecentEditsError: string | null;
};

function failureText(result: { kind: string; message?: string }, baseUrl: string): string {
  if (result.kind === "unreachable") {
    return t("recentEdits.error.unreachable", { url: baseUrl });
  }
  if (result.kind === "forbidden") {
    return t("recentEdits.error.forbidden");
  }
  // A 404 is not a bad request here, it is an old service: the Control UI ships on merge and the
  // service is deployed separately, so this page can outrun the server that answers it. Saying so
  // is the difference between "nobody has edited anything" and "this build has no such route".
  if (result.kind === "not-found") {
    return t("recentEdits.error.notDeployed");
  }
  return result.message ?? t("recentEdits.error.failed");
}

export async function loadAdminBotRecentEdits(host: AdminBotRecentEditsHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotRecentEditsError = t("recentEdits.error.signIn");
    return;
  }
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  host.adminBotRecentEditsLoading = true;
  host.adminBotRecentEditsError = null;
  try {
    const result = await fetchRecentUpdates(stored.sessionToken, baseUrl, RECENT_EDITS_LIMIT);
    if (!result.ok) {
      host.adminBotRecentEdits = [];
      host.adminBotRecentEditsError = failureText(result, baseUrl);
      return;
    }
    host.adminBotRecentEdits = result.value;
  } finally {
    host.adminBotRecentEditsLoading = false;
  }
}
