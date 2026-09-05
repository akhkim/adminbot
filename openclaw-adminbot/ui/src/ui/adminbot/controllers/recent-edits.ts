// The edit-history panels' side of the wire.
//
// Keyed by object rather than held as one list: a profile panel and three open paper cards are
// four different histories, and one slot of state would have them overwrite each other. Loaded on
// open, so a panel nobody expands costs no request.
import { t } from "../../../i18n/index.ts";
import type { UiSettings } from "../../storage.ts";
import {
  fetchMemberRecentEdits,
  fetchPaperRecentEdits,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  type RecentUpdateRow,
} from "../auth/session.ts";

export type RecentEditsState = {
  updates: RecentUpdateRow[];
  loading: boolean;
  error: string | null;
};

export type AdminBotRecentEditsHost = {
  settings: UiSettings;
  /** Keyed "member:<id>" / "paper:<id>". See the note above on why this is not one list. */
  adminBotRecentEdits: Record<string, RecentEditsState>;
};

export const EMPTY_RECENT_EDITS: RecentEditsState = { updates: [], loading: false, error: null };

export function recentEditsKey(subject: "member" | "paper", id: string): string {
  return `${subject}:${id}`;
}

function failureText(result: { kind: string; message?: string }, baseUrl: string): string {
  if (result.kind === "unreachable") {
    return t("recentEdits.error.unreachable", { url: baseUrl });
  }
  if (result.kind === "forbidden") {
    return t("recentEdits.error.forbidden");
  }
  // A 404 is an old service, not a bad request: the Control UI ships on merge and the service is
  // deployed separately, so this panel can outrun the server that answers it. Saying so is the
  // difference between "nothing has been edited" and "this build has no history to read".
  if (result.kind === "not-found") {
    return t("recentEdits.error.notDeployed");
  }
  return result.message ?? t("recentEdits.error.failed");
}

export async function loadAdminBotRecentEdits(
  host: AdminBotRecentEditsHost,
  subject: "member" | "paper",
  id: string,
): Promise<void> {
  const key = recentEditsKey(subject, id);
  const stored = loadStoredMemberSession();
  const patch = (state: RecentEditsState) => {
    host.adminBotRecentEdits = { ...host.adminBotRecentEdits, [key]: state };
  };
  if (!stored) {
    patch({ updates: [], loading: false, error: t("recentEdits.error.signIn") });
    return;
  }
  const existing = host.adminBotRecentEdits[key];
  // Re-opening a panel that already has its answer does not ask again. The history of a record is
  // not something that changes while somebody is reading it.
  if (existing?.loading || (existing && existing.updates.length > 0 && !existing.error)) {
    return;
  }
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  patch({ updates: [], loading: true, error: null });
  const result =
    subject === "member"
      ? await fetchMemberRecentEdits(id, stored.sessionToken, baseUrl)
      : await fetchPaperRecentEdits(id, stored.sessionToken, baseUrl);
  patch(
    result.ok
      ? { updates: result.value, loading: false, error: null }
      : { updates: [], loading: false, error: failureText(result, baseUrl) },
  );
}
